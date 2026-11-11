/**
 * dsh-nai-imagegen — Host half.
 *
 * Two contributions, one connection:
 *
 *   1. `nai_*` tools, so the Agent can search the five 附体 libraries and render
 *      an image on demand. A render lands as a PNG in the configured output
 *      directory and the tool returns that path, which lets the Agent embed it
 *      in its reply with ordinary Markdown — that is how an image ends up in the
 *      conversation body rather than only in a file card.
 *
 *   2. A loopback HTTP API under `/nai-imagegen/api`, so the browser half can
 *      show and edit the same configuration and browse what was rendered.
 *
 * Why the browser half does not call NovelAI itself: it has no CORS-free origin
 * and no business holding the token. The token never leaves this process — the
 * API reports only whether one is in force and where it came from.
 *
 * Deliberately dependency-free apart from the two DSH services it injects.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { LIBRARIES, MAX_ARTIST_EDIT_CHARS, MODE_FIELDS, MODE_NAMES, RATIOS, load, outputDirOf, save, tokenOf } from './lib/config.js'
import { FREE_AREA, costWeight, generate, insideFreeBand, legalAxis, persist, probe, proxyFor, systemProxy } from './lib/nai.js'
import { listLibraries, lookup, rebuildIndex, resolveCharacter } from './lib/library.js'
import { digest, safeJoin } from './lib/util.js'
import { backfillRenders, lookupRenders, lookupRendersFor, rememberRender } from './lib/renders.js'
import { defineTool } from './lib/tool.js'
import { REPLY_TOOL_NAME, createReplyTool, replyLedger } from './lib/reply.js'
import { createPool, fingerprintOf } from './lib/keypool.js'
import { describeQuota, summarizeQuota } from './lib/quota.js'
import {
  MAX_ARTIST_IMAGE_BYTES,
  MAX_ARTIST_NAME_CHARS,
  buildIndex,
  loadIndex,
  loadUserLibrary,
  mergeArtists,
  nextUserId,
  readArtistImage,
  readUserImage,
  removeUserImages,
  saveUserLibrary,
  searchArtists,
  sniffImage,
  userImageDir,
  userLibraryPath,
  writeUserImage
} from './lib/artists.js'
import { looksLikeImageBlock, maybeParseImageBlock, parseImageBlock } from './lib/format.js'
import { looksLikeAnyPage, looksLikeComicPage, maybeParseComicPage, parseComicPage } from './lib/comic.js'
import { RECIPE_GROUPS, describeRecipe, normalizeRecipe, recipeFragments } from './lib/recipe.js'
import { imageLink, linkBase } from './lib/webbase.js'
import { formatDoctor, runDoctor } from './lib/doctor.js'
import { randomUUID } from 'node:crypto'

/** Directory/state name; also this plugin's profile entry id. */
export const ROW_ID = 'nai-imagegen'
/** Absolute path prefix of this plugin's HTTP API. */
const API_PREFIX = '/nai-imagegen/api'
/** Request body ceiling for one config or generate call. */
const MAX_BODY_BYTES = 256 * 1024
/** Newest-first page size ceiling for the gallery. */
const MAX_GALLERY = 120

/**
 * How many artist strings can be starred at once.
 *
 * A cap rather than a judgement: the list lives in the config file, and a loop that
 * stars everything would grow it without bound. Five hundred is past any archive in
 * play and still a file a human can read.
 */
const MAX_ARTIST_FAVORITES = 500

/**
 * How many artist rows one `/artists` request may return.
 *
 * Raised from 200 when the archive passed it: the window's picker has no paging, so a
 * cap below the archive's size is a set of entries the user simply cannot pick.
 */
const MAX_ARTIST_ROWS = 500

/**
 * The origin the panel last reached us on, taken from its `Host` header.
 *
 * Captured rather than assumed: the loopback port is the harness's to choose,
 * and the browser that will fetch an inline image is the very client that just
 * made this request — so its own Host is the most reliable base there is.
 */
let seenHost = ''

/**
 * The reply tool's registration, while it is registered.
 *
 * Held for one reason: the switch has to be able to take the tool back out of the model's tool
 * list, and `ctx.tools.register` hands back exactly the disposer that does it. `null` means the
 * tool is not in the list — which is also what `/status` reports, so the panel never has to
 * guess whether the switch and the thing it switches agree.
 */
let replyDisposer = null

/**
 * Put the reply tool in the model's tool list, or take it out of it.
 *
 * Registration *is* the switch. The tool's description is what orders the model to write its
 * whole reply through the call, so a tool that is not registered orders nothing, and a model
 * that is never told to use the transport simply answers the way it always did.
 *
 * The return of `register` is checked rather than trusted: a host that answers a registration
 * with nothing still leaves the switch working in the direction that matters, and asking for
 * off is never a crash.
 *
 * @param ctx - the plugin context whose `tools` registry is used.
 * @param on - whether the transport should be on.
 * @returns whether it is on, after this call.
 */
function applyReplySetting(ctx, on) {
  if (on === true && replyDisposer === null) {
    const disposer = ctx.tools.register(createReplyTool())
    replyDisposer = typeof disposer === 'function' ? disposer : () => {}
  } else if (on !== true && replyDisposer !== null) {
    replyDisposer()
    replyDisposer = null
  }
  return replyDisposer !== null
}

/** The base an inline image link should use, given the live config. */
function inlineBase(config) {
  return linkBase({ configured: config.webBase, env: process.env, seenHost })
}

/** Required services: the HTTP carrier and the model-facing tool registry. */
export const inject = ['webServer', 'tools']

/** Pure text projection helper shared by every tool below. */
function textRender(fn) {
  return (_args, value) => [{ type: 'text', text: fn(value) }]
}

/**
 * Read the gallery: every PNG in the output directory, newest first.
 * @param outputDir - absolute output directory.
 * @param limit - page size.
 * @returns newest-first file rows.
 */
async function gallery(outputDir, limit) {
  let names = []
  try {
    names = await readdir(outputDir)
  } catch {
    return []
  }
  const rows = []
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.png')) continue
    try {
      const info = await stat(join(outputDir, name))
      rows.push({ name, bytes: info.size, mtime: info.mtimeMs })
    } catch {
      // A file that vanished mid-scan only drops itself.
    }
  }
  rows.sort((a, b) => b.mtime - a.mtime)
  return rows.slice(0, Math.min(MAX_GALLERY, Math.max(1, limit)))
}

/**
 * Read a request body as JSON, bounded.
 * @param req - the node request.
 * @returns the parsed body, or `{}` when the body is empty.
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  const parsed = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object') throw new Error('request body must be a JSON object')
  return parsed
}

/**
 * Read a request body as raw bytes, bounded.
 *
 * The upload path takes the image itself as the body rather than base64 inside
 * JSON: a 2 MB reference image is 2.7 MB of base64, a third of it spent on
 * nothing, and `MAX_BODY_BYTES` exists to keep small JSON bodies small.
 *
 * @param req - the node request.
 * @param limit - byte ceiling.
 * @returns the body bytes.
 */
async function readBinaryBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/**
 * Send one JSON response.
 * @param res - the node response.
 * @param status - HTTP status.
 * @param body - JSON-serializable payload.
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body, null, 2)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text)
  })
  res.end(text)
}

/**
 * How many page reports the host keeps.
 *
 * A ring and not a growing array: this process lives for days, and the page reports on every
 * quiet pass, so an unbounded log would be a slow leak for no extra answer.
 */
const DIAG_LIMIT = 200

/** Reports from the page, oldest first. */
const diagLog = []

/**
 * Whether the output directory has been scanned for renders made before this index existed.
 *
 * One pass per process: the scan reads the head of every PNG, which is cheap but not free, and
 * nothing is gained by repeating it — anything written afterwards is indexed as it renders.
 */
let backfillTried = false

/**
 * Keep one report from the page.
 *
 * The page is the half that decides when to render and there is no debug port into it, so a
 * report of "it did not render" can only be answered from what that half chose to say. The host
 * stamps the arrival time so a line can be placed against the host's own clock as well.
 *
 * @param entry - one JSON object as sent by the page.
 */
function keepDiag(entry) {
  diagLog.push({ receivedAt: Date.now(), ...entry })
  while (diagLog.length > DIAG_LIMIT) diagLog.shift()
}

/**
 * The newest word from the page about an automatic pass, if it said anything.
 *
 * `boot` says the page woke up and `replay` says a transcript was swapped in; neither answers
 * "why is nothing rendering". The two events that carry a verdict are `settle` (the quiet pass,
 * with a per-block tally of what stopped each one) and `window` (a settle window closing, with
 * the marker that shut it, if any), so the walk starts from the end and takes the first of those.
 *
 * The record rides along inside `/status`, which the panel already fetches on every poll and
 * after every mutation, so the answer to the recurring question costs no extra request.
 *
 * @returns the newest `settle` or `window` report, or `null` before the page has made one.
 */
function lastAutoRecord() {
  for (let i = diagLog.length - 1; i >= 0; i -= 1) {
    const entry = diagLog[i]
    if (entry?.event === 'settle' || entry?.event === 'window') return { ...entry }
  }
  return null
}

/**
 * Every module the host imports once at launch.
 *
 * There is no hot reload: the host reads these files when the process starts and
 * never again. An edit made afterwards is simply not running, which is invisible
 * from inside the app — the panel saves, the config changes, and the render behaves
 * exactly as it did before. Comparing the files against the process start time lets
 * the UI say so instead of leaving that to be guessed.
 */
const MODULE_FILES = [
  'index.js',
  'client.js',
  'lib/config.js',
  'lib/comic.js',
  'lib/doctor.js',
  'lib/format.js',
  'lib/keypool.js',
  'lib/artists.js',
  'lib/library.js',
  'lib/net.js',
  'lib/nai.js',
  'lib/recipe.js',
  'lib/tool.js',
  'lib/util.js',
  'lib/webbase.js'
]

/**
 * Which loaded modules changed on disk since this process started.
 *
 * Staleness is not an error, so this is reported rather than asserted: a stale
 * process still runs, it just runs the older code.
 *
 * @returns `{ needed, files, startedAt }`.
 */
async function staleCode() {
  const startedAt = Date.now() - Math.round(process.uptime() * 1000)
  const files = []
  for (const relative of MODULE_FILES) {
    try {
      const info = await stat(new URL(`./${relative}`, import.meta.url))
      if (info.mtimeMs > startedAt) files.push(relative)
    } catch {
      // A module that cannot be read is not evidence of staleness.
    }
  }
  return { needed: files.length > 0, files, startedAt }
}

/**
 * Describe the live configuration for both the model and the panel. The token
 * itself is never returned — only whether one is in force and where from.
 * @returns the status payload.
 */
