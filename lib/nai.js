/**
 * dsh-nai-imagegen — NovelAI image API client.
 *
 * Deliberately dependency-free: the only imports are Node built-ins, so this
 * package installs by `link:` with nothing to fetch and nothing to build.
 *
 * The request body below is aligned field-for-field with a measured V5
 * contract rather than with guesswork, because the failure modes here are
 * expensive and unintuitive:
 *
 *   - `nai-diffusion-5-full` is the current model id and the default. Do not
 *     conclude that the older `nai-diffusion-4-5-full` is invalid: real output
 *     on this machine names `NovelAI Diffusion V4.5` as its source. What the
 *     measurements do establish is the **host** — posting to the retired
 *     `api.novelai.net` returns `400 model must be a valid enum value`, which
 *     reads like a bad model id but is a stale endpoint.
 *   - V5 **requires** both `v4_prompt` and `v4_negative_prompt`. Omitting either
 *     returns `500 Internal Server Error`, not a validation 400 — so it reads
 *     like an outage while the cause is the body.
 *   - The prompt travels in three places at once: top level `input`,
 *     `parameters.prompt`, and `v4_prompt.caption.base_caption`.
 *   - `params_version` is ignored by this skeleton (4/3/1/0 render identical
 *     pixels); we send 4 to match the official web client.
 *   - `Content-Type: application/json` must be set explicitly when posting JSON;
 *     Node's `fetch` builds the multipart boundary itself, so hand-setting it on
 *     a `FormData` body breaks the request.
 *   - The official response is a zip (`image_0.png` inside) delivered as
 *     `binary/octet-stream`. Proxy/relay deployments sometimes answer with JSON
 *     holding base64 instead, so both are decoded here.
 *
 * Failure handling, including why there is no automatic retry: see
 * `GENERATE_PATH` and `generate()` below.
 */
import { inflateRawSync, inflateSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { httpRequest, resolveProxy } from './net.js'
import { normalizeSubscription } from './quota.js'

/** Path appended to a bare base URL. */
const GENERATE_PATH = '/ai/generate-image'
/** Subscription/balance lookup; used by `probe` to validate a token for free. */
const SUBSCRIPTION_PATH = '/user/subscription'

/** Locally deflate-compressed ZIP members. */
const METHOD_DEFLATE = 8
/** Stored (uncompressed) ZIP members. */
const METHOD_STORE = 0

/** Image extensions a NovelAI archive may carry. */
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp']

/**
 * Expand a ZIP archive into its members.
 *
 * Only what a NovelAI response needs is supported: no encryption, no ZIP64 and
 * no data descriptors. Anything else throws rather than returning a truncated
 * image.
 *
 * @param buf - the whole archive.
 * @returns one `{ name, data }` entry per member, in central-directory order.
 */
export function unzip(buf) {
  // The end-of-central-directory record is last, optionally followed by a
  // comment, so search backwards within the largest legal comment window.
  let eocd = -1
  const floor = Math.max(0, buf.length - 22 - 0xffff)
  for (let i = buf.length - 22; i >= floor; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('response is not a zip archive: no end-of-central-directory record')

  const count = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  const entries = []

  for (let n = 0; n < count; n += 1) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`malformed zip: central directory entry ${n} is unreadable`)
    }
    const method = buf.readUInt16LE(offset + 10)
    const compressedSize = buf.readUInt32LE(offset + 20)
    const uncompressedSize = buf.readUInt32LE(offset + 24)
    const nameLength = buf.readUInt16LE(offset + 28)
    const extraLength = buf.readUInt16LE(offset + 30)
    const commentLength = buf.readUInt16LE(offset + 32)
    const localOffset = buf.readUInt32LE(offset + 42)
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLength)

    if (buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`malformed zip: local header for ${name} is unreadable`)
    }
    const localNameLength = buf.readUInt16LE(localOffset + 26)
    const localExtraLength = buf.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localNameLength + localExtraLength
    const raw = buf.subarray(start, start + compressedSize)

    let data
    if (method === METHOD_STORE) data = Buffer.from(raw)
    else if (method === METHOD_DEFLATE) data = inflateRawSync(raw)
    else throw new Error(`unsupported zip compression method ${method} in ${name}`)

    if (uncompressedSize !== 0 && data.length !== uncompressedSize) {
      throw new Error(`zip member ${name} expanded to ${data.length} bytes, expected ${uncompressedSize}`)
    }
    entries.push({ name, data })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/**
 * Snap a requested size into the supported range and to a multiple of 64,
 * which is what the NovelAI image models accept.
 * @param value - requested pixels on one axis.
 * @param fallback - value used when the request is absent or unusable.
 * @returns a legal axis length.
 */
