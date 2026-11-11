/**
 * dsh-nai-imagegen — configuration.
 *
 * One JSON document under `$DSH_HOME/nai-imagegen/config.json`, written through
 * a temp file so a crash cannot leave a half-written document behind. The
 * token may also arrive from the `NAI_TOKEN` environment variable, which wins
 * over the file so a shell export can override a stale stored value without
 * editing anything.
 *
 * Nothing in this module talks to the network.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** Profile row id; also the state directory name under DSH home. */
export const ROW_ID = 'nai-imagegen'
/** DSH home: the desktop app sets DSH_HOME; the fallback matches the runtime. */
export const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
/** This plugin's state directory. */
export const STATE_DIR = join(HOME, ROW_ID)
/** The configuration document. */
export const CONFIG_FILE = join(STATE_DIR, 'config.json')
/**
 * Which files each prompt produced.
 *
 * A transcript is rebuilt every time a conversation is opened, and the pictures a reply rendered
 * live only in the DOM it was built from. This index is what lets those pictures come back
 * without spending a request: prompt digest in, file names out.
 */
export const RENDERS_FILE = join(STATE_DIR, 'renders.json')

/** The five attachment libraries this plugin can search, in lookup order. */
export const LIBRARIES = ['标签库9.5', '常规模板5.25', '扩展库5.4', '同人库8.5', 'SEX模板9.2']

/**
 * Generation aspect ratios.
 *
 * Picking a ratio is the usual intent and typing two raw numbers is the rare one, so
 * the ratio is the control and the numbers are what it fills in.
 *
 * Every entry stays inside the free band — area at or under 1024x1024 — so none of
 * them spends Anlas on an Opus subscription, and every side is a multiple of 64,
 * which is what the API snaps to anyway.
 */
export const RATIOS = [
  { key: '2:3', label: '2:3 竖版', width: 832, height: 1216 },
  { key: '1:1', label: '1:1 方形', width: 1024, height: 1024 },
  { key: '3:2', label: '3:2 横版', width: 1216, height: 832 },
  { key: '9:16', label: '9:16 长竖', width: 768, height: 1344 },
  { key: '16:9', label: '16:9 宽屏', width: 1344, height: 768 },
  { key: '3:4', label: '3:4 竖四三', width: 896, height: 1152 },
  { key: '4:3', label: '4:3 横三四', width: 1152, height: 896 }
]

/**
 * Which named ratio a size is, if it is one.
 *
 * A size is allowed to be hand-typed, so this returns `null` rather than the nearest
 * match: reporting "2:3" for a size that is not 2:3 would be a quiet lie.
 *
 * @param width - the width in pixels.
 * @param height - the height in pixels.
 * @returns the ratio key, or null when the size is not one of the presets.
 */
export function ratioOf(width, height) {
  const w = Number(width)
  const h = Number(height)
  const match = RATIOS.find((row) => row.width === w && row.height === h)
  return match === undefined ? null : match.key
}

/** The two render modes. `auto` picks one of these per input. */
export const MODE_NAMES = ['illustration', 'comic']

/**
 * The fields a mode may override, with the type each must end up as.
 *
 * Declared once so the normaliser, the host's resolution and the panel all agree
 * on the same set — a new override added in one place would otherwise be silently
 * dropped by the other two.
 */
export const MODE_FIELDS = {
  artistId: 'number',
  width: 'number',
  height: 'number',
  steps: 'number',
  scale: 'number',
  ucPreset: 'number',
  maxImagesPerCall: 'number',
  model: 'string',
  sampler: 'string',
  negativePrompt: 'string'
}

/**
 * Longest artist-string edit that is stored.
 *
 * Archive entries run a few hundred characters. The cap exists so that a stray
 * paste cannot turn the config file into a prompt dump — it is not a judgement on
 * anyone's style, and 20 000 characters is far past any style guide.
 */
export const MAX_ARTIST_EDIT_CHARS = 20000

/**
 * Shipped defaults. `outputDir` and `libraryDir` are intentionally relative-ish
 * placeholders the first `nai_status` call reports so the panel can point the
 * user at them; neither is created until an image is actually written.
 */