async function statusPayload() {
  const config = await load()
  const token = await tokenOf(config)
  const outputDir = await outputDirOf(config)
  const images = await gallery(outputDir, MAX_GALLERY)
  const libraries = await listLibraries(config.libraryDir)
  const activePool = poolFor(config)
  const artists = await artistEntries(config)
  // Resolved once: the same question is asked three times below, and a status
  // payload that answers it differently in two places is worse than no answer.
  const currentArtist = artistViewOf(entryById(artists.entries, config.artistId), artistEditOf(config, Number(config.artistId)))
  // Resolved once as well: the list and the count below have to agree, and a status
  // payload that answers the same question two ways is worse than no answer.
  const favorites = favoriteSetOf(config, artists.entries)
  // The key views and the quota summary are computed from one pass, so the panel
  // cannot end up totalling a list it is not also showing.
  const quotaKeys = activePool.list().map(quotaViewOf)
  return {
    rowId: ROW_ID,
    baseUrl: config.baseUrl,
    model: config.model,
    width: config.width,
    height: config.height,
    steps: config.steps,
    scale: config.scale,
    sampler: config.sampler,
    ucPreset: config.ucPreset,
    // The effective proxy, so the panel can show what will actually be used
    // rather than just what was configured.
    proxy: proxyFor(config),
    proxySetting: config.proxy,
    detectedProxy: systemProxy(),
    outputDir,
    /**
     * Where an inline image link points.
     *
     * Empty means no base could be worked out, in which case the host half hands
     * out plain paths — exactly as it did before this existed.
     */
    webBase: inlineBase(config),
    libraryDir: config.libraryDir,
    librarySourceDir: config.librarySourceDir,
    artistIndex: config.artistIndex,
    artistSource: config.artistSource || artists?.sourceFile || '',
    // Archive entries plus the ones made here, so "how many do I have" counts what
    // the grid actually shows.
    artistCount: artists.entries.length,
    artistId: Number(config.artistId),
    artistName: entryById(artists.entries, config.artistId)?.name ?? null,
    /**
     * Whether the panel's current pick carries an edit, and how long its text is.
     *
     * Sent so the panel and the window can say "已改" without fetching the text of
     * every entry: the badge is a property of the entry, the text is fetched only
     * for the one being read or edited.
     */
    artistEdited: currentArtist?.edited === true,
    artistChars: currentArtist?.chars ?? 0,
    /**
     * The starred ids, ascending.
     *
     * A list rather than a flag per entry, because the order is the point: the grid and
     * the window both hoist these to the front of whatever they are listing, including
     * a searched subset. Resolvable ids only — see `favoriteSetOf`.
     */
    artistFavorites: [...favorites].sort((a, b) => a - b),
    artistFavoriteCount: favorites.size,
    // Key state travels as labels and fingerprints only; tokens stay in the host.
    keys: quotaKeys,
    keySummary: activePool.healthSummary(),
    /**
     * Membership and V5 free-quota aggregate.
     *
     * Percentages are never added across keys — several keys are not necessarily
     * several accounts — and only known image counts are summed, so "unknown" is
     * `null` rather than a confident zero.
     */
    quota: summarizeQuota(quotaKeys),
    autoGenerate: config.autoGenerate === true,
    /**
     * Whether the reply tool is in the model's tool list right now.
     *
     * Reported from the registration itself rather than from the stored field, because the two
     * can disagree for a moment — a `save` that has landed in the file but whose switch has not
     * been applied yet — and the panel's button should read the state the model will actually
     * see, not the state somebody asked for.
     */
    replyTransport: replyDisposer !== null,
    /**
     * What the page last said about an automatic pass.
     *
     * Whether an automatic render happens is decided in the browser and cannot be read from out
     * here, so the only honest answer to "it rendered nothing again" is the page's own last
     * report. The panel prints it under the toggle; without it the question costs a chat
     * round-trip through the diag log to learn what the page already knew.
     */
    lastAuto: lastAutoRecord(),
    mode: config.mode,
    /** How the browser half should draw a generated image, and where to point it. */
    display: {
      width: config.displayWidth,
      /**
       * Pinned to zero, not forwarded from the config.
       *
       * The display setting is one overall scale and the height follows the image's own
       * ratio. The config field survives because `normalize` has to round-trip it without
       * corrupting its type, but nothing honours it: a cap that only a hand-edited
       * config.json could set is exactly the hidden second knob that later reads as
       * "why is this page cropped".
       */
      maxHeight: 0,
      clickZoom: config.displayClickZoom !== false,
      /** The path fragment the injected stylesheet matches on. */
      match: '_out/nai/'
    },
    /**
     * The size presets, so the window and the host share one table — a ratio cannot
     * mean two different sizes on the two sides if there is only one table.
     */
    ratios: RATIOS.map((row) => ({ ...row })),
    /**
     * Whether the files on disk are newer than this process.
     *
     * Surfaced prominently, because "I changed a setting and nothing happened" has
     * this exact cause whenever the change was to code rather than to a value.
     */
    restart: await staleCode(),
    /** The override field names, so the floating window and the host share one list. */
    modeFields: Object.keys(MODE_FIELDS),
    /**
     * What each mode actually renders with once the overrides are resolved.
     *
     * The floating window shows these rather than the raw overrides, because the
     * question being answered is "what will this mode do", not "what did I type".
     */
    modeSettings: MODE_NAMES.map((name) => {
      const effective = settingsFor(config, name)
      const style = entryById(artists.entries, effective.artistId)
      return {
        mode: name,
        overrides: (config.modes ?? {})[name] ?? {},
        artistId: Number(effective.artistId),
        artistName: style?.name ?? null,
        // The edit state travels with each mode, or the window would show the
        // label of one mode while painting another mode's artist string.
        artistEdited: artistViewOf(style, artistEditOf(config, Number(effective.artistId)))?.edited === true,
        artistChars: artistViewOf(style, artistEditOf(config, Number(effective.artistId)))?.chars ?? 0,
        width: effective.width,
        height: effective.height,
        steps: effective.steps,
        model: effective.model,
        sampler: effective.sampler,
        scale: effective.scale,
        ucPreset: effective.ucPreset,
        negativePrompt: effective.negativePrompt,
        // The comic recipe, resolved: the option labels it picked and the page count
        // the writer should aim for. Sent so the floating window shows the state in
        // force rather than only what was stored.
        recipe: normalizeRecipe(effective.recipe),
        recipeText: describeRecipe(effective.recipe),
        recipePages: effective.mode === 'comic' ? recipeFragments(effective.recipe).pages : 0,
        /** The option table itself, so the window and the host share one list. */
        recipeGroups: RECIPE_GROUPS,
        maxImagesPerCall: effective.maxImagesPerCall
      }
    }),
    maxImagesPerCall: config.maxImagesPerCall,
    keepImages: config.keepImages,
    tokenSet: token.length > 0,
    tokenSource: (process.env.NAI_TOKEN || '').trim() ? 'env' : token ? 'file' : 'none',
    negativePrompt: config.negativePrompt,
    imageCount: images.length,
    // What this process was handed by the reply tool: how many, how big, when, and the digest.
    // Never the prose — see `lib/reply.js` for why that is the shape and not an oversight.
    reply: replyLedger(),
    libraries: libraries.length > 0 ? libraries : LIBRARIES.map((library) => ({ library, entries: 0 })),
    newest: images.slice(0, 12)
  }
}

/**
 * Probe NovelAI, preferring the key pool.
 *
 * The pool is the source of truth for credentials. Reading the single `tokenOf`
 * value instead would report "not configured" the moment the legacy `token`
 * field is folded into the managed key list — which happens on the first add or
 * remove from the panel — even with four healthy keys sitting in the pool.
 *
 * @param options - an optional abort signal.
 * @returns the probe outcome, plus a pool summary.
 */
async function probeNow(options = {}) {
  const config = await load()
  const activePool = poolFor(config)
  const pool = activePool.healthSummary()
  if (activePool.configured()) {
    try {
      const result = await activePool.enqueue({ kind: 'probe' }, { noRetry: true })
      return { ...result, pool }
    } catch (error) {
      return { ok: false, stage: 'reachable', detail: error.message, status: Number(error.statusCode) || 0, hint: '', pool }
    }
  }
  const token = await tokenOf(config)
  const result = await probe({ baseUrl: config.baseUrl, token, proxy: proxyFor(config), signal: options.signal })
  return { ...result, pool }
}

/**
 * Attach the quota reading to one key's public view.
 *
 * A key with no successful read yet is `unqueried`; a key whose last read failed
 * is `error` **while keeping the subscription it last reported**, because a
 * failed query and an empty balance are different statements and the panel says
 * so with a stale mark rather than a blank.
 *
 * @param key - the public key projection.
 * @returns the key plus `v5Quota`.
 */
function quotaViewOf(key) {
  if (key.quotaError !== null && key.quotaError !== undefined) {
    return {
      ...key,
      v5Quota: {
        status: 'error',
        code: String(key.quotaError.code ?? 'NETWORK_ERROR'),
        refreshedAt: Number(key.quotaError.at) || 0
      }
    }
  }
  if (key.subscription !== null && key.subscription !== undefined) {
    return { ...key, v5Quota: key.subscription.v5Quota }
  }
  return { ...key, v5Quota: { status: 'unqueried' } }
}

/** Delay before the one allowed retry, and the budget the pair shares. */
const QUOTA_RETRY_MS = 250
const QUOTA_BUDGET_MS = 30000

/** Wait, but wake up immediately when the caller aborts. */
function pause(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof signal?.addEventListener !== 'function') return
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true }
    )
  })
}

/**
 * Read one key's subscription record, with the single retry the spec allows.
 *
 * Only *transient* answers are retried. A 401 is an answer about the credential:
 * repeating it would double the latency of a certain failure. The retry waits
 * 250ms and the pair shares a 30-second budget, so a broken network costs one
 * extra request rather than a hang. Note that this policy belongs to this GET —
 * a render is a POST that may already have spent Anlas, and is never re-sent.
 *
 * @param config - the loaded configuration.
 * @param key - the account to ask.
 * @param proxy - the effective proxy.
 * @param signal - an optional abort signal.
 * @returns the probe outcome.
 */
async function readSubscription(config, key, proxy, signal) {
  const startedAt = Date.now()
  let outcome = await probe({ baseUrl: config.baseUrl, token: key.token, proxy, signal })
  const transient = outcome.ok !== true && (outcome.stage === 'network' || outcome.stage === 'upstream')
  if (transient && Date.now() - startedAt < QUOTA_BUDGET_MS) {
    await pause(QUOTA_RETRY_MS, signal)
    outcome = await probe({ baseUrl: config.baseUrl, token: key.token, proxy, signal })
  }
  return outcome
}

/**
 * Refresh the membership and quota reading for every enabled key.
 *
 * Deliberately **not** the pool's `{ kind: 'probe' }` job. A verify may disable
 * a key that answers 401 and marks one healthy on success; a read-only quota
 * refresh may not change render eligibility at all. A quota read that fails is
 * recorded as a quota failure and nothing else, so a flaky network can never
 * take a working key out of the pool. Disabled keys are not queried.
 *
 * @param options - an optional abort signal.
 * @returns the per-key views and the aggregate summary.
 */
async function refreshQuota(options = {}) {
  const config = await load()
  const activePool = poolFor(config)
  const proxy = proxyFor(config)
  // The pool knows every key — including the configured single token, which is
  // not in `config.keys` — and it is exactly the set the renderer would use.
  const targets = activePool.readTargets()
  await Promise.all(
    targets.map(async (key) => {
      try {
        const outcome = await readSubscription(config, key, proxy, options.signal)
        if (outcome.subscription !== null && outcome.subscription !== undefined) {
          activePool.noteSubscription(key.id, outcome.subscription)
          return
        }
        activePool.noteQuotaFailure(
          key.id,
          outcome.ok === true ? 'INVALID_RESPONSE' : outcome.status ? `HTTP_${outcome.status}` : 'NETWORK_ERROR'
        )
      } catch (error) {
        // `probe` reports rather than throws, so this is the belt to its braces:
        // whatever happens, a quota read must not surface as a key failure.
        activePool.noteQuotaFailure(key.id, Number(error?.statusCode) ? `HTTP_${error.statusCode}` : 'NETWORK_ERROR')
      }
    })
  )
  const keys = activePool.list().map(quotaViewOf)
  return { keys, ...summarizeQuota(keys) }
}

/**
 * The shared key pool, rebuilt only when the configured key set changes so that
 * cooldown and failure state survives across calls instead of resetting.
 */
let pool = null
let poolSignature = ''

/**
 * Get the key pool for a configuration.
 *
 * `NAI_TOKEN`, when set, takes over the primary slot (matching the documented
 * precedence) while the configured extra keys stay in play. The pool is rebuilt
 * whenever the key set changes, and only then.
 *
 * @param config - the loaded configuration.
 * @returns the pool.
 */
function poolFor(config) {
  const envToken = (process.env.NAI_TOKEN ?? '').trim()
  const primary = envToken !== '' ? envToken : String(config.token ?? '')
  const signature = [primary, ...(config.keys ?? []).map((entry) => `${entry.label}:${entry.token}:${entry.enabled}`)].join('|')
  if (pool === null || signature !== poolSignature) {
    pool = createPool({ token: primary, keys: config.keys ?? [] }, { call: renderOne })
    poolSignature = signature
  }
  return pool
}