export function legalAxis(value, fallback) {
  const n = Number(value)
  const base = Number.isFinite(n) && n > 0 ? n : fallback
  const snapped = Math.round(base / 64) * 64
  return Math.min(2048, Math.max(64, snapped))
}

/**
 * The pixel product an Opus subscription renders without spending Anlas:
 * one image, no base image, and at or below this area.
 *
 * 1024x1024 and both 832x1216 orientations land inside it; anything larger is
 * billed.
 */
export const FREE_AREA = 1024 * 1024

/**
 * How heavy one request is relative to the reference render (832x1216 at 28
 * steps). This is a shape-only weight, not a price: NovelAI bills an Opus
 * subscription nothing inside the free band and something above it, so the
 * number is reported as a relative cost the caller can reason about.
 * @param size - width, height, steps and sample count.
 * @returns the relative weight, rounded to two decimals.
 */
export function costWeight({ width, height, steps, nSamples = 1 }) {
  const referenceArea = 832 * 1216
  const area = Math.max(1, width) * Math.max(1, height)
  const stepFactor = Math.max(1, steps) / 28
  return Math.round((area / referenceArea) * stepFactor * Math.max(1, nSamples) * 100) / 100
}

/**
 * Whether a request should fall inside the Opus free band.
 * @param size - width, height, steps and sample count.
 * @returns true when no Anlas should be spent.
 */
export function insideFreeBand({ width, height, steps, nSamples = 1 }) {
  return width * height <= FREE_AREA && steps <= 28 && nSamples <= 1
}

/**
 * Build the generation URL from whatever the user put in `baseUrl`.
 *
 * Three shapes have to work, because all three appear in the wild and pasting
 * one into the other's field is the normal mistake: a bare origin, an origin
 * ending in `/ai`, and a full endpoint URL copied from a proxy's docs.
 *
 * @param baseUrl - the configured base.
 * @returns the absolute generate-image URL.
 */
export function resolveGenerateUrl(baseUrl) {
  const trimmed = String(baseUrl ?? '').trim().replace(/\/+$/, '')
  if (trimmed === '') throw new Error('baseUrl is empty')
  if (/\/ai\/generate-image$/i.test(trimmed)) return trimmed
  if (/\/ai$/i.test(trimmed)) return `${trimmed}/generate-image`
  return `${trimmed}${GENERATE_PATH}`
}

/**
 * The origin of the configured base, for the free subscription probe.
 * @param baseUrl - the configured base.
 * @returns `scheme://host`.
 */
export function resolveOrigin(baseUrl) {
  try {
    return new URL(String(baseUrl ?? '').trim()).origin
  } catch {
    throw new Error(`baseUrl is not a URL: ${baseUrl}`)
  }
}

/**
 * Parse the two registry values that describe the Windows system proxy.
 *
 * Split out from the query itself so the parsing is testable without touching
 * the registry.
 *
 * @param text - the output of `reg query …Internet Settings`.
 * @returns the proxy URL, or `null` when no proxy is enabled.
 */