export function defaults() {
  return {
    baseUrl: 'https://image.novelai.net',
    token: '',
    /**
     * The current model id. V5 is what the accompanying libraries target and
     * what the official client sends.
     *
     * Known-good ids: `nai-diffusion-5-full`, `nai-diffusion-4-5-full`,
     * `nai-diffusion-4-full`, `nai-diffusion-3`. What is established from real
     * output is the *host*, not the id: generation must go to
     * `image.novelai.net`, because the retired `api.novelai.net` rejects the
     * request with `400 model must be a valid enum value` — which reads like a
     * bad model id but is a stale host. Real PNGs on this machine carry
     * `Source: NovelAI Diffusion V4.5` and `NovelAI Diffusion V4`, so those ids
     * are live; do not treat 4.5 as invalid.
     */
    model: 'nai-diffusion-5-full',
    width: 832,
    height: 1216,
    steps: 28,
    scale: 5,
    sampler: 'k_euler_ancestral',
    /** Matches the official web client's default for V5. */
    ucPreset: 3,
    /**
     * Empty on purpose: this deployment does not want a built-in negative.
     * The only negative that reaches NovelAI is what the author writes in
     * `Scene UC:` / `CharN UC:` (plus the server-side `ucPreset` merge).
     */
    negativePrompt: '',
    /** Where generated PNGs land; the Agent embeds these paths in its reply. */
    outputDir: join(process.cwd(), '_out', 'nai'),
    /** Directory holding `<库名>.jsonl` indexes built by `nai_index`. */
    libraryDir: join(process.env.USERPROFILE || homedir(), 'Downloads', '文生图用', '_pyrite-extract'),
    /** Where `nai_index` reads the original world-book JSONs from. */
    librarySourceDir: join(process.env.USERPROFILE || homedir(), 'Downloads', '文生图用'),
    /** Billing guard: refuse a single call that would render more than this. */
    maxImagesPerCall: 4,
    /**
     * How to reach NovelAI.
     *
     *   `''` or `auto`  — use the Windows system proxy when one is detected
     *   `off`/`none`    — force a direct connection
     *   anything else   — used verbatim as the proxy URL
     *
     * The system proxy is honoured on purpose: Node's `fetch` ignores it, and a
     * machine that needs a proxy has usually enabled exactly that setting.
     */
    proxy: '',
    /**
     * Additional API keys, each `{ label, token, enabled }`.
     *
     * The pool dispatches one request per usable key, so four keys render four
     * images at once. The single `token` above stays supported and becomes the
     * first key, so an existing config keeps working.
     */
    keys: [],
    /** Where the artist index lives; written by `import-artists.mjs`. */
    artistIndex: join(STATE_DIR, 'artists', 'index.json'),
    /** Optional override for the archive path recorded inside the index. */
    artistSource: '',
    /**
     * Which artist string is in force, as an index into the artist archive.
     * `-1` means none.
     *
     * A number rather than a nullable id on purpose: `normalize` coerces by
     * `typeof`, and `typeof null` is `'object'`, which would turn a null into the
     * string `"null"`.
     */
    artistId: -1,
    /**
     * Edits to the artist strings themselves, keyed by archive id.
     *
     * Kept here rather than written back into the archive for two reasons: the
     * archive is imported source material that a re-import would overwrite, and an
     * edit has to apply wherever that id is selected. The panel picks one id for
     * the whole plugin, the floating window picks one per mode, and the same id has
     * to read the same either way — so the edit is attached to the *entry*, not to
     * whoever happens to have it selected.
     *
     * Shape: `{ "95": { positive: "...", negative: "..." } }`. A missing side falls
     * back to the archive text, and a missing id means the archive text verbatim.
     */
    artistEdits: {},
    /**
     * The artist ids the user starred, so the quick picks lead the list.
     *
     * Stored by id beside the archive for the same reason an edit is: the archive is
     * imported source material, and a star written into it would be thrown away by the
     * next import. Ids only — a name would have to be matched again on every import,
     * and two entries may share one.
     *
     * Sorted and deduped when loaded. An id the archive no longer has is kept in the
     * file rather than pruned from it: the archive can come back with a re-import, and
     * silently losing a star is worse than carrying one that resolves to nothing today.
     * What the grid and the window show is always the resolvable subset, so a dead id
     * never turns into a ★ with nothing behind it.
     */
    artistFavorites: [],
    /**
     * Which page formats the render path accepts.
     *
     *   `auto`         — recognise each input on its own (default): a
     *                    `nai5-comic` page, an `<image>` block, or a plain prompt
     *   `comic`        — read a comic page first
     *   `illustration` — never read a comic page; only the 插画 formats
     *
     * `auto` keeps both working without the user having to remember which mode
     * they are in; the explicit values let either be forced, and neither path
     * touches the other's parameters.
     */
    mode: 'auto',
    /**
     * How large a generated image is drawn in the transcript, as a percentage of
     * the column width. A 832x1216 page at 100% fills the whole column and pushes
     * the conversation off-screen, so the default is 60 — a page you can see whole
     * while it is still big enough to judge.
     */
    displayWidth: 60,
    /**
     * Cap on the drawn height in pixels, `0` for none.
     *
     * Width alone is not enough for a portrait page: 100% wide and 1216 tall is
     * taller than most viewports. A height cap keeps the whole page on screen.
     */
    displayMaxHeight: 0,
    /**
     * Whether a click on a generated image enlarges it in place.
     *
     * On by default: a portrait page is taller than most viewports, so being able to
     * pop one open is worth the click.
     */
    displayClickZoom: true,
    /**
     * Origin used for inline image links, e.g. `http://127.0.0.1:19387`.
     *
     * Empty (the default) means "work it out": the harness's `DSH_WEB_URL`, then
     * the `Host` of the last panel request. Set it only to override — the link is
     * baked into the transcript when the render happens, so a pinned origin is
     * what keeps old conversations drawable if that port ever moves.
     */
    webBase: '',
    /**
     * Per-mode overrides for the settings that differ between 出图 and 漫画.
     *
     * Each entry may carry `artistId`, `width`, `height`, `steps`, `model`,
     * `sampler`, `scale`, `ucPreset`, `negativePrompt` and `maxImagesPerCall`.
     * Anything absent falls back to the value above, so the shared defaults keep
     * working and only the differences have to be stated.
     *
     * The style matters most: a comic page and a single illustration rarely want
     * the same artist string, and sharing one meant every comic page silently
     * carried the illustration's style. `mode: 'auto'` decides which set applies
     * per render by which format the input turns out to be.
     */
    modes: { illustration: {}, comic: {} },
    /**
     * Render prompt code blocks in the transcript automatically instead of
     * waiting for a click. Off by default: it spends quota without being asked.
     */
    autoGenerate: false,
    /**
     * Have the model hand the reply over as a tool call instead of ordinary message text.
     *
     * On by default, because that is the whole point of the reply tool: the words travel as an
     * argument of the call, and the browser half reads them from the call itself. Switch it off
     * for a model or a wire that will not call the tool — an uncalled transport is a reply that
     * never arrives, and the ordinary text channel is what is left when it does not.
     */
    replyTransport: true,
    /** Keep the newest N images on disk; `0` disables trimming. */
    keepImages: 500
  }
}