/**
 * Rewrite the managed key list, folding the legacy single `token` in on the way.
 *
 * The panel addresses keys by id, and a bare `token` field has no id, so the
 * first key-management write migrates it into the list and clears the field.
 * After that every key is uniform, and `NAI_TOKEN` still overrides the primary
 * slot at pool-build time.
 *
 * @param mutate - receives a mutable copy of the key list and returns the new one.
 * @returns the stored list.
 */
async function persistKeys(mutate) {
  const config = await load()
  // The ids the panel already saw, indexed by token fingerprint. Without this a
  // config written before ids existed would get fresh ones on the first write,
  // and every click the user made against the old ids would miss.
  const known = new Map(poolFor(config).list().map((key) => [key.fingerprint, key.id]))
  const keys = (Array.isArray(config.keys) ? config.keys : []).map((key) => ({ ...key }))
  const legacy = String(config.token ?? '').trim()
  if (legacy !== '' && !keys.some((key) => fingerprintOf(key.token) === fingerprintOf(legacy))) {
    keys.unshift({ label: '主 Key（原单一 token）', token: legacy, enabled: true })
  }
  for (const key of keys) {
    if (typeof key.id === 'string' && key.id !== '') continue
    key.id = known.get(fingerprintOf(key.token)) ?? randomUUID()
  }
  const next = mutate(keys)
  await save({ keys: next, token: '' })
  return next
}

/**
 * Render exactly one image with one key — the pool's unit of work.
 *
 * Also serves key verification: a `{ kind: 'probe' }` payload reads the
 * subscription record instead of rendering, and throws with a status code so the
 * pool applies the same classification it uses for renders.
 *
 * @param payload - the request parameters, without a token.
 * @param token - the key the pool chose.
 * @param signal - the pool's abort signal.
 * @returns the first image buffer, or the probe outcome.
 */
async function renderOne(payload, token, signal) {
  const config = await load()
  const proxy = proxyFor(config)
  if (payload.kind === 'probe') {
    const result = await probe({ baseUrl: config.baseUrl, token, proxy, signal })
    if (!result.ok && result.stage !== 'reachable') {
      throw Object.assign(new Error(result.detail), { statusCode: result.status ?? 0 })
    }
    return result
  }
  const images = await generate({
    baseUrl: config.baseUrl,
    token,
    proxy,
    signal,
    ...payload
  })
  return images[0]
}

/**
 * The settings in force for one mode.
 *
 * A mode's override wins where it has one; everything else comes from the shared
 * defaults, so only the differences have to be stated. `??` rather than `||` on
 * purpose: a saved empty string is a real choice (an illustration with no default
 * negative is legitimate) and must not be read as "unset".
 *
 * @param config - the loaded configuration.
 * @param mode - `illustration` or `comic`.
 * @returns the effective settings.
 */
function settingsFor(config, mode) {
  const overrides = (config.modes ?? {})[mode] ?? {}
  const pick = (field) => (overrides[field] === undefined || overrides[field] === null ? config[field] : overrides[field])
  return {
    mode,
    artistId: overrides.artistId === undefined || overrides.artistId === null ? config.artistId : overrides.artistId,
    width: pick('width'),
    height: pick('height'),
    steps: pick('steps'),
    scale: pick('scale'),
    ucPreset: pick('ucPreset'),
    model: pick('model'),
    sampler: pick('sampler'),
    negativePrompt: pick('negativePrompt'),
    maxImagesPerCall: overrides.maxImagesPerCall === undefined || overrides.maxImagesPerCall === null ? config.maxImagesPerCall : overrides.maxImagesPerCall,
    recipe: overrides.recipe ?? null
  }
}

/**
 * The archive index, the user's own entries, and the merged list, in one read.
 *
 * Every place that answers "which artist strings exist" goes through here, so the
 * panel, the floating window, the tools and the render path cannot disagree about
 * whether a hand-made entry exists — the failure mode being a style that renders
 * but can be neither seen nor picked.
 *
 * @param config - the loaded configuration.
 * @returns `{ index, library, entries, sourceFile }`.
 */
async function artistEntries(config) {
  const index = await loadIndex(config.artistIndex)
  const library = await loadUserLibrary(userLibraryPath(config.artistIndex))
  return {
    index,
    library,
    entries: mergeArtists(index, library),
    sourceFile: config.artistSource || index?.sourceFile || ''
  }
}

/**
 * One entry by id.
 *
 * By id, never by array position: user entries carry ids from 1000 up, so
 * `entries[id]` would return `undefined` for them — and, far worse, would return
 * some *other* archive entry for the ids that are in range.
 *
 * @param entries - the merged entry list.
 * @param id - the wanted id.
 * @returns the entry, or `undefined`.
 */
function entryById(entries, id) {
  const wanted = Number(id)
  return entries.find((entry) => entry.id === wanted)
}

/**
 * The bytes and mime type of one entry's reference image.
 *
 * An uploaded image wins over the archive's own, which is what makes "replace
 * this reference image" possible without writing to a file this plugin only reads.
 *
 * @param options - the loaded config, the archive source file and the entry.
 * @returns `{ bytes, mime }`, or `null`.
 */
async function readEntryImage({ config, sourceFile, entry }) {
  if (entry === null || entry === undefined || entry.image === null || entry.image === undefined) return null
  const mime = entry.image.mime ?? 'image/png'
  if (entry.imageSource === 'upload' && typeof entry.image.file === 'string') {
    const bytes = await readUserImage({ dir: userImageDir(config.artistIndex), file: entry.image.file })
    return bytes === null ? null : { bytes, mime }
  }
  if (sourceFile === '') return null
  const bytes = await readArtistImage({ sourceFile, image: entry.image })
  return bytes === null ? null : { bytes, mime }
}

/**
 * The config patch that forgets one artist id everywhere it is remembered.
 *
 * Deleting an entry that the selection still points at would leave the panel and
 * the window naming a style that no longer exists, and the next render would drop
 * the prefix silently. So the id is erased from the panel's pick, from every
 * mode's pick, from the edits table — and its star goes with it, because this is the
 * one path where an id is gone for good.
 *
 * @param config - the loaded configuration.
 * @param id - the id being removed.
 * @returns the patch, ready for `save`.
 */
function forgetArtist(config, id) {
  const wanted = Number(id)
  const patch = {}
  const edits = { ...(config.artistEdits ?? {}) }
  delete edits[String(wanted)]
  patch.artistEdits = edits
  // A star is an id and nothing else, so a deleted entry would leave one pointing at
  // nothing. The only ids that reach here are hand-made ones, which never come back.
  const starred = storedFavoriteIds(config)
  if (starred.delete(wanted)) patch.artistFavorites = [...starred].sort((a, b) => a - b)
  const modes = { ...(config.modes ?? {}) }
  let touched = false
  for (const name of Object.keys(modes)) {
    const row = modes[name]
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
    if (Number(row.artistId) !== wanted) continue
    modes[name] = { ...row, artistId: -1 }
    touched = true
  }
  if (touched) patch.modes = modes
  if (Number(config.artistId) === wanted) patch.artistId = -1
  return patch
}

/**
 * The stored edit for one archive id, if any.
 *
 * @param config - the loaded configuration.
 * @param id - the archive id.
 * @returns `{ positive?, negative? }`, or `null` when the entry is untouched.
 */
function artistEditOf(config, id) {
  const edits = config?.artistEdits
  if (edits === null || typeof edits !== 'object') return null
  const row = edits[String(Number(id))]
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return null
  return row
}

/**
 * Every id the configuration remembers as starred, resolvable or not.
 *
 * The raw list, for the two places that *write* it: a star has to survive an archive
 * that is not loaded yet, so rewriting the list must carry the ids this load cannot
 * resolve rather than quietly dropping them.
 *
 * @param config - the loaded configuration.
 * @returns a Set of numeric ids.
 */
function storedFavoriteIds(config) {
  const ids = new Set()
  for (const raw of config?.artistFavorites ?? []) {
    const id = Number(raw)
    if (Number.isInteger(id) && id >= 0) ids.add(id)
  }
  return ids
}

/**
 * The starred ids this archive can actually offer.
 *
 * The subset every reader gets: a ★ the grid or the window draws has to be an entry
 * that can be picked, so the flag is answered against the entries in play rather than
 * against the stored list. No entry, no star — while the stored list keeps it for the
 * next import.
 *
 * @param config - the loaded configuration.
 * @param entries - the artist entries in play.
 * @returns a Set of numeric ids.
 */
function favoriteSetOf(config, entries) {
  const known = new Set((entries ?? []).map((entry) => Number(entry.id)))
  const out = new Set()
  for (const id of storedFavoriteIds(config)) if (known.has(id)) out.add(id)
  return out
}

/**
 * One archive entry as it should be **read**: the archive text with the stored
 * edit on top of it.
 *
 * This is the single place that decides what an artist string says. The render
 * path, the panel's editor, the grid's badge and the floating window's readout all
 * come through here — which is what stops the three from disagreeing about a
 * string the user has changed, the failure mode being an edit that appears in the
 * editor and never in the picture.
 *
 * @param entry - the archive entry, or null.
 * @param edit - the stored edit for that entry, or null.
 * @returns `{ id, name, positive, negative, chars, original, edited }`, or null.
 */
function artistViewOf(entry, edit) {
  if (entry === null || entry === undefined) return null
  const original = {
    positive: typeof entry.positivePrompt === 'string' ? entry.positivePrompt : '',
    negative: typeof entry.negativePrompt === 'string' ? entry.negativePrompt : ''
  }
  const side = (name) => {
    const text = edit === null || edit === undefined ? undefined : edit[name]
    return typeof text === 'string' ? text : original[name]
  }
  const positive = side('positive')
  const negative = side('negative')
  return {
    id: Number(entry.id),
    name: typeof entry.name === 'string' ? entry.name : null,
    positive,
    negative,
    chars: positive.length,
    original,
    /**
     * Whether the text in force differs from the archive.
     *
     * Compared rather than flagged by "an edit exists": typing the archive text
     * back in verbatim is not an edit, and a "已改" badge on something identical to
     * the archive is a lie the user cannot clear.
     */
    edited: positive !== original.positive || negative !== original.negative,
    /** Whether this entry was made here, which is also whether it can be deleted. */
    custom: entry.custom === true,
    /** Whether the reference image is an upload rather than the archive's own. */
    uploaded: entry.imageSource === 'upload',
    /** Whether there is a reference image at all. */
    image: entry.image !== null && entry.image !== undefined
  }
}

/**
 * The artist string in force, if any, with the stored edit applied.
 *
 * Archive entry or hand-made entry: the render path does not care which, because
 * a style the user made is a style like any other once it has an id.
 *
 * @param config - the loaded configuration.
 * @returns the effective entry, or `null`.
 */
async function selectedArtist(config) {
  const id = Number(config.artistId)
  if (!Number.isInteger(id) || id < 0) return null
  const { entries } = await artistEntries(config)
  const entry = entryById(entries, id)
  if (entry === undefined) return null
  const view = artistViewOf(entry, artistEditOf(config, id))
  return {
    ...entry,
    positivePrompt: view.positive,
    negativePrompt: view.negative,
    /** Kept so a report can say what the archive said, not only what is in force. */
    originalPositivePrompt: view.original.positive,
    originalNegativePrompt: view.original.negative,
    edited: view.edited,
    custom: view.custom,
    uploaded: view.uploaded
  }
}

/**
 * Run one render end to end against the live configuration.
 *
 * Several images are dispatched as **several single-image jobs** rather than one
 * job asking for `n_samples`: that is what lets the pool put them on different
 * keys at the same time, so four keys render four images concurrently instead of
 * one key rendering four in sequence.
 *
 * The selected artist string is prepended to the prompt and merged into the
 * negative, which is the whole point of keeping a style archive: pick a look
 * once, and every render carries it.
 *
 * @param options - prompt and optional per-call overrides.
 * @returns the written file records, the request and the pool's breadth.
 */