export function parseRegProxy(text) {
  const enabled = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(text)
  if (enabled === null || Number.parseInt(enabled[1], 16) === 0) return null
  const server = /ProxyServer\s+REG_SZ\s+(.+)/i.exec(text)
  if (server === null) return null
  const value = server[1].trim()
  if (value === '') return null
  // A bare `host:port` is what the registry usually holds.
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`
}

/** Last system-proxy reading, and when it was taken. */
let proxyCache = null
let proxyCacheAt = 0
/** How long a reading stays good. The registry lookup spawns a process. */
const PROXY_TTL_MS = 5000

/**
 * Read the Windows system proxy, if one is enabled.
 *
 * Cached briefly on purpose: this spawns `reg.exe` (about 60 ms), and it sits on
 * both the status path — which calls it twice — and the render path, where every
 * parallel job asks for it. Five seconds is far shorter than any human notices a
 * proxy change and far longer than a burst of requests.
 *
 * @param options - `{ fresh: true }` bypasses the cache.
 * @returns the proxy URL, or `null`.
 */
export function systemProxy(options = {}) {
  if (process.platform !== 'win32') return null
  const now = Date.now()
  if (options.fresh !== true && now - proxyCacheAt < PROXY_TTL_MS) return proxyCache
  try {
    const text = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { encoding: 'utf8', windowsHide: true, timeout: 4000 }
    )
    proxyCache = parseRegProxy(text)
  } catch {
    proxyCache = null
  }
  proxyCacheAt = now
  return proxyCache
}

/**
 * Explain why a connection failed, in terms of the setting the user actually has.
 *
 * This used to be the whole story — "set NODE_USE_ENV_PROXY and HTTPS_PROXY
 * before launching DSH" — because `fetch` cannot be told about a proxy at
 * runtime. Requests now tunnel through `lib/net.js`, so the system proxy works
 * without any launch-time flag, and this reports which proxy was actually
 * applied plus what to change when none was.
 *
 * @param activeProxy - the proxy the failed request used, if any.
 * @returns a one-line diagnosis.
 */
export function proxyHint(activeProxy = null) {
  const detected = systemProxy()
  const parts = []
  if (activeProxy !== null) {
    parts.push(`本次请求经代理 ${activeProxy} 发出`)
    parts.push('代理可能拒绝连接，或其分流规则没有覆盖 image.novelai.net')
  } else if (detected !== null) {
    parts.push(`检测到 Windows 系统代理 ${detected}，但配置里 proxy 设成了关闭`)
    parts.push('把 proxy 留空或填 auto 即会重新使用系统代理')
  } else {
    parts.push('既没有检测到系统代理，也没有配置 proxy')
    parts.push('需要代理时在面板的 proxy 填地址（例如 http://127.0.0.1:7890）；留空即自动使用系统代理')
  }
  return parts.join('；')
}

/**
 * Resolve the proxy a request should use: the configured value, falling back to
 * the machine's own system proxy.
 * @param config - the loaded configuration, if the caller has one.
 * @returns the proxy URL, or `null` for a direct connection.
 */
export function proxyFor(config) {
  return resolveProxy(config?.proxy, systemProxy())
}

/**
 * Classify a response body so the right decoder is chosen even when the
 * content type lies.
 *
 * Content type alone is not enough: the official endpoint answers
 * `binary/octet-stream` for a zip, and relays answer `text/html` for a JSON
 * error. Magic bytes settle it.
 *
 * @param bytes - the response body.
 * @returns `zip`, `png`, `jpeg`, `webp`, `json` or `unknown`.
 */
export function sniffKind(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) return 'zip'
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'webp'
  }
  for (const byte of bytes) {
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) continue
    return byte === 0x7b || byte === 0x5b ? 'json' : 'unknown'
  }
  return 'unknown'
}

/**
 * Strip a `data:` URL prefix when a relay returns its base64 that way.
 * @param value - the raw string.
 * @returns the bare base64 payload.
 */
export function stripDataUrl(value) {
  const text = String(value ?? '')
  const comma = text.indexOf(',')
  if (text.startsWith('data:') && comma >= 0) return text.slice(comma + 1)
  return text
}

/**
 * Collect base64 image payloads out of a relay's JSON envelope.
 *
 * The shapes accepted are the ones seen in the wild and in the reference
 * implementation: an array of strings, an array of `{ image | base64 | data,
 * seed? }`, an object wrapping any of those under `images` / `data` / `output`,
 * or a single `{ image, seed? }`.
 *
 * @param parsed - the decoded JSON.
 * @returns `{ base64, seed }` rows.
 */
export function normalizeImageItems(parsed) {
  const items = []
  /**
   * Walk one array of candidate entries.
   * @param list - the array to read.
   */
  const readArray = (list) => {
    for (const entry of list) {
      if (typeof entry === 'string') {
        items.push({ base64: entry, seed: null })
        continue
      }
      if (entry !== null && typeof entry === 'object') {
        const payload = entry.image ?? entry.base64 ?? entry.data
        if (typeof payload === 'string') {
          items.push({ base64: payload, seed: typeof entry.seed === 'number' ? entry.seed : null })
        }
      }
    }
  }

  if (Array.isArray(parsed)) readArray(parsed)
  else if (parsed !== null && typeof parsed === 'object') {
    const list = parsed.images ?? parsed.data ?? parsed.output
    if (Array.isArray(list)) readArray(list)
    else if (typeof parsed.image === 'string') {
      items.push({ base64: parsed.image, seed: typeof parsed.seed === 'number' ? parsed.seed : null })
    }
  }
  return items
}

/**
 * Decode a JSON body into image buffers.
 * @param bytes - the response body.
 * @returns the decoded image buffers, in order.
 */
function decodeJsonImages(bytes) {
  const text = bytes.toString('utf8').trim()
  if (text === '') throw new Error('NovelAI answered with an empty JSON body')
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`NovelAI answered with unparseable JSON: ${text.slice(0, 200)}`)
  }
  const items = normalizeImageItems(parsed)
  if (items.length === 0) {
    throw new Error(
      `NovelAI JSON carried no image (expected { images: [{ image, seed? }] } or an array of base64 strings): ${text.slice(0, 200)}`
    )
  }
  return items.map((item) => {
    const buffer = Buffer.from(stripDataUrl(item.base64).replace(/\s+/g, ''), 'base64')
    if (buffer.length === 0) throw new Error('a base64 image payload decoded to zero bytes')
    return buffer
  })
}

/**
 * Turn one response body into image buffers, choosing the decoder by content
 * type and then by what the bytes actually are.
 *
 * @param bytes - the response body.
 * @param contentType - the response's content type, if any.
 * @returns the decoded image buffers.
 */
export function decodeResponse(bytes, contentType) {
  const declared = String(contentType ?? '').toLowerCase()
  if (declared.includes('json')) return decodeJsonImages(bytes)

  const kind = sniffKind(bytes)
  if (kind === 'zip') {
    const images = unzip(bytes)
      .filter((entry) => IMAGE_EXTENSIONS.some((extension) => entry.name.toLowerCase().endsWith(extension)))
      .map((entry) => entry.data)
    if (images.length === 0) throw new Error('NovelAI archive held no image member')
    return images
  }
  if (kind === 'png' || kind === 'jpeg' || kind === 'webp') return [bytes]
  if (kind === 'json') return decodeJsonImages(bytes)

  // Ambiguous: a relay that answered with the wrong content type. Try both, and
  // report both attempts if neither works.
  const failures = []
  try {
    const images = unzip(bytes)
      .filter((entry) => IMAGE_EXTENSIONS.some((extension) => entry.name.toLowerCase().endsWith(extension)))
      .map((entry) => entry.data)
    if (images.length > 0) return images
    failures.push('zip held no image member')
  } catch (error) {
    failures.push(`zip: ${error.message}`)
  }
  try {
    return decodeJsonImages(bytes)
  } catch (error) {
    failures.push(`json: ${error.message}`)
  }
  throw new Error(
    `unrecognized NovelAI response (content-type ${declared || 'unknown'}, ${bytes.length} bytes) — ${failures.join('; ')}`
  )
}

/**
 * Assemble the request body for the current NovelAI models.
 *
 * Field-for-field the shape a measured V5 call accepts; see the module comment
 * for which omissions turn into a 500 rather than a 400.
 *
 * @param options - prompt, negative prompt, model and sampling parameters.
 * @returns the JSON-serializable request body.
 */
/**
 * Convert a 5×5 grid cell to a normalised centre point.
 *
 * NovelAI's own grid runs A–E left to right and 1–5 top to bottom, so A1 is the
 * top-left corner and C3 is the middle. The API takes a normalised point, and each
 * cell becomes the centre of its square: A→0.1 … E→0.9, 1→0.1 … 5→0.9.
 *
 * @param cell - a cell such as `B3`. `auto` and anything unparseable yield null.
 * @returns the point, or null.
 */
function cellToPoint(cell) {
  const match = /^([A-Ea-e])\s*([1-5])$/.exec(String(cell ?? '').trim())
  if (match === null) return null
  return {
    x: Number(((match[1].toUpperCase().charCodeAt(0) - 65) * 0.2 + 0.1).toFixed(2)),
    y: Number(((Number(match[2]) - 1) * 0.2 + 0.1).toFixed(2))
  }
}

/**
 * Map a character's grid cells to the API's coordinates list.
 *
 * Never returns an empty list. The API rejects a `char_captions` row whose
 * `centers` is empty with a bare `500 {"statusCode":500,"message":"Internal
 * Server Error"}` — whichever way the `use_coords` flags are set, and whether the
 * field is empty or absent. All of that was established by probing the live API.
 *
 * So a character with no usable cell — `auto`, a missing marker, or a cell off the
 * grid — is placed at the centre. That is the only neutral point available, and it
 * keeps the per-character split (and with it the per-character `UC`) working,
 * where dropping the split for one missing marker would silently lose it.
 *
 * @param cells - cell strings such as `['B3']`.
 * @returns the coordinates; always at least one point.
 */
function cellListToCenters(cells) {
  return (Array.isArray(cells) ? cells : [])
    .map((entry) => {
      // A comic page's `center` is already normalised to the canvas, so it passes
      // through; an illustration's `|centers:B3` is a grid cell and is mapped.
      if (entry !== null && typeof entry === 'object') {
        const x = Number(entry.x)
        const y = Number(entry.y)
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null
        return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) }
      }
      return cellToPoint(entry)
    })
    .filter((point) => point !== null)
}