/** Cached document; `null` until the first read. */
let cache = null

/**
 * Coerce one loaded document over the shipped defaults, so a config written by
 * an older version still produces a complete object.
 * @param raw - whatever was on disk.
 * @returns a complete configuration.
 */
function normalize(raw) {
  const base = defaults()
  if (raw === null || typeof raw !== 'object') return base
  const out = { ...base }
  for (const key of Object.keys(base)) {
    const value = raw[key]
    if (value === undefined || value === null) continue
    // The starred ids are a flat list of numbers, and they have to be read *before* the
    // key-pool branch below: that one maps every array into `{label, token, enabled}`,
    // so a star list would come back as an empty pool — written, reported as written,
    // and gone by the next load.
    if (key === 'artistFavorites') {
      const ids = new Set()
      for (const raw of Array.isArray(value) ? value : []) {
        // `null` would otherwise coerce to 0 and star the first entry in the archive,
        // which is a stranger's style picked by a typo.
        if (raw === null || raw === undefined || raw === '') continue
        const id = Number(raw)
        if (Number.isInteger(id) && id >= 0) ids.add(id)
      }
      out[key] = [...ids].sort((a, b) => a - b)
      continue
    }
    // Arrays must be handled before the string branch: `typeof []` is 'object',
    // so a naive coercion would turn the key list into "[object Object],…".
    if (Array.isArray(base[key])) {
      if (!Array.isArray(value)) continue
      out[key] = value
        .map((entry) => {
          if (typeof entry === 'string') return { label: '', token: entry.trim(), enabled: true }
          if (entry === null || typeof entry !== 'object') return null
          const token = String(entry.token ?? '').trim()
          if (token === '') return null
          const row = { label: String(entry.label ?? ''), token, enabled: entry.enabled !== false }
          // The id has to survive normalisation. Dropping it here (this branch
          // used to rebuild entries as label/token/enabled only) means every
          // `save` hands the panel a fresh id, so an enable, disable or remove
          // addresses a key that no longer exists and silently does nothing.
          if (typeof entry.id === 'string' && entry.id !== '') row.id = entry.id
          return row
        })
        .filter((entry) => entry !== null)
      continue
    }
    // The artist edits are an id-keyed map of two strings, and they have to be
    // handled *before* the mode-override branch below: that branch reads every key
    // as a mode name, so it would throw away every edit and the panel would report
    // a save that did not survive the next load.
    if (key === 'artistEdits') {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
      const edits = {}
      for (const [id, edit] of Object.entries(value)) {
        if (!/^\d+$/.test(id)) continue
        if (edit === null || typeof edit !== 'object' || Array.isArray(edit)) continue
        const row = {}
        for (const side of ['positive', 'negative']) {
          const text = edit[side]
          if (text === undefined || text === null) continue
          row[side] = String(text).slice(0, MAX_ARTIST_EDIT_CHARS)
        }
        if (Object.keys(row).length > 0) edits[id] = row
      }
      out[key] = edits
      continue
    }
    // A plain object of settings — the per-mode overrides. Handled before the
    // string branch for the same reason arrays are: `typeof {}` is 'object', and
    // `String({})` would turn the whole block into "[object Object]".
    if (base[key] !== null && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
      const clean = {}
      for (const [mode, overrides] of Object.entries(value)) {
        if (!MODE_NAMES.includes(mode) || overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) continue
        const row = {}
        for (const [field, kind] of Object.entries(MODE_FIELDS)) {
          const incoming = overrides[field]
          if (incoming === undefined || incoming === null) continue
          if (kind === 'number') {
            const n = Number(incoming)
            if (Number.isFinite(n)) row[field] = n
            continue
          }
          row[field] = String(incoming)
        }
        // The comic recipe is a nested map of group → option key. Copied as plain
        // strings; which options are real is decided by the recipe table at use
        // time, so a stale key is ignored rather than crashing a load.
        const recipe = overrides.recipe
        if (recipe !== null && typeof recipe === 'object' && !Array.isArray(recipe)) {
          const kept = {}
          for (const [group, value] of Object.entries(recipe)) {
            if (typeof value === 'string' && value !== '') kept[group] = value
          }
          if (Object.keys(kept).length > 0) row.recipe = kept
        }
        clean[mode] = row
      }
      out[key] = clean
      continue
    }
    if (typeof base[key] === 'number') {
      const n = Number(value)
      if (Number.isFinite(n)) out[key] = n
      continue
    }
    // Booleans need their own branch. Falling through to `String(value)` turns
    // `true` into `"true"`, and every downstream check is a strict `=== true`,
    // so the setting would read as off no matter what the panel saved.
    if (typeof base[key] === 'boolean') {
      out[key] = value === true || value === 'true' || value === 1 || value === '1'
      continue
    }
    out[key] = String(value)
  }
  return out
}