async function renderNow(options) {
  const config = await load()
  const outputDir = await outputDirOf(config)

  const submitted = String(options.prompt ?? '').trim()
  if (!submitted) throw new Error('prompt is empty')

  // A prompt may arrive as a structured page — see lib/format.js and lib/comic.js.
  // Parsing here rather than in each caller means the tool, the panel and the
  // transcript button all handle both formats identically, and a plain prompt is
  // untouched. The comic page is tried first because it carries an explicit
  // `format` marker, so recognising one never costs the 插画 path anything; the
  // mode setting can forbid it or force it.
  const mode = String(options.mode ?? config.mode ?? 'auto').toLowerCase()
  // The page is parsed first, because which format it turns out to be is what
  // decides which mode's settings apply.
  const sizeHint = { width: config.width, height: config.height }
  const comic = mode === 'illustration' ? null : maybeParseComicPage(submitted, sizeHint)
  const illustration = comic === null ? maybeParseImageBlock(submitted, sizeHint) : null
  const page = comic ?? illustration
  // `auto` gives each mode its own artist string, shape and negative without the
  // user having to switch anything: the input chooses.
  const effectiveMode = comic !== null ? 'comic' : 'illustration'
  const settings = settingsFor(config, effectiveMode)
  if (page === null && looksLikeAnyPage(submitted)) {
    // The text announces a page format but could not be read. Falling through
    // would send the JSON, the labels, the size header and the model's own
    // reasoning to NovelAI as literal prompt text — which renders as noise and
    // looks exactly like the plugin ignoring the format. Saying why is far more
    // useful than a silent bad render.
    const isComic = looksLikeComicPage(submitted)
    const attempt = isComic ? parseComicPage(submitted, sizeHint) : parseImageBlock(submitted, sizeHint)
    throw new Error(
      `这看起来是${isComic ? ' nai5-comic 漫画页' : ' <image> 块'}，但解析不了：${attempt.reason ?? '未知原因'}。` +
        `文本 ${submitted.length} 字符——` +
        (isComic
          ? '需要完整包含 "format":"nai5-comic"、"page":{"base":…} 以及 "panels":[…]（每格带 characters 数组）。'
          : '常见原因是块被截断了：需要完整包含 image###size:WxH 以及 Scene: / Char1: / Char1 UC: / Scene UC: 这些字段。')
    )
  }
  const prompt = page === null ? submitted : page.prompt

  const width = legalAxis(options.width ?? page?.width, settings.width)
  const height = legalAxis(options.height ?? page?.height, settings.height)
  const steps = Math.min(50, Math.max(1, Number(options.steps) || settings.steps))
  const nSamples = Math.min(settings.maxImagesPerCall, Math.max(1, Number(options.nSamples) || 1))
  const model = options.model || settings.model
  const sampler = options.sampler || settings.sampler
  const scale = Number.isFinite(Number(options.scale)) ? Number(options.scale) : settings.scale
  let negativePrompt = options.negativePrompt ?? settings.negativePrompt
  // The page's own negatives belong in the negative prompt, never the positive.
  if (page !== null && page.negativePrompt !== '') {
    negativePrompt = negativePrompt === '' ? page.negativePrompt : `${page.negativePrompt}, ${negativePrompt}`
  }

  // `artistId: -1` in the call overrides the setting, so one render can opt out.
  // Otherwise the mode's own artist string applies — a comic page and an
  // illustration rarely want the same style, and sharing one meant every comic
  // page silently carried the illustration's.
  const artistId = options.artistId === undefined ? Number(settings.artistId) : Number(options.artistId)
  const artist = options.artistId === -1 ? null : await selectedArtist({ ...config, artistId })
  const styleName = artist?.name ?? null
  // An empty positive is a real choice — the editor lets the style prefix be
  // cleared — so it is skipped rather than concatenated. Otherwise the prompt
  // opens with ", ", a separator with nothing in front of it.
  const styledPrompt = artist === null || artist.positivePrompt === '' ? prompt : `${artist.positivePrompt}, ${prompt}`
  if (artist !== null && artist.negativePrompt !== '') {
    negativePrompt = negativePrompt === '' ? artist.negativePrompt : `${artist.negativePrompt}, ${negativePrompt}`
  }

  // The comic recipe adds how the page is *drawn* — greyscale or colour, pacing,
  // margin, bubbles — as opposed to what is in it, and only for the comic mode: an
  // illustration has no panels for a 分镜 to pace.
  //
  // **Prepended, not appended.** Style words carry the most weight at the front and
  // decay toward the tail, which is exactly why appending ~300 characters of recipe
  // after a ~470-character page left the page in full colour. It also goes into the
  // scene caption (below), because the caption is what describes the page as a whole
  // — a directive that only reached the legacy `prompt` field would miss the field
  // the API actually reads when characters are split out.
  const recipeFacts = effectiveMode === 'comic' ? recipeFragments(settings.recipe) : null
  const recipePositive = recipeFacts === null ? '' : recipeFacts.positive
  const finalPrompt = recipePositive === '' ? styledPrompt : `${recipePositive}, ${styledPrompt}`
  if (recipeFacts !== null && recipeFacts.negative !== '') {
    negativePrompt = negativePrompt === '' ? recipeFacts.negative : `${negativePrompt}, ${recipeFacts.negative}`
  }

  const activePool = poolFor(config)
  if (!activePool.configured()) {
    throw new Error('没有可用的 NovelAI API Key。侧栏面板里添加，或导出 NAI_TOKEN。')
  }

  const job = {
    prompt: finalPrompt,
    negativePrompt,
    model,
    width,
    height,
    steps,
    scale,
    sampler,
    // A block's characters travel as their own captions with their own grid
    // positions — the only way `CharN UC` can apply to one character rather than
    // to the whole picture. Plain prompts send an empty list and keep the
    // single-caption path they have always used.
    characters:
      page === null
        ? []
        : page.characters.map((row) => ({ positive: row.text, negative: row.negative, centers: row.centers })),
    sceneCaption:
      page === null
        ? null
        : [recipePositive, artist === null ? '' : artist.positivePrompt, page.sceneCaption].filter((text) => String(text).trim() !== '').join(', '),
    // Everything that applies to the picture as a whole, and nothing that applies
    // to one character: the per-character exclusions travel as their own captions,
    // so `Char1 UC` cannot suppress the features the other captions ask for.
    //
    // This list has to be complete on its own, because on a split render it *is*
    // the picture-wide negative — the flat `negativePrompt` above is bypassed. The
    // recipe's negative in particular only exists here: it is what turns `bubble:
    // off` into an exclusion and what keeps the other language off the page.
    //
    // `settings.negativePrompt` rather than `config.negativePrompt`, to match the
    // flat prompt above; the two used to disagree whenever a mode carried its own.
    sceneNegative:
      page === null
        ? null
        : [
            options.negativePrompt ?? settings.negativePrompt,
            page.sceneNegative,
            artist === null ? '' : artist.negativePrompt,
            recipeFacts === null ? '' : recipeFacts.negative
          ]
            .filter((text) => String(text ?? '').trim() !== '')
            .join(', '),
    ucPreset: Number.isFinite(Number(options.ucPreset)) ? Number(options.ucPreset) : config.ucPreset,
    nSamples: 1,
    seed: options.seed
  }
  const images = await Promise.all(Array.from({ length: nSamples }, () => activePool.enqueue({ ...job })))
  const request = { ...job, nSamples, artist: styleName }
  const files = await persist({ outputDir, images, request })
  return {
    files,
    request,
    weight: costWeight({ width, height, steps, nSamples }),
    concurrency: activePool.concurrency,
    artist: styleName,
    // How much of the final prompt the style prefix actually occupies. An artist
    // string is 400–1200 characters of style tags, which is comparable to a whole
    // scene description — enough to visibly override what was asked for, and
    // invisible unless it is reported.
    artistWeight:
      artist === null
        ? null
        : {
            name: styleName,
            positiveChars: artist.positivePrompt.length,
            negativeChars: artist.negativePrompt.length,
            shareOfPositive: styledPrompt.length === 0 ? 0 : Math.round(((artist.positivePrompt.length + 2) / styledPrompt.length) * 100)
          },
    // Surfaced so the tool can report how a page was read and what it noticed.
    block:
      page === null
        ? null
        : {
            format: page.format ?? 'image-block',
            characters: page.characters,
            notes: page.notes,
            sizeSource: page.sizeSource,
            panelCount: page.panelCount ?? null,
            positionMode: page.positionMode ?? null,
            positiveChars: page.prompt.length,
            negativeChars: page.negativePrompt.length
          }
  }
}

/**
 * Run the live capability check against the current configuration.
 *
 * Everything this plugin has ever broken, broke silently: a coerced type, a
 * stripped id, a dropped branch, a module not yet loaded. This is the counter-
 * measure — one call that exercises each capability and reports it, so a restart
 * can be confirmed instead of hoped about. Renders nothing, costs nothing.
 *
 * @returns `{ ok, checks }`.
 */
async function doctorReport() {
  const config = await load()
  return await runDoctor({
    config,
    pool: poolFor(config),
    proxy: proxyFor(config),
    loadIndex,
    searchArtists,
    readArtistImage,
    listLibraries,
    lookup,
    resolveCharacter,
    digest,
    clientSource: await readFile(new URL('./client.js', import.meta.url), 'utf8').catch(() => ''),
    outputDir: await outputDirOf(config),
    packageRoot: import.meta.dirname,
    modeSettings: MODE_NAMES.map((name) => settingsFor(config, name))
  })
}

/**
 * Mount the tools and the HTTP API.
 * @param ctx - the host plugin context.
 */