/**
 * The coordinates one caption will carry — never an empty list.
 *
 * An empty `centers` array is a documented cause of **HTTP 500** from the V4/V5
 * endpoint rather than a 400, so it must not reach the wire even when nothing was
 * placed. `use_coords` is what actually says "arrange it yourself": a point sent
 * under `use_coords: false` is inert, so always supplying one costs nothing and
 * removes a shape that has already produced a 500 against the live API.
 *
 * @param row - a character row, with `centers` possibly empty.
 * @returns at least one point.
 */
function centersFor(row) {
  const placed = cellListToCenters(row.centers)
  return placed.length > 0 ? placed : [{ x: 0.5, y: 0.5 }]
}

export function buildPayload(options) {
  const {
    prompt,
    negativePrompt = '',
    model,
    width,
    height,
    steps,
    scale,
    sampler,
    seed,
    nSamples = 1,
    ucPreset = 3,
    /**
     * Per-character captions from an `<image>` block:
     * `[{ positive, negative, centers: ['B3'] }]`.
     */
    characters = [],
    /** The scene-only positive, used as the base caption when characters split out. */
    sceneCaption = null,
    /** The scene-only negative, likewise. */
    sceneNegative = null
  } = options

  // V4 and V5 share the structured-caption requirement; V3 predates it and must
  // not receive the v4 blocks.
  const modern = /^nai-diffusion-[45]/.test(String(model))
  const pinned = Number.isFinite(seed) && seed > 0 ? Math.floor(seed) : null

  // A block that gave its characters separate captions also gave them separate
  // exclusions, and the legacy `negative_prompt` is the *picture-wide* one. So
  // when characters are split out, this field carries the scene negative alone.
  //
  // Pooling every `Char1 UC:` / `Char2 UC:` into it goes wrong twice over: each
  // character's exclusions get re-applied to the whole picture — so a `twin
  // braids` ban aimed at one girl suppresses it on the other girl too, which is
  // exactly what per-character captions exist to prevent — and the text lands in
  // the metadata twice, because NovelAI's reader shows this field next to the v4
  // captions and the duplicate reads as unexplained "carry-along" noise.
  const splitting = characters.some((row) => String(row.positive ?? '').trim() !== '')
  const pictureNegative = splitting ? String(sceneNegative ?? negativePrompt) : negativePrompt

  const parameters = {
    width,
    height,
    scale,
    sampler,
    steps,
    n_samples: nSamples,
    ucPreset,
    qualityToggle: false,
    sm: false,
    sm_dyn: false,
    dynamic_thresholding: false,
    controlnet_strength: 1,
    legacy: false,
    add_original_image: false,
    cfg_rescale: 0,
    noise_schedule: 'karras',
    legacy_v3_extend: false,
    uncond_scale: 1,
    negative_prompt: pictureNegative
  }
  if (pinned !== null) {
    parameters.seed = pinned
    parameters.extra_noise_seed = pinned
  }

  if (modern) {
    parameters.params_version = 4
    // The prompt rides in three places at once; all three are set.
    parameters.prompt = prompt
    parameters.reference_image_multiple = []
    parameters.reference_information_extracted_multiple = []
    parameters.reference_strength_multiple = []

    // NovelAI's character-position feature. Each character gets its own caption
    // and, when the block asked for one, its own point on the 5x5 grid; the base
    // caption then carries the scene alone. This is what makes `Char1 UC:` apply
    // to one character instead of to the whole picture — pooling every UC into one
    // global negative suppresses the other character's features too.
    //
    // The wire shape was confirmed against the API rather than guessed: `centers`
    // must be objects (`image.Coordinates`); strings come back as
    // `cannot unmarshal string into … centers of type image.Coordinates`.
    const split = characters.filter((row) => String(row.positive ?? '').trim() !== '')
    const usingCharacters = split.length > 0
    // Position only when a character actually asked for one. The comic format's
    // `position_mode: auto` means "arrange it yourself", and substituting the
    // canvas centre for every caption would stack every character in the middle.
    // `use_coords: false` is how the API is told to arrange freely.
    const positioned = split.filter((row) => cellListToCenters(row.centers).length > 0)
    const usingCoords = usingCharacters && positioned.length > 0
    parameters.v4_prompt = {
      use_coords: usingCoords,
      use_order: usingCharacters,
      caption: {
        base_caption: usingCharacters ? String(sceneCaption ?? prompt) : prompt,
        char_captions: split.map((row) => ({
          char_caption: row.positive,
          // With coordinates on, the API wants a point per caption; one that gave
          // none gets the canvas centre, which is the least surprising default.
          centers: centersFor(row)
        }))
      }
    }
    parameters.v4_negative_prompt = {
      use_coords: usingCoords,
      use_order: usingCharacters,
      caption: {
        // Same value as the legacy `negative_prompt` above, by construction, so
        // the two can never drift apart into the duplicated shape.
        base_caption: pictureNegative,
        char_captions: usingCharacters
          ? split.map((row) => ({
              char_caption: String(row.negative ?? ''),
              centers: centersFor(row)
            }))
          : []
      }
    }
  } else {
    parameters.params_version = 3
  }

  return { input: prompt, model, action: 'generate', parameters }
}