/**
 * Read the configuration once per process.
 * @returns the effective configuration.
 */
export async function load() {
  if (cache !== null) return cache
  try {
    cache = normalize(JSON.parse(await readFile(CONFIG_FILE, 'utf8')))
  } catch {
    cache = defaults()
  }
  return cache
}

/**
 * Merge a partial update into the configuration and persist it.
 * @param patch - fields to replace; unknown keys are ignored.
 * @returns the stored configuration.
 */
export async function save(patch) {
  const current = await load()
  const next = normalize({ ...current, ...(patch ?? {}) })
  cache = next
  await mkdir(dirname(CONFIG_FILE), { recursive: true })
  const temp = `${CONFIG_FILE}.tmp`
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  await rename(temp, CONFIG_FILE)
  return next
}

/**
 * The token actually in force: environment first, then the stored value.
 * @param config - an already loaded configuration, if the caller has one.
 * @returns the bearer token, or an empty string.
 */
export async function tokenOf(config) {
  const env = (process.env.NAI_TOKEN || '').trim()
  if (env) return env
  const held = config ?? (await load())
  return String(held.token || '').trim()
}

/**
 * Resolve the output directory to an absolute path.
 * @param config - an already loaded configuration, if the caller has one.
 * @returns the absolute output directory.
 */
export async function outputDirOf(config) {
  const held = config ?? (await load())
  return resolve(held.outputDir)
}