export function apply(ctx) {
  // ---------------------------------------------------------------- tools --
  ctx.tools.register(
    defineTool({
      name: 'nai_generate',
      description:
        'Render an image with NovelAI. The PNG is written to the configured output directory and every written path is returned, so you can embed it in your reply as Markdown (`![描述](绝对路径)`) and it appears inline in the conversation. ' +
        'The prompt is either Danbooru-style tags — weights use `N::tag::` — a whole `<image>` block in the 「文生图」 format, or a whole `nai5-comic` page (one JSON object per comic page), each accepted verbatim. ' +
        'For an `<image>` block the `<image_think>` reasoning is dropped and the `Scene:`/`CharN:`/`UC:` fields are split. For a `nai5-comic` page the panels become the scene, each character appearance gets its own caption and negative, and `center` becomes a real position. ' +
        '`n_samples` renders several variants of one prompt, dispatched in parallel across the configured API keys.',
      parameters: {
        prompt: {
          type: 'string',
          required: true,
          description:
            'The positive prompt as Danbooru tags (`N::tag::` weights allowed), or a complete `<image>…</image>` block in the 「文生图」 format, which is parsed for you.'
        },
        negative_prompt: { type: 'string', description: 'Undesired-content prompt. Defaults to the configured one.' },
        width: { type: 'integer', description: 'Pixels; snapped to a multiple of 64. Defaults to the configured width.' },
        height: { type: 'integer', description: 'Pixels; snapped to a multiple of 64. Defaults to the configured height.' },
        model: { type: 'string', description: 'NovelAI model id, e.g. nai-diffusion-4-5-full. Defaults to the configured model.' },
        steps: { type: 'integer', description: 'Sampling steps, 1..50. Defaults to the configured value.' },
        scale: { type: 'number', description: 'Prompt guidance (CFG). Defaults to the configured value.' },
        sampler: { type: 'string', description: 'Sampler id, e.g. k_euler_ancestral. Defaults to the configured value.' },
        seed: { type: 'integer', description: 'Pin the seed for a reproducible render. Omit to let NovelAI choose.' },
        n_samples: { type: 'integer', description: 'Number of variants, 1..maxImagesPerCall. Variants are dispatched in parallel, one per usable API key.' },
        artist_id: {
          type: 'integer',
          description: 'Artist string to prepend, by archive id (see nai_artists). Pass -1 to render without the configured style for this one call.'
        },
        mode: {
          type: 'string',
          description:
            'auto | illustration | comic. `auto` (default) lets the input choose: a nai5-comic page uses the comic settings and its recipe, anything else the illustration settings. `illustration` refuses a comic page; `comic` reads one first.'
        }
      },
      output: {
        schema: { type: 'string' },
        render: textRender((value) => value)
      },
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const config = await load()
        const { files, request, weight, concurrency, artist, block, artistWeight } = await renderNow({
          prompt: args.prompt,
          negativePrompt: args.negative_prompt,
          width: args.width,
          height: args.height,
          model: args.model,
          steps: args.steps,
          scale: args.scale,
          sampler: args.sampler,
          seed: args.seed,
          nSamples: args.n_samples,
          artistId: args.artist_id,
          mode: args.mode
        })
        const lines = files.map((file, index) => {
          const bits = [`${file.bytes} 字节`]
          if (file.seed !== null) bits.push(`seed ${file.seed}`)
          if (file.model) bits.push(file.model)
          if (file.steps !== null) bits.push(`${file.steps} 步`)
          return `${index + 1}. ${file.file}\n   ${bits.join(' · ')}`
        })
        const header = [
          `已渲染 ${files.length} 张 · ${request.width}×${request.height} · ${request.steps} 步 · ${request.model} · 并发 ${concurrency} · 相对消耗 ${weight}`,
          artist === null
            ? ''
            : `画师串「${artist}」+${artistWeight.positiveChars} 字符（占正向 ${artistWeight.shareOfPositive}%）`
        ]
          .filter(Boolean)
          .join(' · ')
        return [
          header,
          // An artist string is a style prefix the size of a whole scene, so say
          // so loudly when it dominates. Otherwise the render quietly comes back
          // looking nothing like the prompt and the plugin gets the blame.
          ...(artistWeight === null || artistWeight.shareOfPositive < 25
            ? []
            : [
                `⚠ 画师串占了正向的 ${artistWeight.shareOfPositive}%（${artistWeight.positiveChars} / ${request.prompt.length} 字符），` +
                  `负向也并入了 ${artistWeight.negativeChars} 字符。它会明显压过你写的提示词。` +
                  '要严格按提示词出图：本次调用传 artist_id: -1，或先在侧栏把画师串关掉。'
              ]),
          // When the prompt was an `<image>` block, say how it was read: the
          // structural parts are invisible from the outside, and a note about a
          // size that came from an orientation word is worth knowing.
          ...(block === null
            ? []
            : [
                (block.format === 'nai5-comic'
                  ? `漫画页：${block.panelCount} 格 · 正向 ${block.positiveChars} 字符 · 负向 ${block.negativeChars} 字符 · 定位 ${block.positionMode}`
                  : `<image> 块：正向 ${block.positiveChars} 字符 · 负向 ${block.negativeChars} 字符 · 尺寸来源 ${block.sizeSource}`) +
                  (block.characters.length > 0
                    ? ` · 角色 ${block.characters.map((c) => `${c.label}${(c.centers ?? []).length === 0 ? '' : `@${JSON.stringify(c.centers[0])}`}`).join(' ')}`
                    : ''),
                ...block.notes.map((note) => `  · ${note}`)
              ]),
          '',
          ...lines,
          '',
          '在回复里内联显示：',
          // An absolute URL when a base is known: the browser half takes one
          // verbatim, while a local path only draws while its path vocabulary
          // happens to know that path — which is why a picture used to vanish
          // from a conversation that was switched away from and back.
          files.map((file) => `![生成图片](${imageLink(inlineBase(config), file.file)})`).join('\n')
        ].join('\n')
      }
    })
  )

  ctx.tools.register(
    defineTool({
      name: 'nai_estimate',
      description:
        'Estimate what one render would cost before spending it, and see which parameters are driving the cost. ' +
        'The number is a relative weight (area x steps x variants, with 832x1216 at 28 steps defined as 1), not a price: a NovelAI Opus subscription bills nothing inside the standard size envelope and bills above it. ' +
        'Call this before a large or repeated render.',
      parameters: {
        width: { type: 'integer', description: 'Pixels; snapped to a multiple of 64. Defaults to the configured width.' },
        height: { type: 'integer', description: 'Pixels; snapped to a multiple of 64. Defaults to the configured height.' },
        steps: { type: 'integer', description: 'Sampling steps. Defaults to the configured value.' },
        n_samples: { type: 'integer', description: 'Variants. Defaults to 1.' }
      },
      output: { schema: { type: 'string' }, render: textRender((value) => value) },
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const config = await load()
        const width = legalAxis(args.width, config.width)
        const height = legalAxis(args.height, config.height)
        const steps = Math.min(50, Math.max(1, Number(args.steps) || config.steps))
        const nSamples = Math.max(1, Number(args.n_samples) || 1)
        const capped = Math.min(nSamples, config.maxImagesPerCall)
        const weight = costWeight({ width, height, steps, nSamples: capped })
        const perImage = costWeight({ width, height, steps, nSamples: 1 })
        const free = insideFreeBand({ width, height, steps, nSamples: capped })
        return [
          `参数：${width}×${height} · ${steps} 步 · ${capped} 张`,
          `单张相对消耗：${perImage}   合计：${weight}`,
          `（参照：832×1216 @28 步 = 1）`,
          free
            ? `落在 Opus 免计费区间内（单张、无底图、像素积 ≤ ${FREE_AREA.toLocaleString('en-US')}、≤28 步）—— 应当不消耗 Anlas。`
            : `超出 Opus 免计费区间（要求单张、无底图、像素积 ≤ ${FREE_AREA.toLocaleString('en-US')}、≤28 步）—— 超出的部分会消耗 Anlas。`,
          capped < nSamples ? `注意：请求的 ${nSamples} 张被 maxImagesPerCall 压到 ${capped} 张。` : '',
          capped > 1 ? '多张（n_samples > 1）本身就会离开免计费区间。' : ''
        ]
          .filter((line) => line !== '')
          .join('\n')
      }
    })
  )

  ctx.tools.register(
    defineTool({
      name: 'nai_lookup',
      description:
        'Search the indexed 附体 libraries by keyword against titles, trigger keys and bodies. ' +
        `自有五库：${LIBRARIES.join(' / ')}（标签库 is the Chinese-to-Danbooru dictionary, 常规模板 is clothing and character transformations, 扩展库 is monster-girl DNA templates with forbidden actions and UC exclusions, 同人库 is the character roster, SEX模板 is verified scene prompt combinations）。` +
        '外部三库（2026-10-06 整站抓取后并入）：外部画师 33165 条（画师串词典 / 社区图包整套配方含负面）、外部构图 4817 条（镜头 / 姿势 / 场景 / 服装）、外部模板 6102 条（五库没有的长尾）。' +
        'COST: keep `maxChars` small — bodies are long and the index holds 44k+ external entries. `maxChars: 0` returns headers only (title + keys + length): use that to pick a hit, then fetch that one body with a larger maxChars. Prefer `library` over an all-library sweep. ' +
        'Inside a returned body, `a/b/c` means pick one, `a,b,c` means the tags belong together, and bracketed placeholders like `[x]` must be replaced — `[tag]` is a down-weight in NAI, never literal text.',
      parameters: {
        query: { type: 'string', required: true, description: 'Keyword. A bare `.` returns entries in order, for paging a whole library.' },
        library: { type: 'string', description: `Restrict to one library. Own: ${LIBRARIES.join(' / ')}. External: 外部画师 / 外部构图 / 外部模板.` },
        limit: { type: 'integer', description: 'Maximum hits, default 8. Use 1–3 unless comparing variants.' },
        maxChars: { type: 'integer', description: 'Body characters per hit, default 600. 0 = headers only (cheapest). Larger only when that one body really is needed.' },
        full: { type: 'boolean', description: 'Return full bodies instead of truncating long ones. Expensive — use for a single hit.' }
      },
      output: { schema: { type: 'string' }, render: textRender((value) => value) },
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const config = await load()
        const rawChars = args.maxChars === undefined ? 600 : Number(args.maxChars)
        return digest(
          await lookup(args.query, {
            libraryDir: config.libraryDir,
            library: args.library,
            limit: Math.min(20, Math.max(1, Number(args.limit) || 8)),
            maxChars: rawChars === 0 ? 0 : Math.min(6000, Math.max(120, Number.isFinite(rawChars) ? rawChars : 600)),
            full: args.full === true
          })
        )
      }
    })
  )

  ctx.tools.register(
    defineTool({
      name: 'nai_resolve',
      description:
        'Resolve a character to their entry in the 同人库8.5 roster: official Danbooru tag plus appearance and outfit anchors. ' +
        'Always resolve before inventing a tag — the roster is authoritative and a guessed tag silently renders a stranger.',
      parameters: {
        name: { type: 'string', required: true, description: 'Chinese name, romanisation, or tag fragment.' },
        limit: { type: 'integer', description: 'Maximum hits, default 3.' }
      },
      output: { schema: { type: 'string' }, render: textRender((value) => value) },
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const config = await load()
        const result = await resolveCharacter(args.name, {
          libraryDir: config.libraryDir,
          limit: Math.min(10, Math.max(1, Number(args.limit) || 3))
        })
        return digest({ ...result, total: result.hits.length })
      }
    })
  )

  ctx.tools.register(
    defineTool({
      name: 'nai_index',
      description:
        'Rebuild the five-library search index from the original world-book JSONs. Run once after install, or after adding or updating a library file. ' +
        'When several historical releases of the same library sit in the source directory, the release with the most entries wins.',
      parameters: {},
      output: { schema: { type: 'string' }, render: textRender((value) => value) },
      async execute(_args, exec) {
        exec.signal.throwIfAborted()
        const config = await load()
        const result = await rebuildIndex({ sourceDir: config.librarySourceDir, libraryDir: config.libraryDir })
        const written = result.written.map((row) => `${row.library}  ←  ${row.source}   ${row.entries} 条`)
        const skipped = result.skipped.map((row) => `${row.file}: ${row.reason}`)
        if (written.length === 0) {
          return `没有找到可索引的附体库。\n源目录：${config.librarySourceDir}\n已跳过的文件：\n${skipped.join('\n') || '（目录为空或没有 *.json）'}`
        }
        return [
          `索引已重建，写入 ${written.length} 个库 → ${config.libraryDir}`,
          '',
          ...written,
          skipped.length > 0 ? `\n跳过 ${skipped.length} 个文件：\n${skipped.slice(0, 10).join('\n')}` : ''
        ]
          .filter((line) => line !== '')
          .join('\n')
      }
    })
  )

  ctx.tools.register(
    defineTool({
      name: 'nai_status',
      description:
        'Report the live NovelAI plugin state: model and size, the effective proxy, the API key pool (counts and concurrency, never the tokens), the artist-string archive and which one is in force, whether auto-render is on, the output directory, how many images exist, and which libraries are indexed.',
      parameters: {},
      output: { schema: { type: 'string' }, render: textRender((value) => value) },
      async execute(_args, exec) {
        exec.signal.throwIfAborted()
        const status = await statusPayload()
        const pool = status.keySummary
        return [
          `底座：${status.baseUrl}   模型：${status.model}`,
          `尺寸：${status.width}×${status.height}   步数：${status.steps}   引导：${status.scale}   采样器：${status.sampler}`,
          `代理：${status.proxy ?? '直连'}${status.proxySetting === '' ? '（自动跟随系统）' : '（面板指定）'}`,
          `Key 池：${pool.keyCount} 个（可用 ${pool.usableKeyCount}，空闲 ${pool.availableKeyCount}）　并发度 ${pool.concurrency}` +
            (pool.problemKeyCount > 0 ? `　⚠ ${pool.problemKeyCount} 个待处理` : ''),
          `画师串：已导入 ${status.artistCount} 条　当前：${status.artistName ?? '未选择'}`,
          `自动出图：${status.autoGenerate ? '开' : '关'}`,
          pool.usableKeyCount > 0
            ? `凭据：Key 池里有 ${pool.usableKeyCount} 把可用`
            : status.tokenSet
              ? `凭据：已配置（${status.tokenSource === 'env' ? '环境变量 NAI_TOKEN' : '配置文件'}）`
              : '凭据：未配置 —— 在侧栏面板填写，或用 nai_keys add 添加',
          `出图目录：${status.outputDir}   已有 ${status.imageCount} 张`,
          `索引目录：${status.libraryDir}`,
          `源目录：${status.librarySourceDir}`,
          `每次上限：${status.maxImagesPerCall} 张`,
          `已索引的库：${status.libraries.map((row) => `${row.library}(${row.entries})`).join('、')}`
        ].join('\n')
      }
    })
  )

  ctx.tools.register(
    defineTool({
      name: 'nai_probe',
      description:
        'Check the host, the network path and the token WITHOUT spending Anlas, by reading the subscription record instead of rendering. ' +
        'Run this before the first real render: a 401 means the token is unusable, a network failure means the domain or proxy is wrong, and a success also reports the remaining training steps.',
      parameters: {},
      output: { schema: { type: 'string' }, render: textRender((value) => value) },
      async execute(_args, exec) {
        exec.signal.throwIfAborted()
        const result = await probeNow({ signal: exec.signal })
        const lines = [
          `${result.ok ? '✅' : '❌'} ${result.detail}`,
          result.status === undefined ? '' : `HTTP ${result.status}　主机：${result.origin ?? '—'}`,
          result.hint ?? '',
          result.stage === 'token' && result.ok === false ? '把 token 换成 NovelAI 账号设置里的 Persistent Token（pst- 开头）。' : '',
          result.pool === undefined
            ? ''
            : `Key 池：${result.pool.keyCount} 个（可用 ${result.pool.usableKeyCount}）　并发度 ${result.pool.concurrency}` +
              (result.pool.problemKeyCount > 0 ? `　⚠ ${result.pool.problemKeyCount} 个有问题，用 nai_keys list 看详情` : '')
        ]
        if (result.subscription) {
          const s = result.subscription
          const who = [`订阅档：${s.tier ?? '—'}`, s.active === false ? '未生效' : '已生效']
          if (s.expiresAt !== null && s.expiresAt !== undefined) {
            who.push(`到期：${new Date(s.expiresAt).toISOString().slice(0, 10)}`)
          }
          lines.push(
            '',
            who.join('　'),
            `Anlas 余额：${s.remainingAnlas ?? '未知'}` +
              (s.remainingAnlas === null || s.remainingAnlas === undefined
                ? ''
                : `（固定 ${s.fixedAnlas} + 购买 ${s.purchasedAnlas}）`),
            describeQuota(s.v5Quota)
          )
        }
        return lines.filter((line) => line !== '').join('\n')
      }
    })
  )

  ctx.tools.register(
    defineTool({
      name: 'nai_keys',
      description:
        'Manage the NovelAI API key pool. Every usable key gives one concurrent render slot, so the pool\'s breadth is exactly the number of working keys. ' +
        'Actions: `list` (labels, fingerprints, per-key state — never the tokens), `add` (needs `token`), `remove` (needs `id`), `enable`/`disable` (needs `id`), `verify` (one free subscription read per key, in parallel).',
      parameters: {
        action: { type: 'string', required: true, description: 'list | add | remove | enable | disable | verify' },
        id: { type: 'string', description: 'Key id, from `list`.' },
        label: { type: 'string', description: 'Display label for `add`.' },
        token: { type: 'string', description: 'The pst-… token for `add`.' }
      },
      output: { schema: { type: 'string' }, render: textRender((value) => value) },
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const action = String(args.action ?? 'list').toLowerCase()
        const describePool = async () => {
          const config = await load()
          const activePool = poolFor(config)
          const summary = activePool.healthSummary()
          const lines = [
            `Key 池：${summary.keyCount} 个（可用 ${summary.usableKeyCount}，空闲 ${summary.availableKeyCount}）　并发度 ${summary.concurrency}　队列 ${summary.queuedCount}　在飞 ${summary.activeCount}`
          ]
          for (const key of activePool.list()) {
            lines.push(
              `  ${key.label}  fp=${key.fingerprint}  ${key.enabled ? 'on' : 'off'}  ${key.status}` +
                `${key.completed ? `  已完成 ${key.completed}` : ''}` +
                `${key.subscription?.tier === undefined || key.subscription?.tier === null ? '' : `  tier=${key.subscription.tier}`}` +
                `${key.lastError ? `  ⚠ ${key.lastError}` : ''}`
            )
          }
          return lines.join('\n')
        }

        if (action === 'list') return describePool()
        if (action === 'verify') {
          const config = await load()
          const activePool = poolFor(config)
          await Promise.all(activePool.list().map(() => activePool.enqueue({ kind: 'probe' }, { noRetry: true }).catch(() => null)))
          return describePool()
        }
        if (action === 'add') {
          const token = String(args.token ?? '').trim()
          if (token === '') return 'add 需要 token。'
          await persistKeys((keys) => {
            if (keys.some((key) => fingerprintOf(key.token) === fingerprintOf(token))) return keys
            keys.push({ id: randomUUID(), label: String(args.label ?? ''), token, enabled: true })
            return keys
          })
          return `已添加。\n${await describePool()}`
        }
        if (action === 'remove') {
          const id = String(args.id ?? '')
          if (id === '') return 'remove 需要 id。'
          await persistKeys((keys) => keys.filter((key) => key.id !== id))
          return `已移除。\n${await describePool()}`
        }
        if (action === 'enable' || action === 'disable') {
          const id = String(args.id ?? '')
          if (id === '') return `${action} 需要 id。`
          await persistKeys((keys) => keys.map((key) => (key.id === id ? { ...key, enabled: action === 'enable' } : key)))
          return `已${action === 'enable' ? '启用' : '停用'}。\n${await describePool()}`
        }
        return `未知 action：${action}（可用：list / add / remove / enable / disable / verify）`
      }
    })
  )

  ctx.tools.register(
    defineTool({
      name: 'nai_artists',
      description:
        'Search the imported artist-string archive (画师串). Each entry is a ready-made style prefix — a positive prompt, an optional negative prompt, and a reference image. ' +
        'Call with `query` to search, or with `id` to read one entry in full so it can be prepended to a render.',
      parameters: {
        query: { type: 'string', description: 'Search text over names and prompts. Omit to list everything.' },
        id: { type: 'integer', description: 'Read one entry in full by id.' },
        select: { type: 'integer', description: 'Make this archive id the artist string in force, applied to every later render until changed.' },
        clear: { type: 'boolean', description: 'Stop applying any artist string.' },
        limit: { type: 'integer', description: 'Maximum search results, default 20.' }
      },
      output: { schema: { type: 'string' }, render: textRender((value) => value) },
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const config = await load()
        // Both halves of the list: an artist string you made yourself is usable
        // from here exactly like an imported one, so a search that skipped it would
        // be lying about what the plugin can render with.
        const { entries } = await artistEntries(config)
        if (entries.length === 0) {
          return `还没有导入画师串索引（${config.artistIndex}）。在插件目录里运行：node import-artists.mjs "<画师串.json 路径>"`
        }
        if (args.clear === true) {
          await save({ artistId: -1 })
          return '已关闭画师串：之后的出图不再叠加任何风格。'
        }
        if (args.select !== undefined && args.select !== null) {
          const picked = entryById(entries, args.select)
          if (picked === undefined) return `没有 id=${args.select} 的画师串（共 ${entries.length} 条）。`
          await save({ artistId: picked.id })
          return `已把「${picked.name}」(#${picked.id}) 设为当前画师串，之后每次出图都会把它前置到正向、把它的负向并入负向。\n用 nai_artists({ clear: true }) 关掉，或用 nai_artists({ select: N }) 换一条。`
        }
        if (args.id !== undefined && args.id !== null) {
          const entry = entryById(entries, args.id)
          if (entry === undefined) return `没有 id=${args.id} 的画师串（共 ${entries.length} 条）。`
          return [
            `【#${entry.id}】${entry.name}　(sequence ${entry.sequence})`,
            `正文 ${entry.positivePrompt.length} 字符${entry.image === null || entry.image === undefined ? '，无参考图' : '，有参考图'}${entry.custom === true ? '，自建条目' : ''}`,
            '',
            '正向：',
            entry.positivePrompt,
            entry.negativePrompt === '' ? '' : `\n负向：\n${entry.negativePrompt}`,
            entry.chamiPositivePrompt === '' ? '' : `\nChami 正向：\n${entry.chamiPositivePrompt}`
          ]
            .filter((line) => line !== '')
            .join('\n')
        }
        const rows = searchArtists({ entries }, args.query ?? '', Math.min(200, Math.max(1, Number(args.limit) || 20)))
        const lines = [`共 ${entries.length} 条画师串，命中 ${rows.length} 条：`]
        for (const row of rows) {
          lines.push(
            `  #${row.id}  ${row.name}  [${row.promptChars} 字符]${row.hasImage ? '  🖼' : ''}${row.custom === true ? '  自建' : ''}`
          )
        }
        if (rows.length > 0) lines.push('\n用 nai_artists({ id }) 读全文。')
        return lines.join('\n')
      }
    })
  )

  ctx.tools.register(
    defineTool({
      name: 'nai_doctor',
      description:
        'Check that every capability of this plugin is intact against the live configuration: config field types, the key pool, the proxy path, the artist archive and its remembered selection, all five libraries, the `<image>` format parser, the browser half\'s classifier, and the output directory. ' +
        'Costs nothing and renders nothing, so run it after any restart or code change rather than discovering a silent breakage later.',
      parameters: {},
      output: { schema: { type: 'string' }, render: textRender((value) => value) },
      async execute(_args, exec) {
        exec.signal.throwIfAborted()
        return formatDoctor(await doctorReport())
      }
    })
  )

  ctx.tools.register(
    defineTool({
      name: 'nai_config',
      description:
        'Change the NovelAI plugin configuration. Only the fields you pass are replaced. Use this to set the token, default size, model, output directory or library directories from the conversation instead of the panel.',
      parameters: {
        token: { type: 'string', description: 'NovelAI persistent API token. Stored in $DSH_HOME/nai-imagegen/config.json.' },
        base_url: { type: 'string', description: 'API base, default https://image.novelai.net' },
        model: { type: 'string', description: 'Default model id.' },
        width: { type: 'integer', description: 'Default width.' },
        height: { type: 'integer', description: 'Default height.' },
        steps: { type: 'integer', description: 'Default sampling steps.' },
        scale: { type: 'number', description: 'Default guidance.' },
        sampler: { type: 'string', description: 'Default sampler.' },
        proxy: { type: 'string', description: 'Proxy for reaching NovelAI. Empty or auto uses the Windows system proxy; "off" forces a direct connection; otherwise a URL like http://127.0.0.1:7890.' },
        uc_preset: { type: 'integer', description: 'Undesired-content preset index, 0..3. Default 3, matching the official client.' },
        negative_prompt: { type: 'string', description: 'Default negative prompt.' },
        output_dir: { type: 'string', description: 'Where PNGs are written.' },
        library_dir: { type: 'string', description: 'Directory holding <库名>.jsonl indexes.' },
        library_source_dir: { type: 'string', description: 'Directory holding the original world-book JSONs.' },
        max_images_per_call: { type: 'integer', description: 'Billing guard: variants allowed per call.' },
        keep_images: { type: 'integer', description: 'Keep only the newest N images on disk; 0 disables trimming.' },
        artist_id: { type: 'integer', description: 'The artist string in force, by archive id; -1 for none. Same setting as nai_artists select.' },
        artist_index: { type: 'string', description: 'Where the artist index lives.' },
        artist_source: { type: 'string', description: 'Override the archive path recorded inside the artist index.' },
        auto_generate: { type: 'boolean', description: 'Whether prompt-looking code blocks in the transcript render by themselves.' },
        reply_transport: { type: 'boolean', description: 'Whether the reply transport is on: the model is ordered to write its whole reply through the nai_reply tool instead of ordinary message text. Off leaves the model answering the usual way.' }
      },
      output: { schema: { type: 'string' }, render: textRender((value) => value) },
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const patch = {}
        const map = {
          token: 'token',
          base_url: 'baseUrl',
          model: 'model',
          width: 'width',
          height: 'height',
          steps: 'steps',
          scale: 'scale',
          sampler: 'sampler',
          proxy: 'proxy',
          uc_preset: 'ucPreset',
          negative_prompt: 'negativePrompt',
          output_dir: 'outputDir',
          library_dir: 'libraryDir',
          library_source_dir: 'librarySourceDir',
          max_images_per_call: 'maxImagesPerCall',
          keep_images: 'keepImages',
          artist_id: 'artistId',
          artist_index: 'artistIndex',
          artist_source: 'artistSource',
          auto_generate: 'autoGenerate',
          reply_transport: 'replyTransport'
        }
        for (const [key, field] of Object.entries(map)) {
          if (args[key] !== undefined) patch[field] = args[key]
        }
        if (Object.keys(patch).length === 0) return '没有需要修改的字段。'
        await save(patch)
        // Same as the panel's own save: turning the transport off takes the tool out of the list
        // in this very call, so the next request is assembled without it.
        if (patch.replyTransport !== undefined) applyReplySetting(ctx, patch.replyTransport === true)
        const names = Object.keys(patch).join('、')
        return `已更新：${names}\n${await statusPayload().then((s) => `凭据：${s.tokenSet ? '已配置' : '仍未配置'}`)}`
      }
    })
  )

  // The reply tool. It writes nothing: the model's own words go out to the browser half
  // through the call's arguments, and the ledger keeps only their size and digest. Registered
  // here rather than in `lib/reply.js` so that the browser half's view of the same name is
  // registered in sight of it — the doctor compares the two strings.
  //
  // It is registered before the stored setting is read, so the switch is in a known state the
  // moment this function returns; the read then has the last word, and takes the tool straight
  // back out if the file says the transport is off. `apply` cannot await, and a registration
  // held behind a promise would leave the tool list in the hands of a file read.
  applyReplySetting(ctx, true)
  load()
    .then((config) => applyReplySetting(ctx, config.replyTransport === true))
    .catch(() => {})

  // ------------------------------------------------------------------ api --
  /**
   * Answer one panel request. The handler owns the whole response lifecycle,
   * matching the route contract.
   */
  const handler = async (req, res) => {
    try {
      const host = req.headers?.host
      if (typeof host === 'string' && host.trim() !== '') seenHost = host.trim()
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const route = url.pathname.slice(API_PREFIX.length) || '/'
      const method = (req.method ?? 'GET').toUpperCase()

      if (method === 'GET' && route === '/status') return sendJson(res, 200, await statusPayload())

      if (method === 'GET' && route === '/config') {
        const config = await load()
        const token = await tokenOf(config)
        // The token is never echoed back; only its origin.
        const { token: _omitted, ...rest } = config
        return sendJson(res, 200, {
          ...rest,
          tokenSet: token.length > 0,
          tokenSource: (process.env.NAI_TOKEN || '').trim() ? 'env' : token ? 'file' : 'none'
        })
      }

      if (method === 'POST' && route === '/config') {
        const body = await readJsonBody(req)
        const allowed = [
          'baseUrl',
          'token',
          'model',
          'width',
          'height',
          'steps',
          'scale',
          'sampler',
          'ucPreset',
          'proxy',
          'negativePrompt',
          'outputDir',
          'libraryDir',
          'librarySourceDir',
          'maxImagesPerCall',
          'keepImages',
          'autoGenerate',
          'replyTransport',
          'mode',
          'modes',
          'displayWidth',
          'displayMaxHeight',
          'displayClickZoom',
          'webBase',
          'artistSource',
          'artistIndex',
          'artistId'
        ]
        const patch = {}
        for (const key of allowed) if (body[key] !== undefined) patch[key] = body[key]
        if (Object.keys(patch).length === 0) return sendJson(res, 400, { error: 'no known fields in body' })
        await save(patch)
        // The field is stored either way; the switch itself is applied here, in the same request
        // that asked for it, so "开" in the panel and a tool in the list arrive together.
        if (patch.replyTransport !== undefined) applyReplySetting(ctx, patch.replyTransport === true)
        return sendJson(res, 200, { ok: true, updated: Object.keys(patch), status: await statusPayload() })
      }

      // ---------------------------------------------------------- api keys --
      if (method === 'GET' && route === '/keys') {
        const config = await load()
        const activePool = poolFor(config)
        return sendJson(res, 200, { keys: activePool.list(), summary: activePool.healthSummary() })
      }

      if (method === 'POST' && route === '/keys/add') {
        const body = await readJsonBody(req)
        const token = String(body.token ?? '').trim()
        if (token === '') return sendJson(res, 400, { error: 'token is required' })
        await persistKeys((keys) => {
          const fingerprint = fingerprintOf(token)
          if (keys.some((key) => fingerprintOf(key.token) === fingerprint)) return keys
          keys.push({ id: randomUUID(), label: String(body.label ?? ''), token, enabled: true })
          return keys
        })
        return sendJson(res, 200, { ok: true, status: await statusPayload() })
      }

      if (method === 'POST' && route === '/keys/update') {
        const body = await readJsonBody(req)
        const id = String(body.id ?? '')
        if (id === '') return sendJson(res, 400, { error: 'id is required' })
        await persistKeys((keys) =>
          keys.map((key) =>
            key.id === id
              ? {
                  ...key,
                  label: body.label === undefined ? key.label : String(body.label),
                  enabled: body.enabled === undefined ? key.enabled : body.enabled === true
                }
              : key
          )
        )
        return sendJson(res, 200, { ok: true, status: await statusPayload() })
      }

      if (method === 'POST' && route === '/keys/remove') {
        const body = await readJsonBody(req)
        const id = String(body.id ?? '')
        if (id === '') return sendJson(res, 400, { error: 'id is required' })
        await persistKeys((keys) => keys.filter((key) => key.id !== id))
        return sendJson(res, 200, { ok: true, status: await statusPayload() })
      }

      if (method === 'POST' && route === '/keys/verify') {
        const config = await load()
        const activePool = poolFor(config)
        // One probe per key, in parallel, with no cross-key retry: a verify is a
        // report on each key, not work that can be moved elsewhere.
        await Promise.all(activePool.list().map(() => activePool.enqueue({ kind: 'probe' }, { noRetry: true }).catch(() => null)))
        return sendJson(res, 200, { ok: true, keys: activePool.list(), summary: activePool.healthSummary() })
      }

      // ------------------------------------------------------- membership --
      // A read-only question about what the keys have. `GET` reports what is
      // already known and never touches the network; `POST` re-reads the
      // subscription record for every enabled key, which is free and changes
      // nothing about render eligibility.
      if (method === 'GET' && route === '/quota') {
        const config = await load()
        const keys = poolFor(config).list().map(quotaViewOf)
        return sendJson(res, 200, { ok: true, ...summarizeQuota(keys), keys })
      }

      if (method === 'POST' && route === '/quota') {
        return sendJson(res, 200, { ok: true, ...(await refreshQuota()) })
      }

      if (method === 'GET' && route === '/doctor') {
        const report = await doctorReport()
        return sendJson(res, report.ok ? 200 : 500, report)
      }

      // ------------------------------------------------------------ artists --
      if (method === 'GET' && route === '/artists') {
        const config = await load()
        const { entries, sourceFile } = await artistEntries(config)
        const favorites = favoriteSetOf(config, entries)
        const query = url.searchParams.get('q') ?? ''
        // The cap is the picker's ceiling, not a page: the window lists the archive by
        // name and 200 entries is an archive the user cannot reach the end of. A request
        // that asks for more than the cap gets the cap, so a hand-written URL cannot ask
        // the host to serialise an unbounded list.
        const limit = Math.min(MAX_ARTIST_ROWS, Math.max(1, Number(url.searchParams.get('limit')) || 60))
        return sendJson(res, 200, {
          index: config.artistIndex,
          source: sourceFile,
          count: entries.length,
          favoriteCount: favorites.size,
          // User entries are part of the same list, so the grid, the window's picker
          // and the search all find them without knowing they are different.
          artists: searchArtists({ entries }, query, limit).map((row) => ({
            ...row,
            // Marked in the grid too, so a customised entry is findable by eye
            // instead of only by opening it and reading the text.
            edited: artistViewOf(entryById(entries, row.id), artistEditOf(config, row.id))?.edited === true,
            // And starred ones are marked where they are, so the star the user set on
            // one surface is the same star on the other.
            favorite: favorites.has(Number(row.id))
          }))
        })
      }

      if (method === 'GET' && route === '/artist') {
        const config = await load()
        const { entries } = await artistEntries(config)
        const entry = entryById(entries, url.searchParams.get('id'))
        if (entry === undefined) return sendJson(res, 404, { error: 'unknown artist' })
        return sendJson(res, 200, entry)
      }

      /**
       * The text of one artist string, as it will actually be sent.
       *
       * Returns the archive text **and** the text in force, because an editor has
       * to show both: "which of these is NovelAI going to see" is the only question
       * that matters once the two can differ.
       */
      if (method === 'GET' && route === '/artist-text') {
        const config = await load()
        const { entries } = await artistEntries(config)
        const id = Number(url.searchParams.get('id'))
        const view = artistViewOf(entryById(entries, id), artistEditOf(config, id))
        if (view === null) return sendJson(res, 404, { error: 'unknown artist' })
        return sendJson(res, 200, view)
      }

      /**
       * Change what one artist string says, or put the archive text back.
       *
       * Stored against the artist id rather than against the selection, so the
       * same id reads the same wherever it is picked — the panel's one selection
       * and the window's two per-mode selections all resolve through it.
       *
       * `revert: true` deletes the edit; saving an empty string is a different
       * thing (it means "no style prefix") and is therefore kept.
       */
      if (method === 'POST' && route === '/artist-edit') {
        const config = await load()
        const body = await readJsonBody(req)
        const id = Number(body.id)
        if (!Number.isInteger(id) || id < 0) return sendJson(res, 400, { error: 'id must be a non-negative integer' })
        for (const side of ['positive', 'negative']) {
          const text = body[side]
          if (typeof text === 'string' && text.length > MAX_ARTIST_EDIT_CHARS) {
            return sendJson(res, 400, { error: `${side} is longer than ${MAX_ARTIST_EDIT_CHARS} characters` })
          }
        }
        const edits = { ...(config.artistEdits ?? {}) }
        const key = String(id)
        if (body.revert === true) {
          delete edits[key]
        } else {
          const row = {}
          for (const side of ['positive', 'negative']) {
            if (body[side] === undefined || body[side] === null) continue
            row[side] = String(body[side])
          }
          if (Object.keys(row).length === 0) {
            return sendJson(res, 400, { error: 'nothing to save: send positive, negative, or revert: true' })
          }
          edits[key] = row
        }
        await save({ artistEdits: edits })
        const after = await load()
        const { entries: afterEntries } = await artistEntries(after)
        return sendJson(res, 200, {
          ok: true,
          id,
          reverted: body.revert === true,
          artist: artistViewOf(entryById(afterEntries, id), artistEditOf(after, id)),
          status: await statusPayload()
        })
      }

      /**
       * Star an artist string, or take the star off.
       *
       * Stored beside the archive rather than in it, like an edit: the archive is
       * imported material, so a star written into it would be lost by the next import.
       * The star belongs to the *entry*, not to the pick, so the grid and both of the
       * window's modes see the same star on the same id.
       *
       * `favorite` is a boolean rather than a toggle: two surfaces open at once would
       * otherwise fight over one click and the later writer would decide, which is how
       * a star ends up meaning the opposite of what it was clicked for.
       */
      if (method === 'POST' && route === '/artist-favorite') {
        const config = await load()
        const body = await readJsonBody(req)
        const id = Number(body.id)
        if (!Number.isInteger(id) || id < 0) return sendJson(res, 400, { error: 'id must be a non-negative integer' })
        if (typeof body.favorite !== 'boolean') return sendJson(res, 400, { error: 'favorite must be true or false' })
        const { entries } = await artistEntries(config)
        if (entryById(entries, id) === undefined) return sendJson(res, 404, { error: 'unknown artist' })
        const starred = storedFavoriteIds(config)
        // The cap counts the stored list, and an id that is already in it never trips
        // it: unstarring and starring again must not depend on how full the list is.
        if (body.favorite === true && starred.size >= MAX_ARTIST_FAVORITES && !starred.has(id)) {
          return sendJson(res, 400, { error: `no more than ${MAX_ARTIST_FAVORITES} artist strings can be starred` })
        }
        if (body.favorite === true) starred.add(id)
        else starred.delete(id)
        await save({ artistFavorites: [...starred].sort((a, b) => a - b) })
        const after = await load()
        const { entries: afterEntries } = await artistEntries(after)
        return sendJson(res, 200, {
          ok: true,
          id,
          favorite: body.favorite,
          // The list as it can be offered, which is what the two surfaces hoist to the
          // front. Read back instead of echoed, so the reply cannot disagree with what
          // the next `/status` will say.
          favorites: [...favoriteSetOf(after, afterEntries)].sort((a, b) => a - b),
          status: await statusPayload()
        })
      }

      /**
       * Make a new artist string.
       *
       * Stored beside the index rather than in the archive: the archive is an
       * import, so anything written into it would be lost the next time it is
       * imported — the same reason an edit is stored by id instead of in place.
       * The id comes from the library, above every id in play, so a new entry can
       * never shadow an archive entry even after a larger re-import.
       *
       * The reference image is a second call (`POST /artist-image?id=N`), so this
       * request stays a small JSON body and the image can be replaced, or never
       * supplied at all.
       */
      if (method === 'POST' && route === '/artist-add') {
        const config = await load()
        const body = await readJsonBody(req)
        const name = typeof body.name === 'string' ? body.name.trim() : ''
        if (name === '') return sendJson(res, 400, { error: 'name is required' })
        if (name.length > MAX_ARTIST_NAME_CHARS) {
          return sendJson(res, 400, { error: `name is longer than ${MAX_ARTIST_NAME_CHARS} characters` })
        }
        for (const side of ['positive', 'negative']) {
          const text = body[side]
          if (typeof text === 'string' && text.length > MAX_ARTIST_EDIT_CHARS) {
            return sendJson(res, 400, { error: `${side} is longer than ${MAX_ARTIST_EDIT_CHARS} characters` })
          }
        }
        const { library, entries } = await artistEntries(config)
        const id = nextUserId(entries)
        library.entries = [
          ...library.entries,
          {
            id,
            name,
            positivePrompt: typeof body.positive === 'string' ? body.positive : '',
            negativePrompt: typeof body.negative === 'string' ? body.negative : '',
            chamiPositivePrompt: '',
            chamiNegativePrompt: '',
            createdAt: new Date().toISOString()
          }
        ]
        await saveUserLibrary(userLibraryPath(config.artistIndex), library)
        const after = await artistEntries(config)
        return sendJson(res, 200, {
          ok: true,
          id,
          artist: artistViewOf(entryById(after.entries, id), artistEditOf(config, id)),
          status: await statusPayload()
        })
      }

      /**
       * Delete one hand-made artist string.
       *
       * Hand-made ones only. An archive entry is not this plugin's to remove — it
       * exists in a file we only read — and deleting it could only ever mean
       * hiding it from the list, which is a different feature wearing the same
       * word.
       */
      if (method === 'POST' && route === '/artist-remove') {
        const config = await load()
        const body = await readJsonBody(req)
        const id = Number(body.id)
        if (!Number.isInteger(id)) return sendJson(res, 400, { error: 'id must be an integer' })
        const { library, entries } = await artistEntries(config)
        const entry = entryById(entries, id)
        if (entry === undefined) return sendJson(res, 404, { error: 'unknown artist' })
        if (entry.custom !== true) return sendJson(res, 400, { error: 'only artist strings you created can be deleted' })
        library.entries = library.entries.filter((record) => record.id !== id)
        const images = { ...library.images }
        delete images[String(id)]
        library.images = images
        await saveUserLibrary(userLibraryPath(config.artistIndex), library)
        // The file goes with the record; a forgotten image would be a file nothing
        // can ever read again.
        await removeUserImages({ dir: userImageDir(config.artistIndex), id })
        // And the id is forgotten everywhere it was remembered, or the panel and
        // the window would keep naming a style that no longer exists.
        await save(forgetArtist(config, id))
        return sendJson(res, 200, { ok: true, id, status: await statusPayload() })
      }

      /**
       * Attach a reference image to one artist string — archive entry or not.
       *
       * The bytes are the request body and the id is the query string, so a 2 MB
       * image is 2 MB on the wire instead of 2.7 MB of base64 inside JSON. The type
       * is decided by sniffing those bytes and never by the declared header,
       * because the stored type is what every later <img> gets served with.
       */
      if (method === 'POST' && route === '/artist-image') {
        const config = await load()
        const id = Number(url.searchParams.get('id'))
        const { library, entries } = await artistEntries(config)
        const entry = entryById(entries, id)
        if (entry === undefined) return sendJson(res, 404, { error: 'unknown artist' })
        let bytes
        try {
          bytes = await readBinaryBody(req, MAX_ARTIST_IMAGE_BYTES)
        } catch {
          return sendJson(res, 413, { error: `image is larger than ${MAX_ARTIST_IMAGE_BYTES} bytes` })
        }
        if (bytes.length === 0) return sendJson(res, 400, { error: 'send the image as the request body' })
        const mime = sniffImage(bytes)
        if (mime === null) return sendJson(res, 400, { error: 'not an image (png, jpeg, webp or gif)' })
        const stored = await writeUserImage({ dir: userImageDir(config.artistIndex), id, mime, bytes })
        const images = { ...library.images }
        images[String(id)] = stored
        library.images = images
        await saveUserLibrary(userLibraryPath(config.artistIndex), library)
        const after = await artistEntries(config)
        return sendJson(res, 200, {
          ok: true,
          id,
          image: { file: stored.file, mime: stored.mime, bytes: stored.bytes },
          artist: artistViewOf(entryById(after.entries, id), artistEditOf(config, id)),
          status: await statusPayload()
        })
      }

      /**
       * Drop an uploaded reference image, putting the archive's own back.
       */
      if (method === 'DELETE' && route === '/artist-image') {
        const config = await load()
        const id = Number(url.searchParams.get('id'))
        const { library, entries } = await artistEntries(config)
        const entry = entryById(entries, id)
        if (entry === undefined) return sendJson(res, 404, { error: 'unknown artist' })
        if (library.images[String(id)] === undefined) {
          return sendJson(res, 404, { error: 'this entry has no uploaded image' })
        }
        const images = { ...library.images }
        delete images[String(id)]
        library.images = images
        await saveUserLibrary(userLibraryPath(config.artistIndex), library)
        await removeUserImages({ dir: userImageDir(config.artistIndex), id })
        const after = await artistEntries(config)
        return sendJson(res, 200, {
          ok: true,
          id,
          artist: artistViewOf(entryById(after.entries, id), artistEditOf(config, id)),
          status: await statusPayload()
        })
      }

      if (method === 'GET' && route === '/artist-image') {
        const config = await load()
        const { entries, sourceFile } = await artistEntries(config)
        const entry = entryById(entries, url.searchParams.get('id'))
        if (entry === undefined) return sendJson(res, 404, { error: 'unknown artist' })
        // An upload is read from its own file; an archive image straight out of the
        // archive, with not one byte copied to disk.
        const image = await readEntryImage({ config, sourceFile, entry })
        if (image === null) return sendJson(res, 404, { error: 'this entry has no reference image' })
        res.writeHead(200, {
          'Content-Type': image.mime,
          // An upload is the one that can change, so it is cached for a minute and
          // the archive's own for a day — re-decoding a 1.7 MB payload per scroll
          // is the cost being avoided, not a correctness claim.
          'Cache-Control': entry.imageSource === 'upload' ? 'private, max-age=60' : 'private, max-age=86400',
          'Content-Length': image.bytes.length
        })
        return res.end(image.bytes)
      }

      if (method === 'GET' && route === '/gallery') {
        const config = await load()
        const outputDir = await outputDirOf(config)
        const limit = Number(url.searchParams.get('limit')) || 60
        return sendJson(res, 200, { outputDir, files: await gallery(outputDir, limit) })
      }

      if (method === 'GET' && route === '/file') {
        const config = await load()
        const outputDir = await outputDirOf(config)
        const file = safeJoin(outputDir, url.searchParams.get('name'))
        const bytes = await readFile(file)
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Cache-Control': 'no-store',
          'Content-Length': bytes.length
        })
        return res.end(bytes)
      }

      if (method === 'POST' && route === '/probe') {
        return sendJson(res, 200, await probeNow())
      }

      if (method === 'POST' && route === '/generate') {
        const body = await readJsonBody(req)
        const { files, request, weight, concurrency } = await renderNow({
          prompt: body.prompt,
          negativePrompt: body.negativePrompt,
          width: body.width,
          height: body.height,
          steps: body.steps,
          seed: body.seed,
          nSamples: body.nSamples
        })
        // The pictures only exist in the DOM this render was pasted into, so a reopened
        // conversation finds the block bare and the files unclaimed. `key` is the client's own
        // digest of the prompt; recording it is what lets that block fill itself back in later
        // without a second render.
        await rememberRender(body.key, body.prompt, files).catch(() => {})
        return sendJson(res, 200, { ok: true, files, request, weight, concurrency })
      }

      if (method === 'POST' && route === '/rendered') {
        const body = await readJsonBody(req)
        const asked = Array.isArray(body.keys) ? body.keys : []
        // A block whose digest this index has never seen still names its picture in words. That
        // is what a render from before the index, or from another browser, has to be found by.
        const texts =
          body.texts !== null && typeof body.texts === 'object' && !Array.isArray(body.texts)
            ? body.texts
            : null
        let renders = await lookupRendersFor(asked, texts)
        // Pictures rendered before this index existed are still on disk, with the prompt that
        // made them inside the PNG. One pass over the output directory claims them, so opening
        // an old conversation fills in too — but only when a block actually asks, and only once.
        if (Object.keys(renders).length < asked.length && backfillTried !== true) {
          backfillTried = true
          const config = await load()
          const added = await backfillRenders(await outputDirOf(config)).catch(() => 0)
          if (added > 0) {
            keepDiag({ at: Date.now(), event: 'backfill', added })
            renders = await lookupRendersFor(asked, texts)
          }
        }
        return sendJson(res, 200, { renders })
      }

      if (method === 'GET' && route === '/rendered') {
        const keys = (url.searchParams.get('keys') ?? '').split(',')
        return sendJson(res, 200, { renders: await lookupRenders(keys) })
      }

      if (method === 'GET' && route === '/diag') {
        return sendJson(res, 200, {
          startedAt: Date.now() - Math.round(process.uptime() * 1000),
          count: diagLog.length,
          entries: [...diagLog].reverse()
        })
      }

      if (method === 'POST' && route === '/diag') {
        const body = await readJsonBody(req)
        keepDiag(body)
        return sendJson(res, 200, { ok: true, count: diagLog.length })
      }

      return sendJson(res, 404, { error: `unknown route ${method} ${route}` })
    } catch (error) {
      sendJson(res, 400, { error: error?.message ?? String(error) })
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler }), `${ROW_ID}: api`)
}