/**
 * Turn one upstream status into an actionable message.
 *
 * The `429` wording matters: NovelAI's API document states that clients must
 * not retry, so the message tells the user to wait rather than inviting the
 * caller to loop.
 *
 * @param status - the HTTP status.
 * @param detail - the response body, already truncated.
 * @returns the message to raise.
 */
export function describeStatus(status, detail) {
  if (status === 401) {
    return (
      'NovelAI 返回 401 Unauthorized：凭据无效。' +
      '注意 401 无法区分「token 写错」和「没带 Authorization 头」，所以请检查 token 是否完整、' +
      '有没有被首尾空格或换行污染（本插件会 trim，但配置文件里可能保留了别的字符）。'
    )
  }
  if (status === 429) {
    return (
      'NovelAI 返回 429：触发限流。官方 API 文档明确要求客户端不要重试，' +
      '本插件因此不做自动重试——请等一会儿再手动发起。'
    )
  }
  if (status === 500) {
    return (
      'NovelAI 返回 500。这个状态码很可能是**请求体**的问题而不是服务故障：' +
      'V4/V5 模型必须同时带 `v4_prompt` 与 `v4_negative_prompt`，缺任一个都会得到 500 而不是 400。' +
      `原文：${detail || '(空响应体)'}`
    )
  }
  if (status === 400) {
    return (
      `NovelAI 返回 400：请求被拒。常见原因是模型 id 不是有效枚举值（当前应为 nai-diffusion-5-full）` +
      `或接口域名过期（必须用 image.novelai.net，旧的 api.novelai.net 会报 model must be a valid enum value）。原文：${detail || '(空响应体)'}`
    )
  }
  return `NovelAI 返回 ${status}：${detail || '(空响应体)'}`
}

/**
 * Render one request against the NovelAI image endpoint.
 *
 * No automatic retry, on purpose: the official API document tells clients not to
 * retry, and a retried generation may be billed twice when the first attempt
 * actually reached the model but its response was lost. A failure is surfaced
 * with the upstream status so the caller decides.
 *
 * @param options - connection, prompt and sampling parameters, plus an
 *   optional abort signal.
 * @returns the decoded image buffers, in archive order.
 */
export async function generate(options) {
  const { baseUrl, token, signal, proxy = null, ...rest } = options
  if (!token) throw new Error('NovelAI token is not configured; set it in the 侧栏 panel or export NAI_TOKEN')

  const url = resolveGenerateUrl(baseUrl)
  let response
  try {
    response = await httpRequest({
      url,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: '*/*'
      },
      body: JSON.stringify(buildPayload(rest)),
      proxy,
      signal
    })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new Error(`cannot reach NovelAI at ${url}: ${error?.message ?? error}\n提示：${proxyHint(proxy)}`)
  }

  if (response.status < 200 || response.status >= 300) {
    // `statusCode` is what lets the key pool classify a failure — disable a key
    // on 401/403, cool it down on 429/5xx and retry elsewhere. Without it the
    // pool cannot tell a dead key from a busy one and would reject the job.
    const retryAfter = Number(response.headers['retry-after'])
    throw Object.assign(new Error(describeStatus(response.status, response.body.toString('utf8').slice(0, 400))), {
      statusCode: response.status,
      ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterMs: retryAfter * 1000 } : {})
    })
  }
  return decodeResponse(response.body, response.headers['content-type'])
}

/**
 * Validate the host, the network path and the token without spending Anlas.
 *
 * Reads the subscription record rather than rendering: a `200` proves the token
 * works, and the returned payload carries the remaining training steps, which is
 * what a user wants to see before their first render.
 *
 * @param options - base URL and token.
 * @returns the probe outcome.
 */
export async function probe(options) {
  const { baseUrl, token, signal, proxy = null } = options
  if (!token) return { ok: false, stage: 'token', detail: '未配置凭据，无法探测。' }
  const origin = resolveOrigin(baseUrl)
  const url = `${origin}${SUBSCRIPTION_PATH}`

  let response
  try {
    response = await httpRequest({
      url,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      proxy,
      signal,
      timeoutMs: 30000
    })
  } catch (error) {
    return {
      ok: false,
      stage: 'network',
      detail: `连不上 ${origin}：${error?.message ?? error}`,
      hint: proxyHint(proxy),
      proxy
    }
  }

  const text = response.body.toString('utf8')
  if (response.status === 401) {
    return { ok: false, stage: 'token', status: 401, detail: `凭据被拒绝（${url}）。检查 token 是否完整、是否有多余空白。` }
  }
  if (response.status >= 500) {
    // The upstream body is deliberately not echoed. This is the one read that a
    // proxy or relay can answer with a page of its own, and a token that came
    // back inside an error string would then travel through the panel and into
    // the transcript. The status is all anyone can act on anyway.
    return { ok: false, stage: 'upstream', status: response.status, detail: `上游 ${response.status}：订阅接口暂时不可用。` }
  }
  // 2xx/3xx is a clean answer; 403/404/405 still prove the host and path are
  // reachable, which is what a connectivity probe is for.
  const reachable = response.status < 400 || [403, 404, 405].includes(response.status)
  // The same record answers both questions the user has — who they are (tier,
  // expiry) and what is left (Anlas, the V5 free band) — so the normalization
  // lives in `lib/quota.js` and this stays a transport concern. A record that
  // cannot be read is `null`, never a failed probe: the token may be perfectly
  // good while the body is not what we expect.
  let subscription = null
  if (response.status < 300) {
    try {
      subscription = normalizeSubscription(JSON.parse(text))
    } catch {
      subscription = null
    }
  }
  return {
    ok: reachable,
    stage: response.status < 300 ? 'ok' : 'reachable',
    status: response.status,
    origin,
    detail:
      response.status < 300
        ? `凭据有效（HTTP ${response.status}）。`
        : `主机可达（HTTP ${response.status}），但订阅接口没有给出正常应答——这通常仍意味着网络与域名没问题。`,
    subscription
  }
}

/**
 * Read every textual PNG chunk into a keyword map.
 *
 * NovelAI writes its provenance as `tEXt` chunks, which is the shape verified
 * against real output; `zTXt` (same payload, deflated) is handled too because it
 * costs three lines. `iTXt` is not read — no NovelAI output has been observed
 * using it.
 *
 * @param png - one PNG buffer.
 * @returns `{ keyword: value }`.
 */
export function readTextChunks(png) {
  const fields = {}
  let offset = 8
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    if (type === 'IEND') break
    const data = png.subarray(offset + 8, offset + 8 + length)
    if (type === 'tEXt') {
      const nul = data.indexOf(0)
      if (nul > 0) fields[data.toString('latin1', 0, nul)] = data.toString('latin1', nul + 1)
    } else if (type === 'zTXt') {
      const nul = data.indexOf(0)
      if (nul > 0) {
        const keyword = data.toString('latin1', 0, nul)
        try {
          fields[keyword] = inflateSync(data.subarray(nul + 2)).toString('latin1')
        } catch {
          // A damaged chunk only costs that one field.
        }
      }
    }
    offset += 12 + length
  }
  return fields
}

/**
 * Recover what actually produced a rendered PNG.
 *
 * This is the reproducibility path, and it is not guesswork: real NovelAI output
 * carries `Software: NovelAI`, a `Source` naming the model
 * (`NovelAI Diffusion V4.5 4BDE2A90`), and a `Comment` holding the whole
 * parameter set as JSON — `{"prompt": …, "steps": 28, "width": 832, "seed": …}`.
 *
 * An earlier version of this function looked for a `seed\0<digits>` keyword,
 * which never matches that layout: `seedOf` silently returned `null` for every
 * real image, so an unpinned render was reproducible only by accident.
 *
 * @param png - one rendered image.
 * @returns the recovered provenance; fields are `null` when absent.
 */
export function metadataOf(png) {
  const fields = readTextChunks(png)
  const out = {
    software: fields.Software ?? null,
    model: fields.Source ?? null,
    seed: null,
    steps: null,
    width: null,
    height: null,
    scale: null
  }
  const numeric = (value) => (Number.isFinite(Number(value)) ? Number(value) : null)
  if (typeof fields.Comment === 'string') {
    try {
      const comment = JSON.parse(fields.Comment)
      out.seed = numeric(comment.seed)
      out.steps = numeric(comment.steps)
      out.width = numeric(comment.width)
      out.height = numeric(comment.height)
      out.scale = numeric(comment.scale)
    } catch {
      // A non-JSON comment keeps the nulls rather than inventing values.
    }
  }
  return out
}

/**
 * Read just the seed, so an unpinned render can still be reproduced.
 * @param png - one rendered image.
 * @returns the seed, or `null`.
 */
export function seedOf(png) {
  return metadataOf(png).seed
}

/**
 * Write rendered images to disk and record the parameters beside them.
 *
 * File naming is timestamp plus index so a directory listing is naturally
 * chronological, and the sidecar JSON keeps the exact prompt and seed so a
 * render can be repeated instead of guessed at.
 *
 * @param options - output directory, images, and the request that produced them.
 * @returns one record per written file.
 */
export async function persist({ outputDir, images, request }) {
  await mkdir(outputDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const written = []
  for (let i = 0; i < images.length; i += 1) {
    const png = images[i]
    const name = images.length === 1 ? `${stamp}.png` : `${stamp}-${i + 1}.png`
    const file = join(outputDir, name)
    await writeFile(file, png)
    // Provenance comes from the image itself, so the sidecar records what
    // actually rendered rather than what was asked for.
    const meta = metadataOf(png)
    written.push({
      file,
      // The basename is what the panel's `/file` route takes, so it travels with
      // the record instead of being re-derived from a path by every consumer.
      name,
      bytes: png.length,
      seed: meta.seed,
      model: meta.model,
      steps: meta.steps,
      size: meta.width !== null && meta.height !== null ? `${meta.width}x${meta.height}` : null
    })
  }
  if (written.length > 0) {
    const sidecar = join(outputDir, `${stamp}.json`)
    await writeFile(sidecar, `${JSON.stringify({ request, files: written }, null, 2)}\n`, 'utf8')
  }
  return written
}
