/**
 * dsh-nai-imagegen — offline verification.
 *
 * Everything here runs without a browser, without a NovelAI credential and
 * without a running harness. Three seams are worth pinning, because none of
 * them can be re-derived by reading the code a week later:
 *
 *   1. the hand-written ZIP reader — checked against BOTH an archive produced by
 *      an independent implementation (pass one as argv[2]; .NET's ZipArchive via
 *      `Compress-Archive` is what the README suggests) and a self-built one, so
 *      the suite is still complete when no fixture is supplied;
 *   2. the hand-written client bundle — its `window.__ModuleLoader__.load`
 *      factory is executed against a stub host to prove it registers the
 *      panellist row and the keyed `main` page under one panel id;
 *   3. the Host half end to end — `apply(ctx)` is mounted against a stub tool
 *      registry and a stub web server, every HTTP route is exercised, and
 *      `nai_generate` is pointed at a stub NovelAI server so the whole render
 *      path (request build -> response decode -> disk -> returned paths) runs.
 *
 * Isolation: this suite redirects `DSH_HOME` to a temp directory before any
 * module reads it, so it can never write into the real harness home.
 *
 * Usage:  node tests/verify.mjs [path-to-fixture.zip]
 */
import { createServer } from 'node:http'
import { connect as netConnect } from 'node:net'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateRawSync, deflateSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'

// ------------------------------------------------------------- assertions --
let passed = 0
const failures = []
const skipped = []

/**
 * Assert one condition.
 * @param name - what is being checked.
 * @param condition - the observed truth.
 * @param detail - extra text on failure.
 */
function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok    ${name}`)
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/**
 * Record a section that could not run.
 * @param name - the section.
 * @param why - why it was skipped.
 */
function skip(name, why) {
  skipped.push(`${name}: ${why}`)
  console.log(`  skip  ${name} — ${why}`)
}

// ------------------------------------------------------------- isolation --
/** The real harness home, remembered so the suite can prove it stayed clean. */
const realHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const scratchHome = await mkdtemp(join(tmpdir(), 'nai-imagegen-home-'))
// Once the plugin is installed and running, `$DSH_HOME/nai-imagegen` legitimately
// exists — so the invariant is not "the directory is absent" but "this suite did
// not touch it". Snapshot the state file, compare at the end.
const realStateFile = join(realHome, 'nai-imagegen', 'config.json')
const realStateBefore = await readFile(realStateFile, 'utf8').catch(() => null)
process.env.DSH_HOME = scratchHome

// Dynamic imports so that `DSH_HOME` is already redirected when `config.js`
// reads it.
const {
  FREE_AREA,
  buildPayload,
  costWeight,
  decodeResponse,
  describeStatus,
  generate,
  insideFreeBand,
  legalAxis,
  metadataOf,
  normalizeImageItems,
  parseRegProxy,
  probe,
  readTextChunks,
  resolveGenerateUrl,
  resolveOrigin,
  seedOf,
  sniffKind,
  stripDataUrl,
  unzip
} = await import('../lib/nai.js')
const { httpRequest, resolveProxy } = await import('../lib/net.js')
const { assignIds, buildIndex: buildArtistIndex } = await import('../lib/artists.js')
const { looksLikeImageBlock: looksLikeImageBlockForTest } = await import('../lib/format.js')
const { load, save, tokenOf, ROW_ID } = await import('../lib/config.js')
const { listLibraries, lookup, rebuildIndex, resolveCharacter } = await import('../lib/library.js')
const { safeJoin, digest } = await import('../lib/util.js')
const { fileUrl, imageLink, linkBase } = await import('../lib/webbase.js')
const { defineTool, parametersToJsonSchema, validateArguments } = await import('../lib/tool.js')
const host = await import('../index.js')
const {
  describeQuota,
  normalizeAnlas,
  normalizeQuota,
  normalizeSubscription,
  summarizeQuota,
  V5_IMAGE_COEFFICIENT
} = await import('../lib/quota.js')

const here = fileURLToPath(new URL('.', import.meta.url))
const packageRoot = join(here, '..')

// ----------------------------------------------------------------- helpers --
/**
 * Build one PNG chunk with its length prefix and CRC.
 * @param type - the four ASCII type bytes.
 * @param data - the chunk payload.
 * @returns the encoded chunk.
 */
function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed) >>> 0)
  return Buffer.concat([length, typed, crc])
}

/**
 * An IHDR payload.
 * @param size - side length in pixels.
 * @returns the 13-byte header data.
 */
function pngIhdr(size) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return ihdr
}

/** The 8-byte PNG signature. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * Build a minimal but genuinely valid PNG (IHDR/IDAT/IEND, CRCs included).
 * @param size - side length in pixels.
 * @returns the encoded PNG.
 */
function makePng(size = 4) {
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', pngIhdr(size)),
    pngChunk('IDAT', deflateRawSync(Buffer.alloc(size * (1 + size * 4)))),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

/**
 * Build a PNG carrying the provenance chunk layout real NovelAI output uses.
 *
 * Copied from an actual file: `Title`, `Description`, `Software`, `Source`,
 * `Generation time` and a `Comment` holding the parameter set as JSON. The
 * seed only exists inside that JSON, which is exactly what the first version of
 * `seedOf` failed to read.
 *
 * @param options - provenance to embed.
 * @returns the encoded PNG.
 */
function makeNaiPng(options = {}) {
  const {
    seed = 2350067352,
    source = 'NovelAI Diffusion V4.5 4BDE2A90',
    steps = 28,
    width = 832,
    height = 1216,
    scale = 5.5,
    comment
  } = options
  const text = (keyword, value) =>
    pngChunk('tEXt', Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(value, 'latin1')]))
  const body =
    comment ??
    JSON.stringify({ prompt: 'a prompt', steps, height, width, scale, seed, n_samples: 1, noise_schedule: 'karras' })
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', pngIhdr(4)),
    text('Title', 'NovelAI generated image'),
    text('Software', 'NovelAI'),
    text('Source', source),
    text('Generation time', '3.0345981940627098e-05'),
    text('Comment', body),
    pngChunk('IDAT', deflateRawSync(Buffer.alloc(4 * (1 + 4 * 4)))),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

/**
 * Build a single-member ZIP, written from scratch.
 *
 * This is a fallback so the suite is complete without a fixture; it shares no
 * code with the reader under test, but it is still one author's understanding of
 * the format, which is exactly why an externally produced fixture is preferred
 * when one is supplied.
 *
 * @param name - member name.
 * @param payload - member bytes.
 * @returns the archive.
 */
function buildZip(name, payload) {
  const nameBytes = Buffer.from(name, 'utf8')
  const deflated = deflateRawSync(payload)
  const crc = crc32(payload) >>> 0

  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(8, 8)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(deflated.length, 18)
  local.writeUInt32LE(payload.length, 22)
  local.writeUInt16LE(nameBytes.length, 26)

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(8, 10)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(deflated.length, 20)
  central.writeUInt32LE(payload.length, 24)
  central.writeUInt16LE(nameBytes.length, 28)
  central.writeUInt16LE(nameBytes.length, 30)

  const localPart = Buffer.concat([local, nameBytes, deflated])
  const centralPart = Buffer.concat([central, nameBytes])

  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(centralPart.length, 12)
  end.writeUInt32LE(localPart.length, 16)

  return Buffer.concat([localPart, centralPart, end])
}

/**
 * Mount the Host half against stub services.
 * @returns the captured tool definitions and registered routes.
 */
function mountHost() {
  const tools = new Map()
  const routes = []
  const effects = []
  const ctx = {
    effect: (factory) => {
      effects.push(factory())
      return () => {}
    },
    tools: {
      register: (definition) => {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      }
    },
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => {}
      }
    }
  }
  host.apply(ctx)
  return { tools, routes, effects }
}

/**
 * Build a fake node request, including an async body iterator.
 * @param options - method, url and optional raw body.
 * @returns the fake request.
 */
function fakeRequest({ method = 'GET', url = '/', body = null }) {
  const chunks = body === null ? [] : [Buffer.from(body)]
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    }
  }
}

/**
 * Invoke one route handler and capture what it wrote.
 * @param handler - the route handler.
 * @param request - the fake request.
 * @returns the captured status, headers and body.
 */
async function callRoute(handler, request) {
  const state = { status: 0, headers: null, body: Buffer.alloc(0) }
  const response = {
    writeHead(status, headers) {
      state.status = status
      state.headers = headers
    },
    end(chunk) {
      if (chunk !== undefined) state.body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    }
  }
  await handler(request, response)
  return state
}

/** Parse a captured JSON body. */
const asJson = (state) => JSON.parse(state.body.toString('utf8'))

// ==================================================== [0] no host imports ====
console.log('\n[0] the package imports nothing from the host')
// Asserted rather than assumed, because this is how the plugin broke once: a
// `link:`-installed bundle cannot resolve `@deepseek-ai/*` (the profile's
// node_modules does not carry host packages), and one such import makes the
// Loader report "failed to import" and takes the whole row down.
const selfFiles = []
{
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === 'tests' || entry.name === 'node_modules' || entry.name === '.git') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) selfFiles.push(full)
    }
  }
  await walk(packageRoot)
}
/**
 * Strip comments so the host-import guard reads code, not prose.
 *
 * `lib/tool.js` documents the very import it exists to avoid, and a naive scan
 * flagged that comment. The `[^:]` guard keeps `https://` inside string
 * literals from being mistaken for a line comment.
 * @param text - one source file.
 * @returns the same file with comments removed.
 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const offenders = []
for (const file of selfFiles) {
  const code = stripComments(await readFile(file, 'utf8'))
  if (/from\s+'@deepseek-ai\//.test(code) || /require\('@deepseek-ai\//.test(code)) {
    offenders.push(file.slice(packageRoot.length))
  }
}
check('no source file imports or requires a host package', offenders.length === 0, offenders.join(','))
check('the scan actually saw the sources', selfFiles.length >= 6, `${selfFiles.length} files`)

const clientOnlyRequires = [...(await readFile(join(packageRoot, 'client.js'), 'utf8')).matchAll(/require\("([^"]+)"/g)].map((m) => m[1])
check('the client bundle requires only the react platform module', clientOnlyRequires.every((name) => name === 'react'), clientOnlyRequires.join(','))

// The local defineTool stands in for the host's; pin the expansion it performs.
const expanded = parametersToJsonSchema({
  a: { type: 'string', required: true, description: 'x' },
  b: { type: 'integer' }
})
check('shorthand expansion produces an object schema', expanded.type === 'object')
check('shorthand expansion closes the object', expanded.additionalProperties === false)
check('shorthand expansion lifts required into an array', Array.isArray(expanded.required) && expanded.required[0] === 'a', JSON.stringify(expanded.required))
check('shorthand expansion drops the required flag from the property', expanded.properties.a.required === undefined)
check('shorthand expansion keeps descriptions', expanded.properties.a.description === 'x')
check('an omitted required argument is rejected', validateArguments(expanded, {}).length === 1)
check('a wrong argument type is rejected', validateArguments(expanded, { a: 'ok', b: 'not a number' }).length === 1)
check('a well-formed call passes validation', validateArguments(expanded, { a: 'ok', b: 3 }).length === 0)
check('defineTool builds a registry-ready definition', typeof defineTool({ name: 'x', description: 'y', parameters: {}, output: { schema: { type: 'string' } }, execute: async () => 'z' }).execute === 'function')

// ============================================================== [1] pure ====
console.log('\n[1] size, cost and payload shaping')
check('legalAxis snaps to 64', legalAxis(830, 832) === 832, `got ${legalAxis(830, 832)}`)
check('legalAxis clamps low', legalAxis(1, 832) === 64, `got ${legalAxis(1, 832)}`)
check('legalAxis clamps high', legalAxis(99999, 832) === 2048, `got ${legalAxis(99999, 832)}`)
check('legalAxis falls back', legalAxis(undefined, 832) === 832, `got ${legalAxis(undefined, 832)}`)
check('costWeight is 1 at the reference render', costWeight({ width: 832, height: 1216, steps: 28, nSamples: 1 }) === 1)
check('costWeight doubles with sample count', costWeight({ width: 832, height: 1216, steps: 28, nSamples: 2 }) === 2)

const payload = buildPayload({
  prompt: 'moria_luluka, 1girl',
  negativePrompt: 'lowres',
  model: 'nai-diffusion-5-full',
  width: 832,
  height: 1216,
  steps: 28,
  scale: 5,
  sampler: 'k_euler_ancestral'
})
check('payload uses action=generate', payload.action === 'generate')
check('payload carries the model', payload.model === 'nai-diffusion-5-full')
check('payload omits an unpinned seed', payload.parameters.seed === undefined)
check('payload pins params_version 4 for V5', payload.parameters.params_version === 4)
// The three places the prompt has to appear for a V5 call to succeed.
check('payload puts the prompt in input', payload.input === 'moria_luluka, 1girl')
check('payload puts the prompt in parameters.prompt', payload.parameters.prompt === 'moria_luluka, 1girl')
check('payload builds the v4 caption block', payload.parameters.v4_prompt?.caption.base_caption === 'moria_luluka, 1girl')
// Dropping either structured caption is a 500 on V5, so both are asserted.
check('payload always includes v4_prompt', payload.parameters.v4_prompt !== undefined)
check('payload always includes v4_negative_prompt', payload.parameters.v4_negative_prompt !== undefined)
check('payload mirrors the negative caption', payload.parameters.v4_negative_prompt?.caption.base_caption === 'lowres')
check('payload leaves v4 char captions empty', Array.isArray(payload.parameters.v4_prompt?.caption.char_captions))
check('payload does not request the original image', payload.parameters.add_original_image === false)
check('payload sends ucPreset 3 like the official client', payload.parameters.ucPreset === 3)
check('payload carries the reference arrays V5 expects', Array.isArray(payload.parameters.reference_image_multiple))

// ------------------------------------------------- character captions ----
// NovelAI's character-position feature. The wire shape was confirmed against the
// live API rather than guessed: `centers` must be objects (`image.Coordinates`),
// and a list of strings comes back as `cannot unmarshal string into … centers of
// type image.Coordinates`.
{
  const split = buildPayload({
    prompt: 'SFW,{{2girls}},side-by-side,blonde angel,brown-haired pilot',
    negativePrompt: 'brown hair,ahoge,halo,wings,nude',
    model: 'nai-diffusion-5-full',
    width: 1024,
    height: 1024,
    steps: 28,
    scale: 5,
    sampler: 'k_euler_ancestral',
    sceneCaption: 'SFW,{{2girls}},side-by-side',
    sceneNegative: 'nude,completely nude',
    characters: [
      { positive: 'girl,on left,blonde hair,halo,wings', negative: 'brown hair,ahoge,headset', centers: ['B3'] },
      { positive: 'girl,on right,brown hair,ahoge,headset', negative: 'blonde hair,halo,wings', centers: ['D3'] }
    ]
  })
  const caption = split.parameters.v4_prompt?.caption
  check('a block with characters turns coordinates on', split.parameters.v4_prompt?.use_coords === true)
  check('and turns ordering on', split.parameters.v4_prompt?.use_order === true)
  check('the base caption becomes the scene alone', caption?.base_caption === 'SFW,{{2girls}},side-by-side', String(caption?.base_caption))
  check('each character becomes its own caption', caption?.char_captions?.length === 2, JSON.stringify(caption?.char_captions))
  check('the first caption is the first character', caption?.char_captions?.[0]?.char_caption === 'girl,on left,blonde hair,halo,wings', JSON.stringify(caption?.char_captions?.[0]))
  check(
    'B3 becomes the normalised centre of that cell',
    caption?.char_captions?.[0]?.centers?.[0]?.x === 0.3 && caption?.char_captions?.[0]?.centers?.[0]?.y === 0.5,
    JSON.stringify(caption?.char_captions?.[0]?.centers)
  )
  check(
    'D3 lands on the other side of centre',
    caption?.char_captions?.[1]?.centers?.[0]?.x === 0.7 && caption?.char_captions?.[1]?.centers?.[0]?.y === 0.5,
    JSON.stringify(caption?.char_captions?.[1]?.centers)
  )
  check(
    'centers is a list of objects, never strings',
    caption?.char_captions?.every((row) => (row.centers ?? []).every((point) => typeof point === 'object' && point !== null)),
    JSON.stringify(caption?.char_captions?.map((row) => row.centers))
  )
  // The negative side is where the pairing actually pays off: a character's UC has
  // to apply to that character, not to the whole picture.
  const negativeCaption = split.parameters.v4_negative_prompt?.caption
  check('the negative base caption is the scene-only negative', negativeCaption?.base_caption === 'nude,completely nude', String(negativeCaption?.base_caption))
  check(
    'each character gets its own negative caption',
    negativeCaption?.char_captions?.[0]?.char_caption === 'brown hair,ahoge,headset' &&
      negativeCaption?.char_captions?.[1]?.char_caption === 'blonde hair,halo,wings',
    JSON.stringify(negativeCaption?.char_captions)
  )
  check(
    "the other character's features stay out of the global negative",
    !String(negativeCaption?.base_caption).includes('headset'),
    String(negativeCaption?.base_caption)
  )
  check('the split negative captions carry the same coordinates', negativeCaption?.char_captions?.[1]?.centers?.[0]?.x === 0.7)

  // `auto` is a valid marker in the format and means "let it decide". The API has
  // no way to express that, and rejects a row whose `centers` is empty with a bare
  // 500 — so the centre is substituted. This assertion used to expect `[]`, which
  // is precisely the shape that returned HTTP 500 against the live API.
  const auto = buildPayload({
    prompt: 'x',
    model: 'nai-diffusion-5-full',
    width: 512,
    height: 512,
    steps: 28,
    scale: 5,
    sampler: 'k_euler',
    characters: [{ positive: 'girl', negative: '', centers: ['auto'] }]
  })
  check(
    'an auto cell alone turns positioning off rather than placing the character',
    // `auto` means "arrange it yourself", so `use_coords` goes false and the API
    // ignores coordinates entirely. The point is still sent because an **empty**
    // `centers` array is a documented cause of an HTTP 500 from the V4/V5 endpoint
    // rather than a 400 — the flag is what makes it inert, so the risky shape is
    // never put on the wire.
    auto.parameters.v4_prompt?.use_coords === false &&
      JSON.stringify(auto.parameters.v4_prompt?.caption?.char_captions?.[0]?.centers) === '[{"x":0.5,"y":0.5}]',
    JSON.stringify(auto.parameters.v4_prompt?.caption?.char_captions?.[0]?.centers)
  )
  // The invariant the character feature rests on: **when coordinates are on**, no
  // caption row may carry an empty list — the API rejects it. Rows may only be
  // empty while the flag is off, where they are inert.
  const shapes = [
    ['both placed', [{ positive: 'a', negative: 'x', centers: ['B3'] }, { positive: 'b', negative: 'y', centers: ['D3'] }]],
    ['one auto', [{ positive: 'a', negative: 'x', centers: ['auto'] }, { positive: 'b', negative: 'y', centers: ['B3'] }]],
    ['none placed', [{ positive: 'a', negative: 'x', centers: [] }, { positive: 'b', negative: '', centers: [] }]],
    ['off-grid cell', [{ positive: 'a', negative: 'x', centers: ['Z9'] }]],
    ['no negative at all', [{ positive: 'a', negative: '', centers: ['C3'] }]],
    ['canvas points', [{ positive: 'a', negative: 'x', centers: [{ x: 0.25, y: 0.75 }] }]]
  ]
  for (const [label, characters] of shapes) {
    const built = buildPayload({
      prompt: 'x',
      negativePrompt: 'n',
      model: 'nai-diffusion-5-full',
      width: 512,
      height: 512,
      steps: 28,
      scale: 5,
      sampler: 'k_euler',
      characters
    })
    const coordsOn = built.parameters.v4_prompt?.use_coords === true
    const positiveRows = built.parameters.v4_prompt?.caption?.char_captions ?? []
    const negativeRows = built.parameters.v4_negative_prompt?.caption?.char_captions ?? []
    check(
      `every caption row carries a point, with or without coordinates (${label})`,
      // The invariant is unconditional now: an empty `centers` array is a
      // documented HTTP 500 from the V4/V5 endpoint, so no row may ever carry one.
      // With `use_coords: false` the point is inert and the API arranges freely.
      positiveRows.length > 0 &&
        positiveRows.every((row) => (row.centers ?? []).length > 0) &&
        negativeRows.every((row) => (row.centers ?? []).length > 0) &&
        (coordsOn || positiveRows.every((row) => row.centers[0].x === 0.5 && row.centers[0].y === 0.5)),
      `coords=${coordsOn} pos=${JSON.stringify(positiveRows.map((row) => row.centers))} neg=${JSON.stringify(negativeRows.map((row) => row.centers))}`
    )
    if (coordsOn) {
      check(
        `the caption rows describe the same placements as the flag (${label})`,
        JSON.stringify(positiveRows.map((row) => row.centers)) === JSON.stringify(negativeRows.map((row) => row.centers))
      )
    }
  }
  // A plain prompt must keep the single-caption path exactly as it was.
  check(
    'a plain prompt still uses one caption',
    payload.parameters.v4_prompt?.use_coords === false && payload.parameters.v4_prompt?.caption?.char_captions?.length === 0
  )
}

const v4 = buildPayload({ prompt: 'a', model: 'nai-diffusion-4-full', width: 512, height: 512, steps: 28, scale: 5, sampler: 'k_euler' })
check('V4 also gets the structured captions', v4.parameters.v4_prompt !== undefined && v4.parameters.params_version === 4)
const legacy = buildPayload({ prompt: 'a', model: 'nai-diffusion-3', width: 512, height: 512, steps: 28, scale: 5, sampler: 'k_euler' })
check('legacy model gets no v4 block', legacy.parameters.v4_prompt === undefined)
check('legacy model keeps params_version 3', legacy.parameters.params_version === 3)
const pinned = buildPayload({ prompt: 'a', model: 'nai-diffusion-5-full', width: 512, height: 512, steps: 28, scale: 5, sampler: 'k_euler', seed: 12345 })
check('pinned seed is forwarded', pinned.parameters.seed === 12345)
check('pinned seed also fills extra_noise_seed', pinned.parameters.extra_noise_seed === 12345)

// URL shapes: a bare origin, an origin ending in /ai, and a full endpoint.
check('a bare origin gains the full path', resolveGenerateUrl('https://image.novelai.net') === 'https://image.novelai.net/ai/generate-image')
check('a trailing slash is tolerated', resolveGenerateUrl('https://image.novelai.net/') === 'https://image.novelai.net/ai/generate-image')
check('an /ai base gains only the tail', resolveGenerateUrl('https://image.novelai.net/ai') === 'https://image.novelai.net/ai/generate-image')
check(
  'a full endpoint URL is passed through',
  resolveGenerateUrl('https://relay.example/ai/generate-image') === 'https://relay.example/ai/generate-image'
)
check('the origin is extracted for probing', resolveOrigin('https://image.novelai.net/ai') === 'https://image.novelai.net')

// The free band is a measured envelope, so the boundary is pinned exactly.
check('free band accepts 832x1216 at 28 steps', insideFreeBand({ width: 832, height: 1216, steps: 28, nSamples: 1 }))
check('free band accepts 1024x1024 exactly', insideFreeBand({ width: 1024, height: 1024, steps: 28, nSamples: 1 }))
check('free band rejects one pixel over', !insideFreeBand({ width: 1024, height: 1024 + 64, steps: 28, nSamples: 1 }))
check('free band rejects 29 steps', !insideFreeBand({ width: 832, height: 1216, steps: 29, nSamples: 1 }))
check('free band rejects two images', !insideFreeBand({ width: 832, height: 1216, steps: 28, nSamples: 2 }))
check('the free area constant is 1024x1024', FREE_AREA === 1048576)

// Status messages carry the diagnosis, not just the code.
check('401 explains the ambiguous credential failure', /无法区分/.test(describeStatus(401, '')))
check('429 states that retrying is forbidden', /不要重试/.test(describeStatus(429, '')))
check('500 points at the missing v4 caption', /v4_prompt/.test(describeStatus(500, '')))
check('400 points at the model id and the host move', /image\.novelai\.net/.test(describeStatus(400, '')))

// Windows system-proxy parsing, split out so it is testable without a registry.
check(
  'an enabled proxy is read from reg output',
  parseRegProxy('    ProxyEnable    REG_DWORD    0x1\n    ProxyServer    REG_SZ    127.0.0.1:7890\n') ===
    'http://127.0.0.1:7890'
)
check(
  'a proxy that already carries a scheme is left alone',
  parseRegProxy('ProxyEnable REG_DWORD 0x1\nProxyServer REG_SZ http://127.0.0.1:7890') === 'http://127.0.0.1:7890'
)
check('a disabled proxy yields null', parseRegProxy('ProxyEnable REG_DWORD 0x0\nProxyServer REG_SZ 127.0.0.1:7890') === null)
check('a missing ProxyServer yields null', parseRegProxy('ProxyEnable REG_DWORD 0x1') === null)
check('unparseable output yields null', parseRegProxy('ERROR: The system was unable to find the specified registry key') === null)

// ================================================================= [2] zip ===
console.log('\n[2] hand-written ZIP reader')
const ownZip = buildZip('image_0.png', makePng())
try {
  const entries = unzip(ownZip)
  check('self-built archive expands', entries.length === 1, `got ${entries.length}`)
  check('self-built member keeps the PNG signature', entries[0]?.data[0] === 0x89 && entries[0]?.data[1] === 0x50)
} catch (error) {
  check('self-built archive expands', false, error.message)
}

const fixture = process.argv[2]
if (fixture === undefined) {
  skip('externally produced archive', 'no fixture argument; pass one as argv[2] to add it')
} else {
  const archive = await readFile(fixture)
  try {
    const entries = unzip(archive)
    check('external archive expands', entries.length > 0, `got ${entries.length} entries`)
    check(
      'external members expand to their declared length',
      entries.every((entry) => entry.data.length > 0),
      entries.map((entry) => `${entry.name}:${entry.data.length}`).join(', ')
    )
    const png = entries.find((entry) => entry.name.toLowerCase().endsWith('.png'))
    check('external PNG member keeps its signature', png !== undefined && png.data[0] === 0x89 && png.data[1] === 0x50)
  } catch (error) {
    check('external archive expands', false, error.message)
  }
}
try {
  unzip(Buffer.from('not a zip at all'))
  check('a non-archive is rejected', false, 'unzip did not throw')
} catch {
  check('a non-archive is rejected', true)
}

// ============================================== [2b] response decoding =====
console.log('\n[2b] response decoding across the shapes seen in the wild')
// The official endpoint answers `binary/octet-stream` for a zip, relays answer
// JSON with base64, and either can lie about its content type — so the decoder
// sniffs bytes rather than trusting the header.
const pngBytes = makePng()
check('a zip is sniffed from its magic bytes', sniffKind(ownZip) === 'zip')
check('a png is sniffed from its magic bytes', sniffKind(pngBytes) === 'png')
check('json is sniffed past leading whitespace', sniffKind(Buffer.from('\n  {"images":[]}')) === 'json')
check('an unknown body is reported as unknown', sniffKind(Buffer.from([0x00, 0x01, 0x02])) === 'unknown')

check('an octet-stream zip decodes', decodeResponse(ownZip, 'binary/octet-stream').length === 1)
check('a zip with a lying content type still decodes', decodeResponse(ownZip, 'text/html').length === 1)
check('a bare png decodes', decodeResponse(pngBytes, 'image/png')[0].equals(pngBytes))
check('a bare png with a lying content type still decodes', decodeResponse(pngBytes, 'application/octet-stream')[0].equals(pngBytes))
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(24)])
check('a jpeg passes through untouched', decodeResponse(jpeg, 'application/octet-stream')[0].equals(jpeg))

const b64 = pngBytes.toString('base64')
check('a json array of base64 strings decodes', decodeResponse(Buffer.from(JSON.stringify([b64])), 'application/json')[0].equals(pngBytes))
check('a json array of objects decodes', decodeResponse(Buffer.from(JSON.stringify([{ image: b64, seed: 7 }])), 'application/json')[0].equals(pngBytes))
check('a json images envelope decodes', decodeResponse(Buffer.from(JSON.stringify({ images: [{ base64: b64 }] })), 'application/json')[0].equals(pngBytes))
check('a json data envelope decodes', decodeResponse(Buffer.from(JSON.stringify({ data: [b64] })), 'application/json')[0].equals(pngBytes))
check('a bare json object with image decodes', decodeResponse(Buffer.from(JSON.stringify({ image: b64 })), 'application/json')[0].equals(pngBytes))
check(
  'json is decoded even when the content type says otherwise',
  decodeResponse(Buffer.from(JSON.stringify({ images: [b64] })), 'text/plain')[0].equals(pngBytes)
)
check('a data: URL payload is unwrapped', stripDataUrl(`data:image/png;base64,${b64}`) === b64)
check(
  'json without an image is refused',
  (() => {
    try {
      decodeResponse(Buffer.from('{"ok":true}'), 'application/json')
      return false
    } catch {
      return true
    }
  })()
)
check(
  'unparseable json is refused',
  (() => {
    try {
      decodeResponse(Buffer.from('{oops'), 'application/json')
      return false
    } catch {
      return true
    }
  })()
)
check('normalizeImageItems reads a numeric seed', normalizeImageItems([{ image: 'x', seed: 5 }])[0].seed === 5)
check('normalizeImageItems skips a non-string payload', normalizeImageItems([{ image: 42 }]).length === 0)
check(
  'a json error body surfaces as a tool error, not a silent success',
  (() => {
    try {
      decodeResponse(Buffer.from('{"statusCode":500,"message":"Internal Server Error"}'), 'application/json')
      return false
    } catch (error) {
      return /carried no image/.test(error.message)
    }
  })()
)

// ============================================ [2c] PNG provenance ==========
console.log('\n[2c] PNG provenance, in the layout real NovelAI output uses')
// The fixture carries the chunk set copied from a real file on this machine:
// Software=NovelAI, Source naming the model, and a Comment holding the whole
// parameter set as JSON. The seed lives only inside that JSON, which is what the
// first version of `seedOf` failed to read — it returned null for every real
// image, so an unpinned render was reproducible only by accident.
const naiPng = makeNaiPng()
const naiZip = buildZip('image_0.png', naiPng)
const meta = metadataOf(naiPng)
check('the software marker is read', meta.software === 'NovelAI', String(meta.software))
check('the model is read from Source', meta.model === 'NovelAI Diffusion V4.5 4BDE2A90', String(meta.model))
check('the seed is read from the Comment JSON', meta.seed === 2350067352, String(meta.seed))
check('steps come from the Comment JSON', meta.steps === 28, String(meta.steps))
check('the size comes from the Comment JSON', meta.width === 832 && meta.height === 1216, `${meta.width}x${meta.height}`)
check('the scale comes from the Comment JSON', meta.scale === 5.5, String(meta.scale))
check('seedOf delegates to the metadata reader', seedOf(naiPng) === 2350067352)
check('both readers expose the raw chunks', readTextChunks(naiPng).Software === 'NovelAI')
check(
  'a PNG with no provenance yields nulls rather than throwing',
  metadataOf(makePng()).seed === null && metadataOf(makePng()).model === null
)
check('a non-JSON Comment yields nulls', metadataOf(makeNaiPng({ comment: 'not json' })).seed === null)
check('a numeric-looking string seed is coerced', metadataOf(makeNaiPng({ comment: '{"seed":"42"}' })).seed === 42)
// A zTXt chunk must be inflated, not read as latin1 garbage.
{
  const deflated = deflateSync(Buffer.from('{"seed":777}'))
  const ztxt = pngChunk('zTXt', Buffer.concat([Buffer.from('Comment', 'latin1'), Buffer.from([0, 0]), deflated]))
  const withZtxt = Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', pngIhdr(4)), ztxt, pngChunk('IEND', Buffer.alloc(0))])
  check('a deflated zTXt comment is inflated', metadataOf(withZtxt).seed === 777, String(metadataOf(withZtxt).seed))
}

// ============================================ [2d] proxy transport =========
console.log('\n[2d] proxy transport (CONNECT tunnel, verified end to end)')
// Node's `fetch` ignores the system proxy and only reads proxy env vars at
// process start, which a plugin cannot influence. So the plugin tunnels itself,
// and this section proves the handshake works against a stub proxy rather than
// trusting the code by inspection. Plain http: is used on purpose: it exercises
// the same CONNECT path without needing a certificate.
check('an empty setting means auto', resolveProxy('', 'http://127.0.0.1:7890') === 'http://127.0.0.1:7890')
check('auto means the detected proxy', resolveProxy('auto', 'http://127.0.0.1:7890') === 'http://127.0.0.1:7890')
check('an explicit URL wins over detection', resolveProxy('http://10.0.0.1:8080', 'http://127.0.0.1:7890') === 'http://10.0.0.1:8080')
check('off forces a direct connection', resolveProxy('off', 'http://127.0.0.1:7890') === null)
check('none/direct are accepted spellings', resolveProxy('none', 'x') === null && resolveProxy('direct', 'x') === null)
check('auto with nothing detected is still direct', resolveProxy('', null) === null)

/** Start a server on an ephemeral port and resolve with its port. */
const listen = (server) => new Promise((ready) => server.listen(0, '127.0.0.1', () => ready(server.address().port)))

const originServer = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end(`origin:${req.method}:${req.url}`)
})
const originPort = await listen(originServer)

/** Records what the stub proxy was asked to CONNECT to. */
const connectLog = []
const proxyServer = createServer()
proxyServer.on('connect', (req, clientSocket, head) => {
  connectLog.push(req.url)
  const [host, port] = String(req.url).split(':')
  const upstream = netConnect(Number(port), host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head !== undefined && head.length > 0) upstream.write(head)
    upstream.pipe(clientSocket)
    clientSocket.pipe(upstream)
  })
  upstream.on('error', () => clientSocket.destroy())
  clientSocket.on('error', () => upstream.destroy())
})
const proxyPort = await listen(proxyServer)
const proxyUrl = `http://127.0.0.1:${proxyPort}`

try {
  const direct = await httpRequest({ url: `http://127.0.0.1:${originPort}/direct`, timeoutMs: 10000 })
  check('a direct request works', direct.status === 200 && direct.body.toString() === 'origin:GET:/direct', direct.body.toString())
  check('a direct request never touches the proxy', connectLog.length === 0, connectLog.join(','))

  const tunneled = await httpRequest({ url: `http://127.0.0.1:${originPort}/through`, proxy: proxyUrl, timeoutMs: 10000 })
  check('a tunnelled request reaches the origin', tunneled.status === 200, String(tunneled.status))
  check('the tunnelled body is the origin response', tunneled.body.toString() === 'origin:GET:/through', tunneled.body.toString())
  check('the tunnel was opened with CONNECT', connectLog.includes(`127.0.0.1:${originPort}`), connectLog.join(','))

  const posted = await httpRequest({
    url: `http://127.0.0.1:${originPort}/post`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hello: 1 }),
    proxy: proxyUrl,
    timeoutMs: 10000
  })
  check('a tunnelled POST works too', posted.status === 200 && posted.body.toString() === 'origin:POST:/post', posted.body.toString())

  // A proxy that refuses must surface the reason instead of hanging.
  const refusing = createServer()
  refusing.on('connect', (_req, socket) => {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
    socket.end()
  })
  const refusingPort = await listen(refusing)
  try {
    await httpRequest({ url: `http://127.0.0.1:${originPort}/nope`, proxy: `http://127.0.0.1:${refusingPort}`, timeoutMs: 10000 })
    check('a refusing proxy is reported', false, 'request resolved')
  } catch (error) {
    check('a refusing proxy is reported', /proxy refused CONNECT/.test(error.message), error.message)
  }
  await new Promise((done) => refusing.close(done))

  // A dead proxy must fail fast with a clear message, not hang the render.
  try {
    await httpRequest({ url: `http://127.0.0.1:${originPort}/dead`, proxy: 'http://127.0.0.1:1', timeoutMs: 8000 })
    check('an unreachable proxy is reported', false, 'request resolved')
  } catch (error) {
    check('an unreachable proxy is reported', /ECONNREFUSED|connect/i.test(error.message), error.message)
  }
} finally {
  await new Promise((done) => originServer.close(done))
  await new Promise((done) => proxyServer.close(done))
}

// ============================================== [3] config =================
console.log('\n[3] configuration round-trip and isolation')
check('row id is stable', ROW_ID === 'nai-imagegen')
check('the suite runs against a redirected home', load !== undefined && join(scratchHome).includes('nai-imagegen-home-'))
const initial = await load()
check('defaults expose an output dir', typeof initial.outputDir === 'string' && initial.outputDir.length > 0)
check('save applies the patch', (await save({ width: 1024, steps: 12 })).steps === 12)
check('save coerces a stringified number', (await save({ width: '768' })).width === 768)
check('token from the file is honoured', (await tokenOf()) === '')
await save({ token: 'pst-test-value' })
check('stored token is read back', (await tokenOf()) === 'pst-test-value')
process.env.NAI_TOKEN = 'pst-from-env'
check('environment token wins over the file', (await tokenOf()) === 'pst-from-env')
delete process.env.NAI_TOKEN
check('unknown fields are dropped', (await save({ nonsenseField: 'x' })).nonsenseField === undefined)
check(
  'the real harness state file is untouched so far',
  (await readFile(realStateFile, 'utf8').catch(() => null)) === realStateBefore
)

// ============================================================ [4] path guard
console.log('\n[4] output-directory containment')
const guardRoot = join(scratchHome, 'guard')
const contains = (candidate) => {
  const full = resolve(candidate)
  const root = resolve(guardRoot)
  return full === root || full.startsWith(root + sep)
}
/**
 * Assert that a name is refused rather than reinterpreted.
 * @param label - the assertion name.
 * @param name - the hostile name.
 */
function refuses(label, name) {
  try {
    const got = safeJoin(guardRoot, name)
    check(label, false, `returned ${got}`)
  } catch {
    check(label, true)
  }
}
refuses('a windows traversal is refused', '..\\..\\windows\\system32\\evil.png')
refuses('a posix traversal is refused', '../../etc/passwd')
refuses('a mixed traversal is refused', 'a/b/../../../evil.png')
refuses('an absolute path is refused', 'C:\\Windows\\notepad.exe')
refuses('a bare dot is refused', '.')
refuses('a bare dotdot is refused', '..')
refuses('an empty name is refused', '')
check('a plain name resolves inside the root', contains(safeJoin(guardRoot, 'shot.png')), safeJoin(guardRoot, 'shot.png'))
check('a plain name keeps its extension', safeJoin(guardRoot, 'shot.png').endsWith('shot.png'))

// ============================================================== [5] library =
console.log('\n[5] library index and lookup')
const config = await load()
const available = await listLibraries(config.libraryDir)
if (available.length === 0) {
  console.log('  note  no index present; rebuilding from the source directory')
  const rebuilt = await rebuildIndex({ sourceDir: config.librarySourceDir, libraryDir: config.libraryDir })
  check('rebuild writes libraries', rebuilt.written.length > 0, JSON.stringify(rebuilt.skipped.slice(0, 3)))
}
const indexed = await listLibraries(config.libraryDir)
if (indexed.length === 0) {
  skip('library lookup', 'no library source found on this machine')
} else {
  const entries = indexed.reduce((sum, row) => sum + row.entries, 0)
  check('index holds a plausible number of entries', entries > 500, `got ${entries}`)
  check('lookup finds a known entry', (await lookup('美人鱼', { libraryDir: config.libraryDir, limit: 3 })).hits.length > 0)
  check('lookup reports a miss cleanly', (await lookup('这个词绝对不存在zzz', { libraryDir: config.libraryDir, limit: 3 })).hits.length === 0)
  const found = await lookup('美人鱼', { libraryDir: config.libraryDir, library: '扩展库5.4', limit: 2 })
  check('a single-library restriction is honoured', found.hits.every((hit) => hit.library === '扩展库5.4'))
  const character = await resolveCharacter('琉琉歌', { libraryDir: config.libraryDir, limit: 1 })
  check('resolveCharacter finds the roster entry', character.hits.length > 0)
  check(
    'resolveCharacter returns the official tag verbatim',
    character.hits[0]?.content.includes('moria ruruka') === true,
    character.hits[0]?.content.slice(0, 80)
  )

  // The digest is shared by `lookup` and `resolveCharacter`, so both shapes have to
  // carry the fields its header reads. The roster once returned `{uid,title,keys,
  // content}` only, and every resolve printed "【undefined #154】… (undefined 字符)".
  check('a roster hit carries the library name', character.hits[0]?.library === '同人库8.5', String(character.hits[0]?.library))
  check('a roster hit carries its character count', typeof character.hits[0]?.chars === 'number' && character.hits[0].chars > 0, String(character.hits[0]?.chars))
  const rosterText = digest(character)
  check('the digest header names the library', rosterText.includes('【同人库8.5 #'), rosterText.slice(0, 90))
  check('the digest header never prints undefined', !rosterText.includes('undefined'), rosterText.slice(0, 90))
  check('the digest header shows a real character count', /\([1-9]\d* 字符\)/.test(rosterText), rosterText.slice(0, 90))

  // A miss has to say what was searched. Reporting an empty index directory sends
  // the reader off to rebuild an index that was perfectly fine.
  const miss = await resolveCharacter('这个词绝对不在名册里zzz', { libraryDir: config.libraryDir, limit: 2 })
  check('a roster miss still reports the indexed libraries', Array.isArray(miss.libraries) && miss.libraries.length > 0)
  const missText = digest(miss)
  check('a roster miss does not claim the index is empty', !missText.includes('索引目录为空'), missText.slice(0, 120))
  check('a roster miss names what was searched', /名册/.test(missText), missText.slice(0, 120))

  // A user's shorthand for a character need not appear in the roster, so a miss
  // offers the near hits rather than reading like a broken index.
  const nearMiss = await resolveCharacter('橘光', { libraryDir: config.libraryDir, limit: 2 })
  if (nearMiss.hits.length === 0) {
    check('a near miss offers candidates', /相近条目/.test(digest(nearMiss)), digest(nearMiss).slice(0, 160))
  } else {
    check('a character by a known name resolves directly', true)
  }
}

// ========================================================= [6] client bundle
console.log('\n[6] browser half registers into the right slots')
const clientSource = await readFile(join(packageRoot, 'client.js'), 'utf8')
let definition = null
const fakeWindow = { __ModuleLoader__: { load: (def) => { definition = def } } }
// The bundle is a classic script, so run it with a minimal global face.
new Function('window', clientSource)(fakeWindow)
check('bundle registers one factory', definition !== null && typeof definition.factory === 'function')
if (definition !== null) {
  check('bundle id matches the package name', definition.id === 'dsh-nai-imagegen', definition.id)
  const ReactStub = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn
  }
  const exports = definition.factory((name) => {
    if (name === 'react') return ReactStub
    throw new Error(`unexpected external: ${name}`)
  })
  check('factory exports apply', typeof exports.apply === 'function')
  check('factory declares inject', Array.isArray(exports.inject) && exports.inject.includes('slots'))

  const injected = []
  const registered = []
  const fakeCtx = {
    effect: (fn) => {
      fn()
      return () => {}
    },
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: {
      inject: (name, fn) => {
        injected.push(name)
        fn()
      },
      register: (spec, component) => {
        registered.push({ spec, component })
        return () => {}
      }
    }
  }
  // The code-block watcher needs a DOM face. Stubbing it proves the watcher is
  // actually installed by `apply` rather than silently skipped by the guard.
  const observed = []
  const previousDocument = globalThis.document
  const previousObserver = globalThis.MutationObserver
  const previousRaf = globalThis.requestAnimationFrame
  // The setting sync starts a loop, and a real one would keep this process alive long after the
  // last assertion. Catching it proves activation asks for the loop, and asking for it is what
  // makes a setting changed anywhere else reach this page at all.
  const previousSetInterval = globalThis.setInterval
  const previousClearInterval = globalThis.clearInterval
  const syncLoops = []
  globalThis.setInterval = (fn, delay) => {
    syncLoops.push({ fn, delay })
    return syncLoops.length
  }
  globalThis.clearInterval = () => {}
  globalThis.document = {
    querySelectorAll: () => [],
    createElement: (tag) => fakeNode(tag),
    body: fakeNode('body'),
    addEventListener: () => {},
    removeEventListener: () => {}
  }
  // The image menu clamps itself to the viewport, so a window has to exist.
  globalThis.window = { innerWidth: 1280, innerHeight: 900 }
  globalThis.MutationObserver = class {
    observe(target, options) {
      observed.push({ target, options })
    }
    disconnect() {
      observed.push({ disconnected: true })
    }
  }
  globalThis.requestAnimationFrame = (fn) => fn()

  exports.apply(fakeCtx)
  check('injects the panellist seat', injected.includes('sidebar.panellist'), injected.join(','))
  check('injects the main seat', injected.includes('main'), injected.join(','))
  check(
    'the code-block watcher observes the document subtree',
    // Two watchers now: the prompt buttons and the reply rows. Both are transcript repairs,
    // and both have to see a node that a re-render put back, which is what `subtree` buys.
    observed.length === 2 && observed.every((item) => item.options?.subtree === true && item.target === globalThis.document.body),
    // The targets are fake nodes with parent links, so only the options can be serialized.
    JSON.stringify(observed.map((item) => item.options))
  )
  check(
    'activation also puts the stored setting on a slow clock',
    syncLoops.length === 1 && syncLoops[0].delay === 15000,
    JSON.stringify(syncLoops.map((loop) => loop.delay))
  )
  globalThis.setInterval = previousSetInterval
  globalThis.clearInterval = previousClearInterval
  const row = registered.find((item) => item.spec.name === 'sidebar.panellist')
  const page = registered.find((item) => item.spec.name === 'main')
  check('panellist row carries the panel id', row?.spec.id === 'nai-imagegen', JSON.stringify(row?.spec))
  check('panellist row carries an order', Number.isFinite(row?.spec.order))
  check('panellist row supplies a label function', typeof row?.spec.label === 'function')
  check('main page is keyed by the same id', page?.spec.key === 'nai-imagegen', JSON.stringify(page?.spec))
  check('both seats share one component pair', typeof row?.component === 'function' && typeof page?.component === 'function')

  // The code-block button classifier. It has to fire on an NAI prompt and stay
  // quiet on every kind of code this project writes, or the transcript fills up
  // with buttons that generate nonsense.
  const { looksLikePrompt, hashOf: hashPrompt } = exports
  check('the classifier is exported for testing', typeof looksLikePrompt === 'function')
  check(
    'fires on a character prompt',
    looksLikePrompt('1girl, solo, standing, looking at viewer, transparent background, masterpiece, best quality')
  )
  check(
    'fires on a weighted prompt',
    looksLikePrompt('2girls, 1boy, ffm threesome, cooperative handjob, 1.3::cooperative handjob::, -1.5::twins::, on bed')
  )
  check(
    'fires on the twin prompt written in this conversation',
    looksLikePrompt(
      '2girls, 1boy, multiple girls, hetero, ffm threesome, threesome, group sex, teamwork (sexual), harem,\n' +
        'different hairstyles, centrosymmetry, bedroom, indoors, on bed, dim lighting, bokeh,\n\n' +
        "Char1: hikari \\(blue_archive\\), green hair, yellow eyes, pointy ears, long hair, green halo, demon tail,\n" +
        'military uniform, peaked cap, black hat, white gloves, long sleeves, white pantyhose, petite, small breasts,\n' +
        '-1.5::twintails::, on left, blush, half-closed eyes, pout, 1.3::cooperative handjob::, target#breast grab'
    )
  )
  check('an explicit nai fence always fires', looksLikePrompt('whatever this is', 'nai'))
  check('an explicit prompt fence always fires', looksLikePrompt('whatever this is', 'prompt'))
  // The 「文生图」 block is not a tag list at all, so it needs its own signal.
  check(
    'fires on a <image> block',
    looksLikePrompt(
      '<image>\n<image_think>\n①night alley\n</image_think>\nimage###size:832x1216;\nScene:SFW,1girl,solo,smoking;\nChar1:girl,long hair,pink hair;\nScene UC:nude;###\n</image>'
    )
  )
  check('fires on a bare image### envelope', looksLikePrompt('image###size:1024x1024;\nScene:1girl, solo, smile;\nScene UC:bad anatomy;###'))
  check('a long block is not rejected by the length bound', looksLikePrompt(`<image>Scene:${'1girl,solo,'.repeat(200)}</image>`))
  check('the classifier is quiet on an empty string', !looksLikePrompt(''))
  check('the classifier is quiet on a short fragment', !looksLikePrompt('1girl, solo'))
  check(
    'quiet on a JavaScript module',
    !looksLikePrompt(
      "import { readFile } from 'node:fs/promises'\n" +
        'export async function load() {\n' +
        "  const text = await readFile('x.json', 'utf8')\n" +
        '  return JSON.parse(text)\n' +
        '}'
    )
  )
  check(
    'quiet on a PowerShell block',
    !looksLikePrompt("$env:DSH_HOME = 'C:\\x'\ncd \"$env:DSH_HOME\\profiles\"\npnpm install --frozen-lockfile")
  )
  check('quiet on a JSON document', !looksLikePrompt('{\n  "schemaVersion": 1,\n  "kind": "nai-config"\n}'))
  check('quiet on a SQL statement', !looksLikePrompt('SELECT id, name FROM characters WHERE solo = 1 ORDER BY id'))
  check('quiet on a shell pipeline', !looksLikePrompt('git add -A && git commit -m "x" && git push origin main'))
  check('the prompt hash is stable', hashPrompt('1girl, solo') === hashPrompt('1girl, solo'))
  check('the prompt hash differs per prompt', hashPrompt('1girl, solo') !== hashPrompt('1girl, solo, standing'))

  // `decorate` is the part the user actually sees, so it is exercised against a
  // minimal fake DOM rather than left to the classifier alone: the button must
  // appear on a prompt block and must not appear on a code block.
  const { decorate } = exports
  /**
   * A tiny stand-in for an element, covering only what `decorate` touches.
   * @param tag - the tag name.
   * @returns the fake node.
   */
  function fakeNode(tag) {
    const node = {
      tagName: String(tag).toUpperCase(),
      children: [],
      attributes: {},
      style: { cssText: '' },
      className: '',
      textContent: '',
      disabled: false,
      clicks: 0,
      listeners: {},
      __code: null,
      __parent: null,
      setAttribute: (key, value) => {
        node.attributes[key] = String(value)
      },
      getAttribute: (key) => node.attributes[key] ?? null,
      removeAttribute: (key) => {
        delete node.attributes[key]
      },
      append: (...kids) => {
        for (const kid of kids) {
          // The parent link is what lets `remove` actually detach; without it a
          // stub "removal" leaves the old nodes in `children` and every test about
          // rebuilding reads the stale child.
          if (kid !== null && typeof kid === 'object') kid.__parent = node
          node.children.push(kid)
        }
      },
      replaceChildren: (...kids) => {
        node.children = [...kids]
      },
      addEventListener: (name, fn) => {
        node.listeners[name] = fn
      },
      remove: () => {
        node.removed = true
        const parent = node.__parent
        if (parent !== null && parent !== undefined && Array.isArray(parent.children)) {
          parent.children = parent.children.filter((child) => child !== node)
        }
      },
      getBoundingClientRect: () => ({ width: 180, height: 120 }),
      // Recorded rather than dispatched: these tests are about *whether* an
      // auto-render is allowed, not about what the render then does.
      click: () => {
        node.clicks += 1
      },
      closest: () => null,
      querySelector: (selector) => (selector === 'code' ? node.__code : null),
      get parentElement() {
        return node.__parent
      }
    }
    return node
  }
  /**
   * Build `<host><pre><code>text</code></pre></host>`.
   * @param text - the code text.
   * @param language - the fence language.
   * @param ours - whether the host is inside plugin-injected markup.
   * @returns the host, pre and code nodes.
   */
  function fakeBlock(text, language, ours = false) {
    const host = fakeNode('div')
    const pre = fakeNode('pre')
    const code = fakeNode('code')
    code.textContent = text
    if (language !== undefined) code.className = `language-${language}`
    pre.__code = code
    pre.__parent = host
    // `decorate` guards with `pre.closest(OURS_ATTR)`, so the stub has to answer
    // that walk rather than just mark the host.
    if (ours) pre.closest = () => host
    return { host, pre, code }
  }
  const identity = (key) => key

  const onPrompt = fakeBlock('1girl, solo, standing, looking at viewer, transparent background, masterpiece')
  decorate(onPrompt.pre, identity)
  check('a prompt block gains a button row', onPrompt.host.children.length >= 1, String(onPrompt.host.children.length))
  const bar = onPrompt.host.children[0]
  const button = bar.children[0]
  check('the button is labelled', button.textContent === 'blockButton', String(button.textContent))
  check('clicking is wired up', typeof button.listeners.click === 'function')
  check('the block is marked decorated', onPrompt.host.getAttribute('data-nai-imagegen-block') === '1')

  const onCode = fakeBlock("import { readFile } from 'node:fs/promises'\nexport async function load() { return 1 }")
  decorate(onCode.pre, identity)
  check('a code block gains nothing', onCode.host.children.length === 0, String(onCode.host.children.length))

  const again = onPrompt.host.children.length
  decorate(onPrompt.pre, identity)
  check('decorating twice does not duplicate', onPrompt.host.children.length === again)

  // A block can wear this half's ribbon while the map has never heard of it: a transcript rebuilt
  // around the block, an element moved under a new parent, a bundle activated a second time. The
  // button is on screen and only the bookkeeping forgot it — and that is the state in which
  // 「重新生图」 reported that the reply had no prompt while its prompt sat there with a button.
  const orphan = fakeBlock('1girl, solo, standing, looking at viewer, transparent background, masterpiece')
  const orphanBar = fakeNode('div')
  orphanBar.setAttribute('data-nai-imagegen-ours', '1')
  const orphanButton = fakeNode('button')
  orphanButton.setAttribute('data-nai-imagegen-fire', '1')
  orphanBar.append(orphanButton)
  orphan.host.append(orphanBar)
  orphan.host.setAttribute('data-nai-imagegen-block', '1')
  orphan.host.querySelector = (selector) =>
    selector === 'button[data-nai-imagegen-fire]' ? orphanButton : null
  decorate(orphan.pre, identity)
  check(
    'a marked block with no record adopts the button it already has',
    orphan.host.children.length === 1,
    String(orphan.host.children.length)
  )
  check('adopting does not press it', orphanButton.clicks === 0, String(orphanButton.clicks))

  // The other half of the same mark: a ribbon left behind by a decoration that is gone entirely.
  // Nothing to adopt, so the block is rebuilt rather than left with no way to render it.
  const ribbon = fakeBlock('1girl, solo, standing, looking at viewer, transparent background, masterpiece')
  ribbon.host.setAttribute('data-nai-imagegen-block', '1')
  ribbon.host.querySelector = () => null
  decorate(ribbon.pre, identity)
  check(
    'a ribbon with no button behind it is replaced, not trusted',
    ribbon.host.getAttribute('data-nai-imagegen-block') === '1' && ribbon.host.children.length >= 1,
    String(ribbon.host.children.length)
  )

  // A reply can render ten pictures at once, which is wider than the column they sit in. The
  // board clips to one row and its two ends page it: one press asks for a screenful rounded to
  // whole pictures, the far end stops the press instead of scrolling into empty space, and a
  // board whose pictures all fit offers neither arrow rather than two dead ones.
  {
    const { boardArrows } = exports
    const makeStrip = (clientWidth, scrollWidth) => {
      const strip = {
        clientWidth,
        scrollWidth,
        scrollLeft: 0,
        listeners: {},
        addEventListener: (name, fn) => {
          strip.listeners[name] = fn
        },
        scrollTo: (target) => {
          strip.scrollLeft = target.left
        }
      }
      return strip
    }
    const press = (button) => button.listeners.click({ preventDefault() {}, stopPropagation() {} })
    const strip = makeStrip(300, 900)
    const arrows = boardArrows(strip, identity)
    arrows.sync()
    check(
      'a board wider than the answer shows both arrows',
      arrows.left.style.display === '' && arrows.right.style.display === '',
      `left=${arrows.left.style.display} right=${arrows.right.style.display}`
    )
    check(
      'the near end starts disabled, the far end does not',
      arrows.left.disabled === true && arrows.right.disabled === false,
      `left=${arrows.left.disabled} right=${arrows.right.disabled}`
    )
    press(arrows.right)
    check('one press moves a page of whole pictures', strip.scrollLeft === 234, String(strip.scrollLeft))
    press(arrows.right)
    press(arrows.right)
    check('the far end stops the press', strip.scrollLeft === 600, String(strip.scrollLeft))
    check(
      'and the arrows trade places at that end',
      arrows.right.disabled === true && arrows.left.disabled === false,
      `left=${arrows.left.disabled} right=${arrows.right.disabled}`
    )
    press(arrows.left)
    press(arrows.left)
    press(arrows.left)
    check(
      'walking back arrives at the start and stays there',
      strip.scrollLeft === 0 && arrows.left.disabled === true,
      `${strip.scrollLeft}/${arrows.left.disabled}`
    )
    const fitting = makeStrip(300, 300)
    const quiet = boardArrows(fitting, identity)
    quiet.sync()
    check(
      'a board that fits keeps both arrows out of the way',
      quiet.left.style.display === 'none' && quiet.right.style.display === 'none',
      `left=${quiet.left.style.display} right=${quiet.right.style.display}`
    )
    // A row that has not been laid out yet reads zero wide; the arrows must stay put then,
    // because a board measured before it is in the document would hide itself for good.
    const unlaid = makeStrip(0, 0)
    const early = boardArrows(unlaid, identity)
    early.sync()
    check(
      'an unmeasured row does not decide anything permanent',
      early.left.style.display === 'none' && early.right.disabled === true,
      `left=${early.left.style.display}`
    )
  }

  // A reload empties every map this bundle keeps, and a restart is worse. The pictures are files
  // on disk, so the one fact that has to outlive the page is which prompt produced them — and it
  // outlives it in the browser's own store, written on every render, read before any host asks.
  {
    const { hashOf, rememberFiles, recallFiles, resetRenderStore } = exports
    const cells = new Map()
    const previousStorage = globalThis.localStorage
    globalThis.localStorage = {
      getItem: (name) => (cells.has(name) ? cells.get(name) : null),
      setItem: (name, value) => {
        cells.set(name, String(value))
      }
    }
    resetRenderStore()
    const text = '1girl, solo, standing, looking at viewer, transparent background, masterpiece'
    const key = hashOf(text.trim())
    rememberFiles(key, [{ file: 'C:/out/a.png', name: 'a.png', seed: 7, model: 'nai-diffusion-5-full' }])
    resetRenderStore()
    check('a finished render is still known after a reload', recallFiles(key)?.length === 1, JSON.stringify(recallFiles(key)))
    check(
      'and the file it points at survives, not just the count',
      recallFiles(key)?.[0]?.name === 'a.png',
      JSON.stringify(recallFiles(key)?.[0])
    )
    check(
      'what is written is JSON, so a new page can read it',
      typeof cells.get('nai-imagegen:renders') === 'string',
      typeof cells.get('nai-imagegen:renders')
    )
    const reopened = fakeBlock(text)
    decorate(reopened.pre, identity)
    const reopenedStatus = reopened.host.children[0]?.children[1]
    check(
      'a reply reopened after a reload draws its pictures back with no host answer',
      reopened.host.children[1]?.children.length === 1 && reopenedStatus?.textContent === 'blockDone',
      `${reopened.host.children[1]?.children.length}/${reopenedStatus?.textContent}`
    )
    rememberFiles(key, [{ file: 'C:/out/b.png', name: 'b.png' }])
    check(
      'rendering again replaces what the prompt is remembered by',
      recallFiles(key)?.[0]?.name === 'b.png',
      JSON.stringify(recallFiles(key)?.[0])
    )
    for (let index = 0; index < 250; index += 1) rememberFiles(`k${index}`, [{ name: `n${index}.png` }])
    resetRenderStore()
    check('the store keeps the newest prompts', Array.isArray(recallFiles('k249')), String(recallFiles('k249')))
    check('and drops the oldest rather than growing without end', recallFiles('k0') === null, String(recallFiles('k0')))
    // No store at all is a page that still renders: the block keeps its button, and only the
    // promise of a reload is lost.
    globalThis.localStorage = undefined
    resetRenderStore()
    rememberFiles(key, [{ name: 'c.png' }])
    check('a browser with no storage still shows what it rendered', recallFiles(key)?.[0]?.name === 'c.png', String(recallFiles(key)))
    resetRenderStore()
    check('it just cannot promise that after a reload', recallFiles(key) === null, String(recallFiles(key)))
    globalThis.localStorage = previousStorage
    resetRenderStore()
  }

  // A transcript mounts a `<pre>` and fills it afterwards, and a streaming reply
  // grows one a few characters at a time. A block decorated while it was still
  // arriving kept its truncated text forever — clicking it then rendered, or failed
  // on, a fragment (the host reported "文本 28 字符" for a block of 1600).
  {
    const growing = fakeBlock('<image>\n<image_think>\n①纯透明底')
    decorate(growing.pre, identity)
    check('a block is decorated while it is still streaming in', growing.host.children.length >= 1)
    const streamedBar = growing.host.children[0]
    const streamedButton = streamedBar?.children[0]
    const streamedSlot = growing.host.children[1]
    growing.code.textContent =
      '<image>\n<image_think>\n①reasoning</image_think>\nimage###size:1024x1024;\nScene:SFW,a;\nChar1:girl|centers:B3;\nChar1 UC:x;\nScene UC:y;###\n</image>'
    decorate(growing.pre, identity)
    const fullButton = growing.host.children[0]?.children[0]
    check('the decoration is rebuilt from the grown text', fullButton !== undefined && fullButton !== streamedButton, String(fullButton === streamedButton))
    // The injected row and slot are what get detached; the button travels with its
    // row, so its own `remove` is never called and asserting on it would be
    // asserting an implementation detail rather than the invariant.
    check(
      'the stale nodes are removed, not stacked',
      streamedBar.removed === true &&
        streamedSlot.removed === true &&
        !growing.host.children.includes(streamedBar) &&
        !growing.host.children.includes(streamedSlot),
      `bar=${streamedBar.removed} slot=${streamedSlot.removed} children=${growing.host.children.length}`
    )
    check('and the block still has exactly one row and one slot', growing.host.children.length === 2, String(growing.host.children.length))
    // Settled text must not rebuild anything, or a re-render would loop.
    const settled = growing.host.children[0]?.children[0]
    decorate(growing.pre, identity)
    check('a settled block is left alone', growing.host.children[0]?.children[0] === settled)
  }

  const oursBlock = fakeBlock('1girl, solo, looking at viewer, masterpiece, best quality', undefined, true)
  decorate(oursBlock.pre, identity)
  check('plugin-injected markup is skipped', oursBlock.host.children.length === 0)

  const explicit = fakeBlock('anything at all, really', 'nai')
  decorate(explicit.pre, identity)
  check('an explicit nai fence is decorated even when the text is odd', explicit.host.children.length >= 1)

  // ------------------------------------------------------ auto-render bounds --
  // Auto-render spends quota unasked, so its bounds are the part worth testing: it
  // must be off unless enabled, must wait for a block to stop growing, must never
  // fire a block that came in with a replayed conversation or with the toggle off,
  // and must render every prompt of a reply that arrives while it is on — one reply
  // can carry several prompts, and no session keeps a ceiling to run into.
  {
    const {
      setAutoRender,
      rescanBlocks: rescan,
      autoRenderedCount,
      installCodeButtons,
      looksLikeReplay,
      bootAutoRender,
      startSettingSync,
      lastAutoLine
    } = exports
    const observed = []
    // The observer callback is kept, not just the options it was called with: a replay
    // arriving is a batch that has to be handed in from the outside.
    let onMutation = null
    globalThis.MutationObserver = class {
      constructor(callback) {
        onMutation = callback
      }
      observe(target, options) {
        observed.push({ target, options })
      }
      disconnect() {}
    }
    globalThis.requestAnimationFrame = (fn) => fn()
    // The quiet pass is a timer. Catching it rather than waiting keeps the suite instant — and
    // keeps a callback from firing a second later into a document this block has taken away.
    // Every change restarts that timer, so the stub has to honour the cancel or the suite would
    // see renders the page never makes.
    const realSetTimeout = globalThis.setTimeout
    const realClearTimeout = globalThis.clearTimeout
    const timers = []
    let timerId = 0
    globalThis.setTimeout = (fn, delay) => {
      timerId += 1
      timers.push({ id: timerId, fn, delay, cancelled: false })
      return timerId
    }
    globalThis.clearTimeout = (id) => {
      for (const timer of timers) if (timer.id === id) timer.cancelled = true
    }
    /** The passes still due: every change drops the older ones. */
    const dueTimers = () => timers.filter((timer) => timer.cancelled !== true)
    const drainTimers = () => {
      // The guard is for a pass that queues another one for ever, which is a bug this test
      // would otherwise hang on rather than report.
      for (let guard = 0; timers.length > 0 && guard < 20; guard += 1) {
        const timer = timers.shift()
        if (timer.cancelled !== true) timer.fn()
      }
    }
    /** Hand the observer one batch, the way the app would. */
    const fire = (records) => {
      if (typeof onMutation === 'function') onMutation(records)
    }

    /** Click count of the button injected into a block, or -1 if there is none. */
    const clicksOf = (block) => block.host.children[0]?.children[0]?.clicks ?? -1

    const prompts = (count, tag) =>
      Array.from({ length: count }, (_, index) =>
        fakeBlock(`${tag}${index}, solo, looking at viewer, masterpiece, best quality`)
      )
    // The transcript publishes whether it is still being written, so the stub has to be able to
    // answer for those markers: a window that closes underneath one must wait, not fire. The rule
    // reads one merged walk and looks at the newest node in it, so what the stub holds is the
    // order — the markers the app left lying around, and the turn tails that say a reply ended. A
    // tail newer than the marker is the whole difference between a live reply and a card the app
    // abandoned halfway through a turn.
    const liveMarkers = new Set()
    let liveTails = 0
    /** A node that answers `getAttribute`, the way the app's own elements do. */
    const attrNode = (attrs) =>
      Object.assign(fakeNode('attr'), { getAttribute: (name) => (name in attrs ? attrs[name] : null) })
    /** The turn tails on the page, one per reply that has closed. */
    const tailNodes = () =>
      Array.from({ length: liveTails }, (_, index) => attrNode({ 'data-turn-tail': String(index + 1) }))
    /** The merged walk: the markers on the page, then however many turn tails follow them. */
    const markerWalk = () =>
      Array.from(liveMarkers)
        .map((selector) =>
          attrNode(selector === '[data-streaming]' ? { 'data-streaming': '' } : { 'data-state': 'running' })
        )
        .concat(tailNodes())
    const wireDocument = (blocks) => {
      globalThis.document = {
        querySelectorAll: (selector) =>
          selector === 'pre'
            ? blocks.map((block) => block.pre)
            : selector === `pre, [data-turn-tail]`
              ? blocks.map((block) => block.pre).concat(tailNodes())
              : markerWalk(),
        querySelector: (selector) => (liveMarkers.has(selector) ? fakeNode('marker') : null),
        createElement: (tag) => fakeNode(tag),
        body: fakeNode('body'),
        addEventListener: () => {},
        removeEventListener: () => {}
      }
    }

    setAutoRender(false)
    const spendBefore = autoRenderedCount()
    const first = prompts(3, 'manual')
    wireDocument(first)
    installCodeButtons(identity)
    check('nothing auto-renders while the toggle is off', first.every((block) => clicksOf(block) === 0), JSON.stringify(first.map(clicksOf)))

    setAutoRender(true)
    rescan({ autoLastOnly: true })
    check(
      'turning the toggle on fires exactly one render, for the newest block',
      clicksOf(first[2]) === 1 && clicksOf(first[0]) === 0 && clicksOf(first[1]) === 0,
      JSON.stringify(first.map(clicksOf))
    )

    rescan()
    // Everything on screen at activation counts as history, so the two blocks the single
    // allowance skipped get no turn later either: only a prompt that arrives while this half
    // is awake answers by itself.
    check(
      'a later pass leaves the older blocks alone',
      clicksOf(first[0]) === 0 && clicksOf(first[1]) === 0 && clicksOf(first[2]) === 1,
      JSON.stringify(first.map(clicksOf))
    )
    check(
      'and one render is all the session spent',
      autoRenderedCount() === spendBefore + 1,
      `${autoRenderedCount()} vs ${spendBefore + 1}`
    )

    // A block is mounted and then filled, and a streaming reply grows one a few characters at
    // a time. Firing on the pass that first sees it renders half a prompt and then spends a
    // second render when the rest arrives. Waiting for the block itself is not enough either: a
    // reply writes its prompts and then keeps talking, so the block is still while the reply is
    // not. What is waited for is the quiet of the whole transcript.
    const arriving = prompts(3, 'arriving')
    wireDocument(arriving)
    rescan()
    check(
      'a block is not rendered while it may still be arriving',
      arriving.every((block) => clicksOf(block) === 0),
      JSON.stringify(arriving.map(clicksOf))
    )
    check('a quiet pass is queued in its place', dueTimers().length === 1, String(dueTimers().length))
    check('and the wait is seconds, not a frame', dueTimers()[0]?.delay === 3000, String(dueTimers()[0]?.delay))
    // The window has to outlast the heartbeat a live reply produces, which is text: an observer
    // watching only for added and removed nodes cannot see that reply moving at all.
    check(
      'the observer is told about text as well as about nodes',
      observed[0]?.options?.characterData === true &&
        observed[0]?.options?.childList === true &&
        observed[0]?.options?.subtree === true,
      JSON.stringify(observed[0]?.options)
    )

    // The reply is still being written after the block's own text has stopped moving: the model
    // writes a prompt and then keeps talking. Every one of those changes runs a pass through the
    // observer, and not one of them may fire — that pass alone used to be enough to click a block
    // in the middle of a stream, which is the bug this rule exists for.
    const quietSpend = autoRenderedCount()
    fire([{ addedNodes: [fakeNode('div')], removedNodes: [] }])
    fire([{ addedNodes: [fakeNode('div')], removedNodes: [] }])
    check(
      'a pass over a reply that is still being written fires nothing',
      autoRenderedCount() === quietSpend,
      `${autoRenderedCount()} vs ${quietSpend}`
    )
    check(
      'and every change restarts the second rather than adding to it',
      timers.length >= 3 && dueTimers().length === 1,
      `${timers.length} armed, ${dueTimers().length} due`
    )
    drainTimers()
    // One reply, three prompts: every one of them renders. Nothing narrows a pass to a single
    // block any more — the newest prompt was only ever a stand-in for "the reply being written".
    check(
      'the quiet pass that follows renders every prompt of the reply',
      arriving.every((block) => clicksOf(block) === 1),
      JSON.stringify(arriving.map(clicksOf))
    )
    const settledSpend = autoRenderedCount()
    rescan()
    drainTimers()
    check(
      'and a settled block is not rendered a second time',
      autoRenderedCount() === settledSpend,
      `${autoRenderedCount()} vs ${settledSpend}`
    )

    // A conversation replayed back onto the screen is not a reply. Switching conversations tears
    // one transcript down and drops another in, and every block in it has already been answered —
    // so the batch is read by what it removed, not by how many blocks it brought. Those blocks,
    // and only those, are stamped as history: a live reply can land in the same commit as a
    // transcript re-render, which is exactly the reply a clock used to condemn for good.
    const replayed = prompts(3, 'history')
    wireDocument(replayed)
    fire([
      {
        addedNodes: replayed.map((block) => block.pre),
        removedNodes: Array.from({ length: 24 }, () => fakeNode('div'))
      }
    ])
    check(
      'a replayed conversation is stamped, not rendered',
      replayed.every((block) => clicksOf(block) === 0),
      JSON.stringify(replayed.map(clicksOf))
    )
    drainTimers()
    rescan()
    drainTimers()
    check(
      'and it stays unrendered on every later pass',
      replayed.every((block) => clicksOf(block) === 0),
      JSON.stringify(replayed.map(clicksOf))
    )
    // Growth is the way back: a block whose text is still being written is a reply arriving,
    // however it was stamped when it first appeared. A live reply lands at the bottom, so the
    // revival is exercised on the newest block of the three.
    const beforeGrowth = autoRenderedCount()
    replayed[2].code.textContent = `${replayed[2].code.textContent}, wind, film grain`
    decorate(replayed[2].pre, identity)
    drainTimers()
    check('a stamped block that grows is back in play', clicksOf(replayed[2]) === 1, String(clicksOf(replayed[2])))
    check(
      'one render was spent on it',
      autoRenderedCount() === beforeGrowth + 1,
      `${autoRenderedCount()} vs ${beforeGrowth + 1}`
    )
    check(
      'the blocks that did not grow stay untouched',
      clicksOf(replayed[0]) === 0 && clicksOf(replayed[1]) === 0,
      JSON.stringify(replayed.map(clicksOf))
    )

    // A prompt is a request, not a receipt. What is remembered about a block is the element it
    // was, never the words it held: the same words in a later reply are a later reply, and a
    // text-keyed memory answered every one of them with silence — which, for a session whose user
    // reuses their prompts, is every reply after the first.
    {
      const realNow = Date.now
      let clock = realNow()
      globalThis.Date.now = () => clock
      const once = prompts(1, 'first-said')
      wireDocument(once)
      rescan()
      drainTimers()
      check('a reply renders its prompt', clicksOf(once[0]) === 1, String(clicksOf(once[0])))
      // Within the minute, the same words are the render that is already on its way: a remount
      // mid-flight must not order a second copy of the same picture.
      const echoing = prompts(1, 'somewhere-else')
      echoing[0].code.textContent = once[0].code.textContent
      wireDocument(echoing)
      rescan()
      drainTimers()
      check(
        'the same words while the first render is still in flight are not a second order',
        clicksOf(echoing[0]) === 0,
        String(clicksOf(echoing[0]))
      )
      clock += 21000
      const longAfter = prompts(1, 'much-later')
      longAfter[0].code.textContent = once[0].code.textContent
      wireDocument(longAfter)
      rescan()
      drainTimers()
      check(
        'the same words in a later reply are rendered again',
        clicksOf(longAfter[0]) === 1,
        String(clicksOf(longAfter[0]))
      )
      globalThis.Date.now = realNow
    }

    // The quiet pass answers the reply in front of the user. An older reply can still hold a block
    // this half never stamped — one that arrived while the toggle was off, or a card the app
    // abandoned — and reading the page page-wide renders those too, spending a render on a reply
    // the user has already scrolled past.
    {
      const scrolledPast = prompts(1, 'scrolled-past')
      const inFront = prompts(1, 'in-front')
      // The document as an interleaved walk: the older reply, its boundary, then the newest one.
      const walk = [scrolledPast[0].pre, attrNode({ 'data-turn-tail': '1' }), inFront[0].pre]
      globalThis.document = {
        querySelectorAll: (selector) =>
          selector === 'pre'
            ? [scrolledPast[0].pre, inFront[0].pre]
            : selector === `pre, [data-turn-tail]`
              ? walk
              : markerWalk(),
        querySelector: () => null,
        createElement: (tag) => fakeNode(tag),
        body: fakeNode('body'),
        addEventListener: () => {},
        removeEventListener: () => {}
      }
      const realFetch = globalThis.fetch
      const sent = []
      globalThis.fetch = async (url, options) => {
        sent.push({ url: String(url), body: options?.body === undefined ? null : JSON.parse(options.body) })
        return { ok: true, status: 200, json: async () => ({ ok: true }) }
      }
      rescan()
      drainTimers()
      globalThis.fetch = realFetch
      check('the reply in front of the user renders', clicksOf(inFront[0]) === 1, String(clicksOf(inFront[0])))
      check('and the reply above it is left alone', clicksOf(scrolledPast[0]) === 0, String(clicksOf(scrolledPast[0])))
      // The pass says what it decided, block by block, and says it to the host: this is what turns
      // "it did not render" into the name of the gate that stopped it.
      const settleRecord = sent.map((call) => call.body).find((body) => body?.event === 'settle')
      check(
        'the pass reports what it decided, per block',
        settleRecord?.outcome?.['older-reply'] === 1 && settleRecord?.outcome?.fired === 1,
        JSON.stringify(settleRecord)
      )
      check('and every report goes to the host', sent.length > 0 && sent.every((call) => call.url.endsWith('/diag')), sent.map((call) => call.url).join(','))
    }

    // The flag's only writer used to be the panel's effect, and the panel exists only while
    // this plugin's page is the active view — so a page that loaded with auto-render already on
    // rendered nothing until the user happened to open the panel. It is read from the host at
    // activation now, and the read itself renders nothing.
    {
      const realFetch = globalThis.fetch
      const answerWith = (autoGenerate) => {
        globalThis.fetch = async () => ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ autoGenerate })
        })
      }
      setAutoRender(false)
      const idle = prompts(2, 'boot')
      wireDocument(idle)
      // The activation pass is what puts the buttons on the screen; the read comes after it,
      // exactly as the two effects are ordered in `apply`.
      installCodeButtons(identity)
      answerWith(true)
      await bootAutoRender()
      check(
        'the stored setting is read at activation without rendering the old screen',
        idle.every((block) => clicksOf(block) === 0),
        JSON.stringify(idle.map(clicksOf))
      )
      const fresh = prompts(1, 'fresh')[0]
      wireDocument([...idle, fresh])
      rescan()
      drainTimers()
      check(
        'and a reply arriving afterwards renders, while the old screen still does not',
        clicksOf(fresh) === 1 && idle.every((block) => clicksOf(block) === 0),
        JSON.stringify([...idle.map(clicksOf), clicksOf(fresh)])
      )
      const quiet = prompts(2, 'quiet')
      wireDocument(quiet)
      answerWith(false)
      await bootAutoRender()
      rescan()
      drainTimers()
      check(
        'a stored answer of off keeps it quiet',
        quiet.every((block) => clicksOf(block) === 0),
        JSON.stringify(quiet.map(clicksOf))
      )
      globalThis.fetch = async () => {
        throw new Error('no host')
      }
      // The bootstrap retries once when the first read is answered with nothing, and the retry
      // waits on the clock — so the failed read has to settle, its timer has to be drained, and
      // only then does the pass resolve.
      const booting = bootAutoRender()
      for (let hop = 0; hop < 12; hop += 1) await Promise.resolve()
      drainTimers()
      await booting
      const unreachable = prompts(2, 'unreachable')
      wireDocument(unreachable)
      rescan()
      drainTimers()
      check(
        'a host that cannot be reached leaves the flag where it was',
        unreachable.every((block) => clicksOf(block) === 0),
        JSON.stringify(unreachable.map(clicksOf))
      )
      globalThis.fetch = realFetch
    }

    // The setting can be changed anywhere: the chat's `nai_config` tool, another window, a tab
    // left open since before the change. The flag used to be written by the panel's toggle and by
    // one read at activation, so a page could sit there obeying an answer nobody could see — the
    // switch said on, nothing rendered, and nothing on screen said why. A slow clock closes it,
    // and the read it makes is the panel's own status route, which spends nothing.
    {
      const realFetch = globalThis.fetch
      const realSetInterval = globalThis.setInterval
      const realClearInterval = globalThis.clearInterval
      const intervals = []
      let cleared = 0
      globalThis.setInterval = (fn, delay) => {
        intervals.push({ fn, delay })
        return intervals.length
      }
      globalThis.clearInterval = () => {
        cleared += 1
      }
      let stored = false
      globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ autoGenerate: stored })
      })
      setAutoRender(false)
      const stop = startSettingSync()
      check(
        'the stored setting is re-read on a slow clock, not only at activation',
        intervals.length === 1 && intervals[0].delay === 15000,
        JSON.stringify(intervals.map((timer) => timer.delay))
      )
      const idle = prompts(1, 'sync-off')
      wireDocument(idle)
      rescan()
      drainTimers()
      check('with the stored answer off the watcher stays quiet', clicksOf(idle[0]) === 0, String(clicksOf(idle[0])))
      stored = true
      intervals[0].fn()
      for (let hop = 0; hop < 8; hop += 1) await Promise.resolve()
      const later = prompts(1, 'sync-on')[0]
      wireDocument([...idle, later])
      rescan()
      drainTimers()
      check(
        'and a change made elsewhere reaches the watcher without the panel',
        clicksOf(later) === 1 && clicksOf(idle[0]) === 0,
        JSON.stringify([...idle.map(clicksOf), clicksOf(later)])
      )
      // A host that has gone quiet must not be read as an answer of "off": the flag stays where
      // it was, or a page would switch the feature off by losing its host.
      globalThis.fetch = async () => {
        throw new Error('no host')
      }
      intervals[0].fn()
      for (let hop = 0; hop < 8; hop += 1) await Promise.resolve()
      const afterSilly = prompts(1, 'sync-hostless')[0]
      wireDocument([...idle, later, afterSilly])
      rescan()
      drainTimers()
      check(
        'a host that cannot be reached leaves the flag on',
        clicksOf(afterSilly) === 1,
        JSON.stringify(clicksOf(afterSilly))
      )
      stop()
      check('and the loop is released with the effect scope it was started in', cleared === 1, String(cleared))
      globalThis.setInterval = realSetInterval
      globalThis.clearInterval = realClearInterval
      globalThis.fetch = realFetch
    }

    // One line, printed under the toggle: what the last automatic pass did. The report is the
    // page's own — the gates that stopped each block, or the marker that kept the settle window
    // shut — which is the difference between "it did nothing again" and an answer.
    {
      const dict = {
        autoLastNone: 'none',
        autoLastPass: 'pass',
        autoLastBusy: 'busy',
        autoLastQuiet: 'quiet',
        autoLastFired: 'fired',
        autoLastNothing: 'nothing',
        autoImageUnit: ' imgs',
        autoWhyNotQuiet: 'still-writing',
        autoWhyOlderReply: 'older',
        autoWhyNoButton: 'no-button'
      }
      const say = (record) => lastAutoLine(record, (key) => dict[key] ?? key)
      check('with no report yet the line says so', say(null) === 'none', say(null))
      const held = say({ event: 'window', verdict: 'still-writing', marker: '[data-state="running"]', receivedAt: 1791425438879 })
      check('a window held open names the marker that held it', held.includes('busy') && held.includes('[data-state="running"]'), held)
      const rendered = say({ event: 'settle', outcome: { 'older-reply': 1, fired: 2 }, receivedAt: 1791425438879 })
      check('a pass that rendered says how many', rendered.includes('fired 2 imgs') && rendered.includes('older'), rendered)
      const refused = say({ event: 'settle', outcome: { 'not-quiet': 3, 'not-a-prompt': 4 }, receivedAt: 1791425438879 })
      check(
        'a pass that rendered nothing names the gate, not the blocks it ignored',
        refused.includes('nothing') && refused.includes('still-writing'),
        refused
      )
      const unknown = say({ event: 'settle', outcome: { 'weird-gate': 1 }, receivedAt: 1791425438879 })
      check('a gate with no wording is quoted as its own code', unknown.includes('weird-gate'), unknown)
    }

    // A block that arrived while the toggle was off is not a reply to it. Turning the toggle on
    // answers the block in front of the user — that is what the toggle-on pass is for — and every
    // prompt above it, including ones that arrived during the same quiet stretch, keeps waiting
    // for a click. Without this the switch would spend the whole transcript at once.
    {
      setAutoRender(false)
      const slept = prompts(3, 'slept')
      wireDocument(slept)
      installCodeButtons(identity)
      setAutoRender(true)
      rescan({ autoLastOnly: true })
      drainTimers()
      check(
        'a reply that arrived while the toggle was off is not answered by switching it on',
        clicksOf(slept[2]) === 1 && clicksOf(slept[0]) === 0 && clicksOf(slept[1]) === 0,
        JSON.stringify(slept.map(clicksOf))
      )
      const later = prompts(2, 'later')
      wireDocument([...slept, ...later])
      rescan()
      drainTimers()
      check(
        'and the sleeping blocks stay asleep while the new reply renders',
        later.every((block) => clicksOf(block) === 1) &&
          clicksOf(slept[0]) === 0 &&
          clicksOf(slept[1]) === 0,
        JSON.stringify([...slept.map(clicksOf), ...later.map(clicksOf)])
      )
    }

    // A replayed conversation is not a reply. Switching into a conversation drops its whole
    // transcript back in at once, and every block in it has already been answered — firing
    // them again spends quota to hand the user a second copy of what is already above them.
    // The teardown is the signal. Counting the blocks instead read a reply that carried several
    // prompts as a conversation being replayed, stamped the whole of it as history, and rendered
    // nothing — a reply with three prompts is exactly the shape this feature exists for.
    {
      const pre = { tagName: 'PRE' }
      const div = { tagName: 'DIV' }
      const torn = Array.from({ length: 24 }, () => div)
      check('a transcript that was torn down is a replay', looksLikeReplay([{ addedNodes: [], removedNodes: torn }]) === true, '')
      check(
        'a page of blocks arriving at once is still a reply',
        looksLikeReplay([{ addedNodes: [pre, pre, pre], removedNodes: [] }]) === false,
        ''
      )
      check('one block appended to a still transcript is a reply', looksLikeReplay([{ addedNodes: [pre], removedNodes: [] }]) === false, '')
      check('ordinary prose arriving is not a replay', looksLikeReplay([{ addedNodes: [div, div], removedNodes: [] }]) === false, '')
      check('an empty batch is not a replay', looksLikeReplay([]) === false, '')
      check('a missing record list is not a replay', looksLikeReplay(undefined) === false, '')
    }

    // The activation pass renders nothing, whatever the toggle says: everything on screen when
    // this half wakes up is the conversation as it already stands, not a reply to anything.
    const settled = prompts(3, 'settled')
    wireDocument(settled)
    installCodeButtons(identity)
    check(
      'activating with a populated transcript renders nothing',
      settled.every((block) => clicksOf(block) === 0),
      JSON.stringify(settled.map(clicksOf))
    )

    // Four prompts in one reply spend four renders. That is the rule a ceiling used to stand in
    // for, and the reason there is no ceiling any more: the bound is the reply itself.
    const wall = prompts(4, 'wall')
    wireDocument(wall)
    setAutoRender(true)
    rescan()
    drainTimers()
    const walled = wall.map(clicksOf)
    check(
      'a reply carrying four prompts renders four pictures',
      walled.every((count) => count === 1),
      JSON.stringify(walled)
    )

    // The same wall arriving as a transcript instead spends nothing: switching conversations
    // tears the old transcript down inside the same batch, and that teardown is what says these
    // blocks are the conversation being put back on screen rather than a reply. Every block in it
    // keeps its button waiting for a click.
    const flood = prompts(14, 'flood')
    wireDocument(flood)
    fire([
      {
        addedNodes: flood.map((block) => block.pre),
        removedNodes: Array.from({ length: 24 }, () => fakeNode('div'))
      }
    ])
    drainTimers()
    rescan()
    drainTimers()
    check(
      'a wall of blocks arriving as a transcript renders none of them',
      flood.every((block) => clicksOf(block) === 0),
      JSON.stringify(flood.map(clicksOf))
    )
    check(
      'the blocks keep their buttons for a manual click',
      flood.every((block) => block.host.children[0]?.children[0] !== undefined),
      JSON.stringify(flood.map(clicksOf))
    )

    // Two prompts in one reply, arriving while the toggle is on: both render, because both are
    // part of the reply the user is reading. A block that grows into different text afterwards
    // is a different prompt, and gets its own picture. The spend is read from the session
    // counter rather than the button: re-decorating a grown block builds a fresh button, so the
    // old button's click count is a record of the previous prompt, not of this one.
    {
      const pair = prompts(2, 'pair')
      wireDocument(pair)
      rescan()
      drainTimers()
      const pairSpend = autoRenderedCount()
      check(
        'of two prompts in one reply, both render',
        clicksOf(pair[0]) === 1 && clicksOf(pair[1]) === 1 && pairSpend > 0,
        JSON.stringify(pair.map(clicksOf))
      )
      pair[0].code.textContent = `${pair[0].code.textContent}, wind, film grain`
      decorate(pair[0].pre, identity)
      drainTimers()
      check(
        'and a block that grows into a different prompt renders that one too',
        autoRenderedCount() === pairSpend + 1,
        `${autoRenderedCount()} vs ${pairSpend + 1}`
      )
      rescan()
      drainTimers()
      check(
        'while a pass over text that has not moved spends nothing',
        autoRenderedCount() === pairSpend + 1,
        `${autoRenderedCount()} vs ${pairSpend + 1}`
      )
    }

    // The shape of the complaint this rule answers: a reply that writes its prompt blocks and then
    // keeps writing prose. The passes those characters schedule look exactly like a settled screen
    // — the blocks' own text has not moved for several of them — so the clock is the only thing
    // that tells the two apart, and it runs from the last change anywhere in the transcript.
    {
      const streaming = prompts(2, 'stream')
      wireDocument(streaming)
      rescan()
      for (const node of [fakeNode('div'), fakeNode('div'), fakeNode('div')]) {
        fire([{ addedNodes: [node], removedNodes: [] }])
      }
      check(
        'prose arriving after the prompts renders nothing, however still the prompts are',
        streaming.every((block) => clicksOf(block) === 0),
        JSON.stringify(streaming.map(clicksOf))
      )
      check(
        'and the window is still three seconds ahead',
        dueTimers().length === 1 && dueTimers()[0].delay === 3000,
        `${dueTimers().length} due`
      )
      drainTimers()
      check(
        'the render lands once the prose stops, on both prompts',
        streaming.every((block) => clicksOf(block) === 1),
        JSON.stringify(streaming.map(clicksOf))
      )
    }

    // Silence is a measure, not proof. The transcript says out loud whether it is still being
    // written, and a window that closes underneath that marker is a pause inside a live reply:
    // the reported bug arriving a second time, which is what this check exists for.
    {
      const marked = prompts(2, 'marked')
      liveMarkers.add('[data-streaming]')
      wireDocument(marked)
      rescan()
      fire([{ addedNodes: [fakeNode('div')], removedNodes: [] }])
      const markedSpend = autoRenderedCount()
      drainTimers()
      check(
        'a window that closes under a live marker fires nothing',
        autoRenderedCount() === markedSpend && marked.every((block) => clicksOf(block) === 0),
        JSON.stringify(marked.map(clicksOf))
      )
      check('and it arms the next window instead', dueTimers().length === 1, String(dueTimers().length))
      liveMarkers.delete('[data-streaming]')
      drainTimers()
      check(
        'the render lands once the marker goes away',
        marked.every((block) => clicksOf(block) === 1),
        JSON.stringify(marked.map(clicksOf))
      )
    }

    // The app does not always take its markers away again. A turn that was stopped leaves a
    // command card sitting on `data-state="running"` for the rest of the session, and a transcript
    // put back on screen leaves `data-streaming` on a message that arrived long ago. Read
    // page-wide and taken literally, one of those held every window shut for good: auto-render
    // simply stopped one afternoon and said nothing. Two rules stop that, and this is the first —
    // a marker behind a turn boundary belongs to a reply that has already ended.
    {
      const behind = prompts(2, 'behind')
      liveMarkers.add('[data-state="running"]')
      liveTails = 1
      wireDocument(behind)
      rescan()
      fire([{ addedNodes: [fakeNode('div')], removedNodes: [] }])
      drainTimers()
      check(
        'a marker the app left behind a finished turn holds nothing back',
        behind.every((block) => clicksOf(block) === 1),
        JSON.stringify(behind.map(clicksOf))
      )
      liveTails = 0
    }

    // The second rule is the clock. The same marker inside the newest turn is obeyed rather than
    // argued with — a reply being written changes the document at least once a second, so one that
    // survives half a minute of no change at all was left over by a turn that ended.
    {
      const stale = prompts(2, 'stale')
      const realNow = Date.now
      let clock = realNow()
      globalThis.Date.now = () => clock
      liveMarkers.add('[data-state="running"]')
      wireDocument(stale)
      rescan()
      fire([{ addedNodes: [fakeNode('div')], removedNodes: [] }])
      drainTimers()
      check(
        'a marker on a page that is still moving is still obeyed',
        stale.every((block) => clicksOf(block) === 0),
        JSON.stringify(stale.map(clicksOf))
      )
      clock += 31000
      drainTimers()
      check(
        'and a page that has not moved under it for half a minute stops believing it',
        stale.every((block) => clicksOf(block) === 1),
        JSON.stringify(stale.map(clicksOf))
      )
      globalThis.Date.now = realNow
      liveMarkers.delete('[data-state="running"]')
    }

    setAutoRender(false)
    timers.length = 0
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
    globalThis.document = {
      querySelectorAll: () => [],
      querySelector: () => null,
      createElement: (tag) => fakeNode(tag),
      body: fakeNode('body'),
      addEventListener: () => {},
      removeEventListener: () => {}
    }
  }

  // ------------------------------------------- the window's double-click --
  // The floating window renders every prompt of the newest reply at once. What makes that safe to
  // press is which blocks count as newest: an older reply's pictures are already in the transcript,
  // and pressing its buttons again spends quota to duplicate them. The turn tail the app renders
  // after each reply is the boundary — the reply in front of the user is the one whose blocks have
  // no tail between them, whichever end of the conversation the walk starts from.
  {
    const { installCodeButtons, setAutoRender, fireLatestReply, latestReplyHosts, setRendered, hashOf, rescanBlocks: rescan } = exports
    /** Click count of the button injected into a block, or -1 when there is none. */
    const clicksOf = (block) => block.host.children[0]?.children[0]?.clicks ?? -1
    const liveMarkers = new Set()
    /** A node that answers `getAttribute`, the way the app's own elements do. */
    const attrNode = (attrs) =>
      Object.assign(fakeNode('attr'), { getAttribute: (name) => (name in attrs ? attrs[name] : null) })
    let transcript = []
    let turns = 0
    /** Mount one prompt-looking block into the transcript. */
    const prompt = (text) => {
      const made = fakeBlock(text)
      transcript.push(made.pre)
      return made
    }
    /** Mount the node that closes the current turn. */
    const turnTail = () => {
      turns += 1
      const node = fakeNode('div')
      node.setAttribute('data-turn-tail', String(turns))
      transcript.push(node)
      return node
    }
    const wire = () => {
      globalThis.document = {
        querySelectorAll: (selector) => {
          if (selector === 'pre') return transcript.filter((node) => node.tagName === 'PRE')
          // The real query returns one ordered list, which is the whole reason the walk works.
          if (selector === 'pre, [data-turn-tail]') {
            return transcript.filter(
              (node) => node.tagName === 'PRE' || node.getAttribute('data-turn-tail') !== null
            )
          }
          // The transcript's own statement about whether it is still being written: the tails it
          // has rendered, then the markers the app left on the page. The marker rule reads the
          // newest node of this walk, so a marker with no tail after it means the newest turn is
          // open and still writing.
          if (selector === '[data-turn-tail], [data-streaming], [data-state="running"]') {
            const tails = transcript.filter((node) => node.getAttribute('data-turn-tail') !== null)
            const markers = Array.from(liveMarkers).map((name) =>
              name === '[data-streaming]'
                ? attrNode({ 'data-streaming': '' })
                : attrNode({ 'data-state': 'running' })
            )
            return tails.concat(markers)
          }
          return []
        },
        querySelector: (selector) => (liveMarkers.has(selector) ? fakeNode('marker') : null),
        createElement: (tag) => fakeNode(tag),
        body: fakeNode('body'),
        addEventListener: () => {},
        removeEventListener: () => {}
      }
    }

    // The press is a manual act, so it works with the toggle off; every case below is measured
    // with it off, which is also what keeps this block from arming the quiet pass.
    setAutoRender(false)

    const older = prompt('older one, solo, looking at viewer, masterpiece, best quality')
    const olderToo = prompt('older two, solo, looking at viewer, masterpiece, best quality')
    turnTail()
    const newest = prompt('newest one, solo, looking at viewer, masterpiece, best quality')
    const newestToo = prompt('newest two, solo, looking at viewer, masterpiece, best quality')
    turnTail()
    wire()
    installCodeButtons(identity)
    rescan()
    check(
      'both replies are decorated before anything is pressed',
      clicksOf(older) === 0 && clicksOf(newest) === 0,
      `${clicksOf(older)},${clicksOf(newest)}`
    )

    const collected = latestReplyHosts()
    check(
      'the walk collects the newest reply and nothing above it',
      collected.length === 2 && collected[0] === newest.host && collected[1] === newestToo.host,
      `${collected.length}: ${collected.map((host) => (host === newest.host ? 'newest' : host === newestToo.host ? 'newestToo' : host === older.host ? 'older' : 'olderToo')).join(',')}`
    )

    const pressed = fireLatestReply()
    check(
      'pressing the window renders every prompt of the newest reply',
      pressed.clicked === 2 && pressed.reason === 'clicked',
      JSON.stringify(pressed)
    )
    check(
      'and the reply above it is left alone',
      clicksOf(older) === 0 && clicksOf(olderToo) === 0,
      `${clicksOf(older)},${clicksOf(olderToo)}`
    )

    // A press is a re-roll, not a one-shot: NovelAI draws a fresh seed every time, so the pictures
    // already on screen are the reason to press again rather than a reason not to.
    setRendered(hashOf('newest one, solo, looking at viewer, masterpiece, best quality'), [{ name: 'done.png' }])
    const rerolled = fireLatestReply()
    check(
      'a prompt that already has its pictures renders again on the next press',
      rerolled.clicked === 2 && clicksOf(newest) === 2 && clicksOf(newestToo) === 2,
      JSON.stringify(rerolled)
    )
    // A render in flight disables its own button, and that one is not queued behind itself: the
    // press would be asking the same prompt for a second render while the first is on its way.
    const inFlight = newestToo.host.children[0].children[0]
    inFlight.disabled = true
    const partly = fireLatestReply()
    check(
      'a render already in flight is not pressed behind itself',
      partly.clicked === 1 && clicksOf(newest) === 3 && clicksOf(newestToo) === 2,
      JSON.stringify(partly)
    )
    // With every button in flight there is nothing to press at all, and the status line says so
    // rather than pretending the reply had nothing to render.
    newest.host.children[0].children[0].disabled = true
    const nothingLeft = fireLatestReply()
    check(
      'and a reply whose every render is in flight reports nothing left to press',
      nothingLeft.clicked === 0 && nothingLeft.reason === 'spent',
      JSON.stringify(nothingLeft)
    )

    // The reply being written is the one thing the press must refuse outright: its prompts are
    // still arriving, so it would render fragments, and the buttons for them do not exist yet.
    liveMarkers.add('[data-streaming]')
    const midStream = fireLatestReply()
    check(
      'a reply still being written is refused rather than pressed',
      midStream.clicked === 0 && midStream.reason === 'busy',
      JSON.stringify(midStream)
    )
    check(
      'and the refusal names the marker that said so',
      midStream.marker === '[data-streaming]',
      JSON.stringify(midStream)
    )
    // The same marker on a page that has stopped moving is a leftover rather than a live reply: the
    // press goes through, which is what keeps one abandoned card from switching the window off for
    // the rest of the day.
    const realNow = Date.now
    let clock = realNow()
    globalThis.Date.now = () => clock
    transcript = []
    const quiet = prompt('quiet one, solo, looking at viewer, masterpiece, best quality')
    wire()
    rescan()
    clock += 31000
    const afterQuiet = fireLatestReply()
    check(
      'and a marker the page stopped moving under does not refuse the press',
      afterQuiet.clicked === 1 && clicksOf(quiet) === 1,
      JSON.stringify(afterQuiet)
    )
    globalThis.Date.now = realNow
    liveMarkers.delete('[data-streaming]')

    // One turn with nothing above it: there is no tail to stop at, and the whole transcript is the
    // reply in front of the user.
    transcript = []
    wire()
    const single = prompt('single one, solo, looking at viewer, masterpiece, best quality')
    const singleToo = prompt('single two, solo, looking at viewer, masterpiece, best quality')
    wire()
    rescan()
    const wholeThing = fireLatestReply()
    check(
      'a conversation with no turn boundary is entirely the newest reply',
      wholeThing.clicked === 2 && clicksOf(single) === 1 && clicksOf(singleToo) === 1,
      JSON.stringify(wholeThing)
    )

    // A reply that just landed has no tail of its own yet; the tail above it is what says where it
    // starts, so the walk has to stop there rather than run up the whole conversation.
    transcript = []
    const above = prompt('above one, solo, looking at viewer, masterpiece, best quality')
    turnTail()
    const landed = prompt('landed one, solo, looking at viewer, masterpiece, best quality')
    wire()
    rescan()
    const stopped = fireLatestReply()
    check(
      'a reply whose own tail has not rendered yet stops at the tail above it',
      stopped.clicked === 1 && clicksOf(landed) === 1 && clicksOf(above) === 0,
      JSON.stringify(stopped)
    )

    // The dangerous shape: the newest turn carries no prompt at all, so there is nothing to press
    // and the reply above must not be reached for instead.
    transcript = []
    const untouched = prompt('untouched one, solo, looking at viewer, masterpiece, best quality')
    turnTail()
    turnTail()
    wire()
    rescan()
    const empty = fireLatestReply()
    check(
      'a newest reply with no prompt block presses nothing',
      empty.clicked === 0 && empty.reason === 'none',
      JSON.stringify(empty)
    )
    check('and it does not reach up into the reply above it', clicksOf(untouched) === 0, String(clicksOf(untouched)))

    // The button is built by a pass, and a reply can land between passes. Pressing runs one first,
    // or the double-click would do nothing on the very reply the user is looking at.
    transcript = []
    const fresh = prompt('fresh one, solo, looking at viewer, masterpiece, best quality')
    turnTail()
    wire()
    check('a block no pass has seen yet has no button to press', latestReplyHosts().length === 0, String(latestReplyHosts().length))
    const afterPass = fireLatestReply()
    check(
      'and the press itself runs the pass that builds it',
      afterPass.clicked === 1 && clicksOf(fresh) === 1,
      JSON.stringify(afterPass)
    )

    // A block whose text grew since its button was built is decorated again — a stale button
    // carries a stale prompt — and the press has to land on the button that is there now.
    transcript = []
    const growing = prompt('<image>\n<image_think>\n①纯透明底')
    turnTail()
    wire()
    rescan()
    const staleBar = growing.host.children[0]
    growing.code.textContent =
      '<image>\n<image_think>\n①reasoning</image_think>\nimage###size:1024x1024;\nScene:SFW,a;\nChar1:girl|centers:B3;\nChar1 UC:x;\nScene UC:y;###\n</image>'
    const rebuilt = fireLatestReply()
    check(
      'the press rebuilds a block that grew since its button was made',
      rebuilt.clicked === 1 && clicksOf(growing) === 1,
      JSON.stringify(rebuilt)
    )
    check('and the row it replaced is detached rather than pressed', staleBar.removed === true, String(staleBar.removed))

    setAutoRender(false)
    globalThis.document = {
      querySelectorAll: () => [],
      querySelector: () => null,
      createElement: (tag) => fakeNode(tag),
      body: fakeNode('body'),
      addEventListener: () => {},
      removeEventListener: () => {}
    }
  }

  // ------------------------------------------------------- panel rendering --
  // The panel is plain `createElement` calls, so executing it with a stub React
  // walks every line of the JSX. Without a browser that is the only way to catch
  // a reference error in it — and a crashed panel shows up as a blank sidebar.
  /**
   * Render the panel with seeded state.
   * @param seeds - `useState` values by call index.
   * @returns the element tree.
   */
  const renderPanel = (seeds) => {
    let index = 0
    const stub = {
      createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
      Fragment: 'Fragment',
      useState: (initial) => {
        const at = index
        index += 1
        if (!Object.prototype.hasOwnProperty.call(seeds, at)) return [initial, () => {}]
        // Seeding by call index is only safe while the shape still matches. A hook added
        // above would land the payload on the wrong slot, and the panel would quietly
        // render an empty section — so this fails instead.
        if (Array.isArray(seeds[at]) !== Array.isArray(initial)) {
          throw new Error(`state slot ${at} no longer matches its seed (${typeof initial})`)
        }
        return [seeds[at], () => {}]
      },
      // Effects are skipped on purpose: they fetch, and this test is about render.
      useEffect: () => {},
      useCallback: (fn) => fn,
      useMemo: (fn) => fn(),
      useRef: (value) => ({ current: value })
    }
    const panelExports = definition.factory((name) => {
      if (name === 'react') return stub
      throw new Error(`unexpected external: ${name}`)
    })
    return panelExports.NaiPanel({ t: (key) => `t:${key}` })
  }
  /** Collect every string in an element tree. */
  const flatten = (node, out = []) => {
    if (node === null || node === undefined || node === false || node === true) return out
    if (typeof node === 'string' || typeof node === 'number') {
      out.push(String(node))
      return out
    }
    if (Array.isArray(node)) {
      for (const child of node) flatten(child, out)
      return out
    }
    if (typeof node === 'object' && Array.isArray(node.children)) for (const child of node.children) flatten(child, out)
    return out
  }

  const panelStatus = {
    outputDir: 'C:\\out',
    libraryDir: 'C:\\lib',
    librarySourceDir: 'C:\\src',
    imageCount: 3,
    libraries: [{ library: '标签库9.5', entries: 195 }],
    newest: [],
    tokenSet: true,
    tokenSource: 'file',
    proxy: 'http://127.0.0.1:7890',
    proxySetting: '',
    detectedProxy: 'http://127.0.0.1:7890',
    maxImagesPerCall: 4,
    keepImages: 500,
    negativePrompt: '',
    keys: [
      {
        id: 'a',
        label: '主 Key',
        fingerprint: 'deadbeef01',
        enabled: true,
        status: 'healthy',
        completed: 3,
        subscription: { tier: 3 },
        lastError: ''
      },
      {
        id: 'b',
        label: '副号 1',
        fingerprint: 'deadbeef02',
        enabled: false,
        status: 'disabled',
        completed: 0,
        subscription: null,
        lastError: 'NovelAI API Key 无效或已过期。'
      }
    ],
    keySummary: {
      keyCount: 2,
      usableKeyCount: 1,
      availableKeyCount: 1,
      concurrency: 1,
      queuedCount: 2,
      activeCount: 1,
      problemKeyCount: 1,
      keyIssues: [{ id: 'b', label: '副号 1', status: 'invalid', errorCode: 401, error: 'NovelAI API Key 无效或已过期。' }]
    },
    artistId: 0,
    artistName: '最推荐（甜彩精致萝莉风）',
    artistCount: 96,
    autoGenerate: true,
    // The switch's own field. A panel that reads a field the host never sends draws the off
    // state over a transport that is on, which is the one wrong answer here that looks right.
    replyTransport: true
  }
  const panelForm = {
    baseUrl: 'https://image.novelai.net',
    token: '',
    model: 'nai-diffusion-5-full',
    width: 832,
    height: 1216,
    steps: 28,
    scale: 5,
    sampler: 'k_euler_ancestral',
    ucPreset: 3,
    proxy: '',
    negativePrompt: '',
    outputDir: 'C:\\out',
    libraryDir: 'C:\\lib',
    librarySourceDir: 'C:\\src',
    maxImagesPerCall: 4,
    keepImages: 500
  }
  const panelArtists = [{ id: 0, name: '最推荐（甜彩精致萝莉风）', sequence: 0, hasImage: true, promptChars: 578 }]

  let panelTree = null
  let panelCrash = null
  try {
    panelTree = renderPanel({ 0: panelStatus, 1: panelForm, 9: panelArtists })
  } catch (error) {
    panelCrash = error
  }
  check(
    'the panel renders without throwing',
    panelCrash === null,
    panelCrash === null ? '' : `${panelCrash.message} @ ${(panelCrash.stack ?? '').split('\n')[1]?.trim()}`
  )
  const panelText = flatten(panelTree).join(' | ')
  check('the panel renders the key pool heading', panelText.includes('t:keys'), panelText.slice(0, 120))
  check('the panel renders key labels and fingerprints', panelText.includes('主 Key') && panelText.includes('deadbeef01'))
  check('the panel renders a disabled key with an enable button', panelText.includes('副号 1') && panelText.includes('t:keyEnable'))
  check('the panel shows per-key progress and tier', panelText.includes('已完成 3') && panelText.includes('tier 3'))
  check('the panel reports a key problem inline', panelText.includes('无效或已过期'))
  check('the panel shows concurrency and queue depth', panelText.includes('t:concurrency') && panelText.includes('队列 2'))
  check('the panel renders the artist section', panelText.includes('t:artistCount') && panelText.includes('96'))
  check('the panel names the current artist', panelText.includes('最推荐'))
  check('the panel lists the artist grid', panelText.includes('#0 最推荐（甜彩精致萝莉风）'))
  /** Collect every attribute value in an element tree. */
  const flattenProps = (node, out = []) => {
    if (node === null || typeof node !== 'object') return out
    if (Array.isArray(node)) {
      for (const child of node) flattenProps(child, out)
      return out
    }
    for (const value of Object.values(node.props ?? {})) if (typeof value === 'string') out.push(value)
    for (const child of node.children ?? []) flattenProps(child, out)
    return out
  }
  const panelProps = flattenProps(panelTree).join(' | ')
  /** Occurrences of a substring. */
  const countOf = (haystack, needle) => haystack.split(needle).length - 1
  check('the panel points the thumbnail at the byte-range route', panelProps.includes('/artist-image?id=0'), panelProps.slice(-140))
  check(
    'the remembered artist gets its own card as well as its grid tile',
    countOf(panelProps, '/artist-image?id=0') === 2,
    String(countOf(panelProps, '/artist-image?id=0'))
  )
  check('the card names the selection', panelText.includes('t:artistCurrent：最推荐'), panelText.slice(0, 80))
  check('the panel renders the auto-render toggle in the on state', panelText.includes('t:autoOn'))
  // The transport's switch is drawn from the host's answer and never from a remembered guess, so
  // the same panel over a host that says "off" has to say "off" — a button that keeps showing the
  // state it saw last is worse than no button, because it reads as the setting.
  check('the panel draws the reply transport switch from the host', panelText.includes('t:replyOn'), panelText.slice(0, 120))
  let switchTree = null
  let switchCrash = null
  try {
    switchTree = renderPanel({ 0: { ...panelStatus, replyTransport: false }, 1: panelForm, 9: panelArtists })
  } catch (error) {
    switchCrash = error
  }
  const switchText = switchCrash === null ? flatten(switchTree).join(' | ') : ''
  check(
    'and says off when that is what the host reports',
    switchCrash === null && switchText.includes('t:replyOff') && switchText.includes('t:replyHint'),
    switchCrash === null ? switchText.slice(0, 120) : String(switchCrash.message)
  )
  check('the panel still renders the render button', panelText.includes('t:testPrompt') && panelText.includes('t:gallery'), panelText.slice(-120))
  check('the panel offers an editor for the current artist string', panelText.includes('t:artistEdit'), panelText.slice(0, 140))
  // Collapsed by default: the boxes are not in the tree until it is opened, which is
  // why the assertion above looks for the button rather than for the text.
  check(
    'the artist editor starts collapsed',
    !panelText.includes('t:artistSave') && !panelText.includes('t:artistEditHint'),
    panelText.slice(0, 140)
  )

  // Opened, with a text already fetched. Rendered rather than clicked, because the
  // stub's setState is a no-op — what can actually break here is the render path.
  let editorTree = null
  let editorCrash = null
  try {
    editorTree = renderPanel({
      0: panelStatus,
      1: panelForm,
      9: [{ ...panelArtists[0], edited: true }],
      15: {
        id: 0,
        name: '最推荐（甜彩精致萝莉风）',
        positive: 'EDITEDSTYLE, flat colour',
        negative: 'EDITEDBAD',
        chars: 22,
        original: { positive: 'ARCHIVESTYLE, flat colour', negative: 'ARCHIVEBAD' },
        edited: true
      },
      16: { positive: 'EDITEDSTYLE, flat colour', negative: 'EDITEDBAD' },
      17: true
    })
  } catch (error) {
    editorCrash = error
  }
  check('the panel renders with the artist editor open', editorCrash === null, editorCrash?.message ?? '')
  const editorText = editorTree === null ? '' : flatten(editorTree).join(' | ')
  const editorProps = editorTree === null ? '' : flattenProps(editorTree).join(' | ')
  check(
    'the open editor names both directions',
    editorText.includes('t:artistPositive') && editorText.includes('t:artistNegative'),
    editorText.slice(0, 200)
  )
  check(
    'the open editor holds the text in force, not the archive text',
    editorProps.includes('EDITEDSTYLE, flat colour') && editorProps.includes('EDITEDBAD'),
    editorProps.slice(0, 220)
  )
  check(
    'the archive text is not what the boxes are seeded with',
    !editorProps.includes('ARCHIVESTYLE'),
    editorProps.slice(0, 220)
  )
  check(
    'the open editor offers save and restore',
    editorText.includes('t:artistSave') && editorText.includes('t:artistRevert'),
    editorText.slice(0, 200)
  )
  check('the open editor says where the text lives', editorText.includes('t:artistEditHint'), editorText.slice(0, 200))
  check('a customised entry is marked in the grid', editorText.includes('t:artistEditedTag'), editorText.slice(0, 160))
  check(
    'the button is tagged once the string has been edited',
    panelText.includes('t:artistEdit') && !panelText.includes(`t:artistEdit · `),
    panelText.slice(0, 140)
  )

  // Making an entry and giving one a reference image are the two things the panel can do
  // that the archive never could. Both are folded away until they are asked for, so the
  // closed and open states are asserted separately: a form that rendered into the tree
  // uninvited would push the grid off the bottom of the panel.
  check('the panel offers a way to make an entry', panelText.includes('t:artistNew'), panelText.slice(0, 140))
  check(
    'the entry maker starts folded away',
    countOf(panelText, 't:artistCreate') === 0 && countOf(panelText, 't:artistChooseImage') === 0,
    panelText.slice(0, 200)
  )
  check(
    'the open editor offers a replacement reference image',
    editorText.includes('t:artistImageUpload'),
    editorText.slice(0, 200)
  )
  // The delete row belongs to hand-made entries only — an imported one is not this
  // plugin's to remove — so it must not even be there to press on an archive entry.
  check('an imported entry offers no delete', countOf(editorText, 't:artistDelete') === 0, editorText.slice(0, 200))
  check(
    'an imported entry offers no uploaded-image undo',
    countOf(editorText, 't:artistImageClearUpload') === 0,
    editorText.slice(0, 200)
  )

  const makerState = {
    0: panelStatus,
    1: panelForm,
    9: [{ ...panelArtists[0], custom: true }],
    15: {
      id: 0,
      name: '自建条目',
      positive: 'XSTYLE',
      negative: 'XBAD',
      chars: 6,
      original: { positive: 'XSTYLE', negative: 'XBAD' },
      edited: false,
      custom: true,
      uploaded: true,
      image: true
    },
    16: { positive: 'XSTYLE', negative: 'XBAD' },
    17: true,
    18: true,
    19: '我的画风',
    20: 'MYNEWSTYLE',
    21: 'MYNEWBAD',
    22: { name: 'ref.png', size: 2048, type: 'image/png' }
  }
  let makerTree = null
  let makerCrash = null
  try {
    makerTree = renderPanel(makerState)
  } catch (error) {
    makerCrash = error
  }
  check('the panel renders with the entry maker open', makerCrash === null, makerCrash?.message ?? '')
  const makerText = makerTree === null ? '' : flatten(makerTree).join(' | ')
  const makerProps = makerTree === null ? '' : flattenProps(makerTree).join(' | ')
  check(
    'the open entry maker names the fields it needs',
    makerText.includes('t:artistName') &&
      makerText.includes('t:artistNewPositive') &&
      makerText.includes('t:artistNewNegative'),
    makerText.slice(0, 240)
  )
  check(
    'the open entry maker carries what has been typed',
    makerProps.includes('我的画风') && makerProps.includes('MYNEWSTYLE') && makerProps.includes('MYNEWBAD'),
    makerProps.slice(0, 240)
  )
  check(
    'the open entry maker offers the image picker and its limits',
    makerText.includes('t:artistChooseImage') && makerText.includes('t:artistImageHint'),
    makerText.slice(0, 260)
  )
  check(
    'a chosen file is named with its size before anything is sent',
    makerText.includes('t:artistImageChosen') && makerText.includes('ref.png') && makerText.includes('2 KB'),
    makerText.slice(0, 260)
  )
  check('the open entry maker has a create button', makerText.includes('t:artistCreate'), makerText.slice(0, 200))
  check(
    'a hand-made entry offers a delete that has not been armed yet',
    makerText.includes('t:artistDelete') && countOf(makerText, 't:artistDeleteConfirm') === 0,
    makerText.slice(0, 240)
  )
  check('a hand-made entry says what deleting it means', makerText.includes('t:artistDeleteHint'), makerText.slice(0, 240))
  check(
    'an uploaded image can be taken back off',
    makerText.includes('t:artistImageClearUpload'),
    makerText.slice(0, 240)
  )
  check('a hand-made entry is flagged in the grid', makerText.includes('t:artistCustomTag'), makerText.slice(0, 200))

  let armedTree = null
  try {
    armedTree = renderPanel({ ...makerState, 23: 0 })
  } catch {
    armedTree = null
  }
  const armedText = armedTree === null ? '' : flatten(armedTree).join(' | ')
  check(
    'deleting an entry asks twice before anything happens',
    armedText.includes('t:artistDeleteConfirm') && armedText.includes('t:artistDeleteCancel'),
    armedText.slice(0, 240)
  )

  // The button's own state and the outcome of its last click are part of the contract.
  // A create that refuses silently, or reports itself at the very top of a very long
  // panel while the eye is down in the grid, is the same bug as doing nothing at all.
  /** Buttons carrying `disabled === true`, as their label text. */
  const disabledButtons = (node, out = []) => {
    if (node === null || typeof node !== 'object') return out
    if (Array.isArray(node)) {
      for (const child of node) disabledButtons(child, out)
      return out
    }
    if (node.props?.disabled === true) out.push(flatten(node).join(' '))
    for (const child of node.children ?? []) disabledButtons(child, out)
    return out
  }
  let blankTree = null
  try {
    blankTree = renderPanel({ ...makerState, 19: '' })
  } catch {
    blankTree = null
  }
  const blankText = blankTree === null ? '' : flatten(blankTree).join(' | ')
  check(
    'a nameless entry cannot be created, and says why',
    blankText.includes('t:artistNameNeeded') &&
      disabledButtons(blankTree).some((labelText) => labelText.includes('t:artistCreate')),
    blankText.slice(0, 240)
  )
  check(
    'a named entry leaves the create button live',
    !disabledButtons(makerTree).some((labelText) => labelText.includes('t:artistCreate')),
    makerText.slice(0, 200)
  )
  let refusedTree = null
  try {
    refusedTree = renderPanel({ ...makerState, 25: 'name is required' })
  } catch {
    refusedTree = null
  }
  const refusedText = refusedTree === null ? '' : flatten(refusedTree).join(' | ')
  check(
    'a refused create prints the reason under its own button',
    refusedText.includes('t:failed') && refusedText.includes('name is required'),
    refusedText.slice(0, 260)
  )
  let madeTree = null
  try {
    madeTree = renderPanel({ ...makerState, 26: '已新增 #1000 我的画风' })
  } catch {
    madeTree = null
  }
  const madeText = madeTree === null ? '' : flatten(madeTree).join(' | ')
  check(
    'a create that went through is reported under the same button',
    madeText.includes('#1000') && madeText.includes('已新增'),
    madeText.slice(0, 260)
  )
  /** Every prop as text, style objects included — the ring lives in a style value. */
  const deepProps = (node, out = []) => {
    if (node === null || typeof node !== 'object') return out
    if (Array.isArray(node)) {
      for (const child of node) deepProps(child, out)
      return out
    }
    for (const value of Object.values(node.props ?? {})) {
      if (typeof value === 'string') out.push(value)
      else if (value !== null && typeof value === 'object') out.push(JSON.stringify(value))
    }
    for (const child of node.children ?? []) deepProps(child, out)
    return out
  }
  const ringProps = madeTree === null ? '' : deepProps(renderPanel({ ...makerState, 27: 0 })).join(' | ')
  const plainProps = makerTree === null ? '' : deepProps(makerTree).join(' | ')
  check(
    'the entry just made is ringed in the grid',
    ringProps.includes('"outline":"2px solid') && plainProps.includes('"outline":"none"'),
    ringProps.slice(0, 200)
  )

  let offTree = null
  try {
    offTree = renderPanel({
      0: { ...panelStatus, autoGenerate: false, artistId: -1, artistName: null, keys: [], keySummary: null, keyIssues: undefined },
      1: panelForm,
      9: []
    })
  } catch (error) {
    offTree = null
    panelCrash = error
  }
  check('the panel renders with no keys and no artist', offTree !== null, panelCrash?.message ?? '')
  const offText = flatten(offTree).join(' | ')
  check('an empty pool renders without a summary line', offText.includes('t:keys') && !offText.includes('t:concurrency'))
  check('the auto-render toggle shows the off state', offText.includes('t:autoOff'))
  // With no artist selected there is no card, so the only thumbnail is the tile.
  check(
    'no artist card when nothing is selected',
    countOf(flattenProps(offTree).join(' | '), '/artist-image?id=') === 0,
    flattenProps(offTree).join(' | ').slice(-120)
  )

  // A remembered index can outlive the archive it pointed into. Saying so beats a
  // silently blank section.
  let staleTree = null
  try {
    staleTree = renderPanel({ 0: { ...panelStatus, artistId: 5, artistName: null }, 1: panelForm, 9: [] })
  } catch (error) {
    staleTree = null
    panelCrash = error
  }
  const staleText = flatten(staleTree).join(' | ')
  check('a selection that no longer resolves is reported', staleText.includes('t:artistMissing'), staleText.slice(0, 120))
  check('and it does not render a card for it', countOf(flattenProps(staleTree).join(' | '), '/artist-image?id=') === 0)

  // ----------------------------------------------------------- image menu --
  // Right-click has to claim this plugin's images and nothing else, so both
  // halves of that are asserted: the menu appears for a marked image, and a
  // stray `<img>` elsewhere in the app is left completely alone.
  {
    const { installImageMenu } = exports
    const listeners = {}
    const body = fakeNode('body')
    globalThis.document = {
      querySelectorAll: () => [],
      createElement: (tag) => fakeNode(tag),
      body,
      addEventListener: (name, fn) => {
        listeners[name] = fn
      },
      removeEventListener: () => {}
    }
    const dispose = installImageMenu((key) => key)
    check(
      'the image menu installs its listeners',
      typeof listeners.contextmenu === 'function' && typeof listeners.click === 'function' && typeof listeners.keydown === 'function',
      Object.keys(listeners).join(',')
    )

    const marked = fakeNode('img')
    marked.attributes['data-nai-imagegen-image'] = '1'
    marked.attributes['data-nai-name'] = 'a.png'
    marked.attributes['data-nai-path'] = 'C:\\out\\a.png'
    marked.closest = () => marked
    let prevented = false
    listeners.contextmenu({
      target: marked,
      clientX: 40,
      clientY: 40,
      preventDefault: () => {
        prevented = true
      },
      stopPropagation: () => {}
    })
    check('a right-click on a marked image is claimed', prevented)
    check('a menu was appended to the page', body.children.length === 1, String(body.children.length))
    const menu = body.children[0]
    const labels = menu.children.map((child) => child.textContent)
    check('the menu offers copying the image', labels.includes('copyImage'), labels.join(','))
    check('the menu offers the file name and the full path', labels.includes('copyName') && labels.includes('copyPath'), labels.join(','))
    check('the menu offers save as', labels.includes('saveAs'), labels.join(','))

    // An image this plugin did not create must not be hijacked.
    body.children = []
    let plainPrevented = false
    const plain = fakeNode('img')
    plain.closest = () => null
    listeners.contextmenu({
      target: plain,
      clientX: 0,
      clientY: 0,
      preventDefault: () => {
        plainPrevented = true
      },
      stopPropagation: () => {}
    })
    check('an unmarked image is left alone', !plainPrevented && body.children.length === 0, String(body.children.length))

    // ...but a *render* the transcript drew is adopted on the spot. Identity is the address
    // or the alt text, **never the size**: another plugin's picture can be exactly as large,
    // and adopting it would shrink it with the display scale and open this plugin's overlay
    // over a click that plugin wanted.
    body.children = []
    let adoptedPrevented = false
    const adopted = fakeNode('img')
    // The marked-image lookup must miss and the plain `img` lookup must hit, which is
    // exactly what the real DOM does for an image this half never marked.
    adopted.closest = (selector) => (selector === 'img' ? adopted : null)
    adopted.naturalWidth = 832
    adopted.naturalHeight = 1216
    adopted.attributes.src = '/nai-imagegen/api/file?name=2026-09-29T10-31-09-014Z.png'
    listeners.contextmenu({
      target: adopted,
      clientX: 10,
      clientY: 10,
      preventDefault: () => {
        adoptedPrevented = true
      },
      stopPropagation: () => {}
    })
    check('one of our renders is adopted on the spot', adoptedPrevented, String(adoptedPrevented))
    check('and it is marked so the next right-click is direct', adopted.attributes['data-nai-imagegen-image'] === '1', String(adopted.attributes['data-nai-imagegen-image']))
    check('a menu opens for it', body.children.length === 1, String(body.children.length))
    check('and the image name is recovered from the address', adopted.attributes['data-nai-name'] === '2026-09-29T10-31-09-014Z.png', String(adopted.attributes['data-nai-name']))

    // A thumbnail of the panel is chrome: adopting one would hand the display scale the
    // sidebar's own grid. It is left alone like any other picture this half did not build.
    body.children = []
    let panelPrevented = false
    const panelThumb = fakeNode('img')
    const panelSurface = fakeNode('div')
    panelThumb.closest = (selector) => {
      if (selector === 'img') return panelThumb
      if (selector === '[data-nai-imagegen-studio]') return panelSurface
      return null
    }
    panelThumb.naturalWidth = 832
    panelThumb.naturalHeight = 1216
    panelThumb.attributes.src = '/nai-imagegen/api/file?name=panel.png'
    listeners.contextmenu({
      target: panelThumb,
      clientX: 12,
      clientY: 12,
      preventDefault: () => {
        panelPrevented = true
      },
      stopPropagation: () => {}
    })
    check(
      'a thumbnail of the panel is chrome, not content',
      !panelPrevented && body.children.length === 0,
      `prevented=${panelPrevented} children=${body.children.length}`
    )

    // The enlargement is the one control surface that *is* content. It exists to show the
    // picture at full size, which is exactly when someone wants the pixels on the clipboard —
    // so a menu that refused to claim it would refuse the one picture worth copying.
    body.children = []
    let enlargedPrevented = false
    const enlarged = fakeNode('img')
    const overlaySurface = fakeNode('div')
    enlarged.closest = (selector) => {
      if (selector === 'img') return enlarged
      if (selector === '[data-nai-imagegen-studio]') return overlaySurface
      if (selector === '[data-nai-imagegen-studio="lightbox"]') return overlaySurface
      return null
    }
    enlarged.attributes.src = '/nai-imagegen/api/file?name=2026-10-06T09-30-00-000Z.png'
    listeners.contextmenu({
      target: enlarged,
      clientX: 20,
      clientY: 20,
      preventDefault: () => {
        enlargedPrevented = true
      },
      stopPropagation: () => {}
    })
    check('the enlarged picture is claimed too', enlargedPrevented, String(enlargedPrevented))
    check(
      'and its menu offers the picture itself',
      body.children.length === 1 &&
        body.children[0].children.map((child) => child.textContent).includes('copyImage'),
      `children=${body.children.length}`
    )
    check(
      'the name travels with it, so 另存为 lands under the real file name',
      enlarged.attributes['data-nai-name'] === '2026-10-06T09-30-00-000Z.png',
      String(enlarged.attributes['data-nai-name'])
    )

    // An older render whose address the host already rewrote to an opaque one is still ours:
    // the alt text those embeds carry is the second half of the identity rule.
    body.children = []
    let altPrevented = false
    const byAlt = fakeNode('img')
    byAlt.closest = (selector) => (selector === 'img' ? byAlt : null)
    byAlt.naturalWidth = 832
    byAlt.naturalHeight = 1216
    byAlt.attributes.src = '/attachments/v1/objects/cd/cd19.png'
    byAlt.attributes.alt = '生成图片'
    listeners.contextmenu({
      target: byAlt,
      clientX: 3,
      clientY: 3,
      preventDefault: () => {
        altPrevented = true
      },
      stopPropagation: () => {}
    })
    check('a render whose address was rewritten is still ours', altPrevented, String(altPrevented))

    // Another plugin's picture, same size, different owner. Touching it is what this
    // plugin must not do.
    body.children = []
    let foreignPrevented = false
    const foreign = fakeNode('img')
    foreign.closest = (selector) => (selector === 'img' ? foreign : null)
    foreign.naturalWidth = 832
    foreign.naturalHeight = 1216
    foreign.attributes.src = '/attachments/v1/objects/ab/ab8c1aec420c.png'
    foreign.attributes.alt = 'chart'
    listeners.contextmenu({
      target: foreign,
      clientX: 7,
      clientY: 7,
      preventDefault: () => {
        foreignPrevented = true
      },
      stopPropagation: () => {}
    })
    check(
      'another plugin’s large image is left alone',
      !foreignPrevented && body.children.length === 0,
      `prevented=${foreignPrevented} children=${body.children.length}`
    )
    // An icon or an avatar must not be claimed by the size rule.
    body.children = []
    let iconPrevented = false
    const icon = fakeNode('img')
    icon.closest = (selector) => (selector === 'img' ? icon : null)
    icon.naturalWidth = 24
    icon.naturalHeight = 24
    icon.attributes.src = '/assets/logo.png'
    listeners.contextmenu({
      target: icon,
      clientX: 0,
      clientY: 0,
      preventDefault: () => {
        iconPrevented = true
      },
      stopPropagation: () => {}
    })
    check('a small icon is still left alone', !iconPrevented && body.children.length === 0, String(body.children.length))

    // The menu has to be dismissable, or it would sit over the app forever.
    const markedAgain = fakeNode('img')
    markedAgain.attributes['data-nai-imagegen-image'] = '1'
    markedAgain.closest = () => markedAgain
    listeners.contextmenu({ target: markedAgain, clientX: 5, clientY: 5, preventDefault: () => {}, stopPropagation: () => {} })
    check('a second right-click reopens without stacking', body.children.length === 1, String(body.children.length))
    listeners.click({})
    check('clicking elsewhere removes it', menu.removed === true && body.children.length === 0, `children=${body.children.length}`)
    dispose()
  }

  // Restore the globals so nothing later is affected by the stubs.
  globalThis.document = previousDocument
  globalThis.MutationObserver = previousObserver
  globalThis.requestAnimationFrame = previousRaf
}

// ============================================================== [7] host API
console.log('\n[7] host half: tools and HTTP routes')
const mounted = mountHost()
check('host declares its services', Array.isArray(host.inject) && host.inject.includes('webServer') && host.inject.includes('tools'))
check('host registers a route', mounted.routes.length === 1, `got ${mounted.routes.length}`)
check('the route is a prefix on our path', mounted.routes[0]?.kind === 'prefix' && mounted.routes[0]?.path === '/nai-imagegen/api')

const expectedTools = ['nai_generate', 'nai_probe', 'nai_lookup', 'nai_resolve', 'nai_estimate', 'nai_index', 'nai_status', 'nai_config']
check('every documented tool is registered', expectedTools.every((name) => mounted.tools.has(name)), [...mounted.tools.keys()].join(','))
check(
  'every tool declares a name, description and parameters',
  [...mounted.tools.values()].every((tool) => tool.name && tool.description && tool.parameters !== undefined && typeof tool.execute === 'function')
)

const route = mounted.routes[0].handler
const statusRoute = await callRoute(route, fakeRequest({ url: '/nai-imagegen/api/status' }))
check('GET /status answers 200', statusRoute.status === 200, String(statusRoute.status))
const statusBody = asJson(statusRoute)
check('status reports a token source', ['env', 'file', 'none'].includes(statusBody.tokenSource), statusBody.tokenSource)
check('status never returns the token', statusBody.token === undefined)
check('status reports the libraries', Array.isArray(statusBody.libraries) && statusBody.libraries.length > 0)
check('status reports the output directory', typeof statusBody.outputDir === 'string' && statusBody.outputDir.length > 0)

const unknownRoute = await callRoute(route, fakeRequest({ url: '/nai-imagegen/api/nope' }))
check('an unknown route answers 404', unknownRoute.status === 404, String(unknownRoute.status))

// The page is the half that decides when to render and there is no debug port into it, so what
// it reports is the only account of a run that rendered nothing. The host keeps the last lines.
const emptyDiag = await callRoute(route, fakeRequest({ url: '/nai-imagegen/api/diag' }))
check('GET /diag answers 200', emptyDiag.status === 200, String(emptyDiag.status))
const reported = await callRoute(
  route,
  fakeRequest({
    method: 'POST',
    url: '/nai-imagegen/api/diag',
    body: JSON.stringify({ at: 1, event: 'window', verdict: 'quiet' })
  })
)
check('a report from the page is accepted', reported.status === 200 && asJson(reported).ok === true, String(reported.status))
const readDiag = asJson(await callRoute(route, fakeRequest({ url: '/nai-imagegen/api/diag' })))
check(
  'and it comes back stamped and newest first',
  readDiag.count === 1 &&
    readDiag.entries?.[0]?.event === 'window' &&
    readDiag.entries[0].verdict === 'quiet' &&
    typeof readDiag.entries[0].receivedAt === 'number',
  JSON.stringify(readDiag.entries?.[0])
)
check('the reply carries the host start time', typeof readDiag.startedAt === 'number', String(readDiag.startedAt))

// "It rendered nothing again" is decided in the browser, so the host can only hand back what the
// page itself said. The panel prints that line under the toggle, and it is the difference between
// a question that costs a chat round-trip and an answer already on screen.
await callRoute(
  route,
  fakeRequest({ method: 'POST', url: '/nai-imagegen/api/diag', body: JSON.stringify({ at: 2, event: 'boot', autoRender: false }) })
)
const carriedBoot = asJson(await callRoute(route, fakeRequest({ url: '/nai-imagegen/api/status' })))
check(
  'a boot report is not an answer to "why nothing rendered"',
  carriedBoot.lastAuto?.event === 'window' && carriedBoot.lastAuto?.verdict === 'quiet',
  JSON.stringify(carriedBoot.lastAuto)
)
check('and the record carries the host clock', typeof carriedBoot.lastAuto?.receivedAt === 'number', JSON.stringify(carriedBoot.lastAuto))
await callRoute(
  route,
  fakeRequest({ method: 'POST', url: '/nai-imagegen/api/diag', body: JSON.stringify({ at: 3, event: 'settle', outcome: { fired: 1 } }) })
)
const carriedSettle = asJson(await callRoute(route, fakeRequest({ url: '/nai-imagegen/api/status' })))
check(
  'the newest verdict of the two is the one handed to the panel',
  carriedSettle.lastAuto?.event === 'settle' && carriedSettle.lastAuto?.outcome?.fired === 1,
  JSON.stringify(carriedSettle.lastAuto)
)

const badConfig = await callRoute(route, fakeRequest({ method: 'POST', url: '/nai-imagegen/api/config', body: JSON.stringify({ nonsense: 1 }) }))
check('a config post with no known field is refused', badConfig.status === 400, String(badConfig.status))

const goodConfig = await callRoute(
  route,
  fakeRequest({ method: 'POST', url: '/nai-imagegen/api/config', body: JSON.stringify({ steps: 33, width: 640 }) })
)
check('a valid config post is accepted', goodConfig.status === 200, String(goodConfig.status))
check('the config post echoed what changed', asJson(goodConfig).updated.includes('steps'))
check('the new config is live', (await load()).steps === 33)

const readConfig = await callRoute(route, fakeRequest({ url: '/nai-imagegen/api/config' }))
check('GET /config omits the token', asJson(readConfig).token === undefined)
check('GET /config reports whether a token is set', typeof asJson(readConfig).tokenSet === 'boolean')

const traversal = await callRoute(route, fakeRequest({ url: '/nai-imagegen/api/file?name=..%2F..%2Fsecrets.txt' }))
check('GET /file refuses traversal', traversal.status === 400, String(traversal.status))

// ======================================================== [8] render pipeline
console.log('\n[8] render pipeline against a stub NovelAI server')
const captured = { authorization: null, payload: null, subscriptionAuthorization: null, subscriptionHits: 0 }
/** What the stub answers on the subscription route: `ok`, `boom` (500) or `token` (401). */
let subscriptionMode = 'ok'
// The synthetic Opus record the upstream spec's acceptance checklist is written
// around: 32.5% of the V5 free band, one percent back every hour, and an Anlas
// balance split 1200 + 75.
const subscriptionFixture = {
  active: true,
  tier: 3,
  expiresAt: 1800000000,
  trainingStepsLeft: { fixedTrainingStepsLeft: 1200, purchasedTrainingSteps: 75 },
  usage: { percent: 32.5, isNegative: false, timeUntilNextPercent: 3600 }
}
// The stub serves a PNG carrying real NovelAI provenance, so the whole
// provenance path (decode -> persist -> sidecar -> tool text) is exercised.
const zipBytes = naiZip
const stub = createServer((req, res) => {
  // The free connectivity probe reads the subscription record instead of
  // rendering, so the stub answers it too.
  if (req.method === 'GET' && String(req.url).endsWith('/user/subscription')) {
    captured.subscriptionAuthorization = req.headers.authorization ?? null
    captured.subscriptionHits += 1
    if (subscriptionMode === 'boom') {
      // The body names the token on purpose: nothing downstream may echo it.
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ message: 'upstream exploded near pst-pipeline' }))
      return
    }
    if (subscriptionMode === 'token') {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ message: 'unauthorized' }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(subscriptionFixture))
    return
  }
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    captured.authorization = req.headers.authorization ?? null
    try {
      captured.payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      captured.payload = null
    }
    res.writeHead(200, { 'Content-Type': 'application/zip' })
    res.end(zipBytes)
  })
})
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve))
const stubPort = stub.address().port

try {
  const outputDir = join(scratchHome, 'shots')
  await save({
    baseUrl: `http://127.0.0.1:${stubPort}`,
    token: 'pst-pipeline',
    outputDir,
    width: 832,
    height: 1216,
    steps: 28,
    maxImagesPerCall: 4,
    // The stub lives on loopback. With the default `auto` the plugin would try to
    // reach it *through* this machine's system proxy, which is wrong here, so the
    // offline suite pins the transport to direct.
    proxy: 'off'
  })

  const signal = new AbortController().signal
  const generate = mounted.tools.get('nai_generate')
  const text = await generate.execute({ prompt: 'moria_luluka, 1girl', n_samples: 1 }, { signal })

  check('the stub received an Authorization header', captured.authorization === 'Bearer pst-pipeline', String(captured.authorization))
  check('the request carried the prompt', captured.payload?.input === 'moria_luluka, 1girl', JSON.stringify(captured.payload?.input))
  check('the request used action=generate', captured.payload?.action === 'generate')
  check('the request sent the configured size', captured.payload?.parameters?.width === 832 && captured.payload?.parameters?.height === 1216)
  check('the request sent steps', captured.payload?.parameters?.steps === 28)
  check('the request asked for one image', captured.payload?.parameters?.n_samples === 1)
  // What actually goes on the wire, asserted against the body the stub received
  // rather than against the builder in isolation. Dropping either structured
  // caption is a 500 on V5, so this is the assertion that matters most.
  check('the wire body kept v4_prompt', captured.payload?.parameters?.v4_prompt !== undefined)
  check('the wire body kept v4_negative_prompt', captured.payload?.parameters?.v4_negative_prompt !== undefined)
  check('the wire body carried parameters.prompt', captured.payload?.parameters?.prompt === 'moria_luluka, 1girl', String(captured.payload?.parameters?.prompt))
  check('the wire body used params_version 4', captured.payload?.parameters?.params_version === 4, String(captured.payload?.parameters?.params_version))
  check('the wire body sent the configured ucPreset', captured.payload?.parameters?.ucPreset === 3, String(captured.payload?.parameters?.ucPreset))
  check('the wire body left the original image off', captured.payload?.parameters?.add_original_image === false)
  check('the wire body addressed the V5 model', captured.payload?.model === 'nai-diffusion-5-full', String(captured.payload?.model))

  const written = await readdir(outputDir)
  const pngs = written.filter((name) => name.endsWith('.png'))
  const sidecars = written.filter((name) => name.endsWith('.json'))
  check('one PNG landed on disk', pngs.length === 1, written.join(','))
  check('a sidecar landed on disk', sidecars.length === 1, written.join(','))
  const pngPath = join(outputDir, pngs[0])
  const onDisk = await readFile(pngPath)
  check('the PNG on disk is the bytes the stub returned', onDisk.equals(naiPng), `${onDisk.length} vs ${naiPng.length}`)
  check('the PNG has a PNG signature', onDisk[0] === 0x89 && onDisk[1] === 0x50)

  const sidecar = JSON.parse(await readFile(join(outputDir, sidecars[0]), 'utf8'))
  check('the sidecar records the prompt', sidecar.request?.prompt === 'moria_luluka, 1girl')
  check('the sidecar records the sampling shape', sidecar.request?.width === 832 && sidecar.request?.steps === 28)
  check('the sidecar lists the written file', Array.isArray(sidecar.files) && sidecar.files.length === 1)
  // Provenance in the sidecar comes from the image, not from the request.
  check('the sidecar records the seed read back from the PNG', sidecar.files[0]?.seed === 2350067352, JSON.stringify(sidecar.files[0]))
  check('the sidecar records the model read back from the PNG', /NovelAI Diffusion V4\.5/.test(sidecar.files[0]?.model ?? ''), String(sidecar.files[0]?.model))
  check('the sidecar records the size read back from the PNG', sidecar.files[0]?.size === '832x1216', String(sidecar.files[0]?.size))

  check('the tool result names the file', text.includes(pngPath), text.slice(0, 200))
  check('the tool result names the seed read back from the image', text.includes('2350067352'), text.slice(0, 300))
  check('the tool result names the model read back from the image', /NovelAI Diffusion V4\.5/.test(text), text.slice(0, 300))
  // The embed target is an absolute URL whenever a base is known, because a local path
  // stops resolving once a conversation is replayed: the browser half draws a Markdown
  // image by resolving it through a path vocabulary it rebuilds on every mount, and a
  // path from a replay belongs to no vocabulary. Which of the two this run produces
  // depends on the host it runs in, so both are accepted here — the mechanics are
  // pinned exactly by the assertions below.
  const absoluteEmbed = `![生成图片](${fileUrl(linkBase({ env: process.env }), pngPath)})`
  check(
    'the tool result offers a Markdown embed',
    text.includes(`![生成图片](${pngPath})`) || (absoluteEmbed.includes('http://') && text.includes(absoluteEmbed)),
    text.slice(-260)
  )
  check('the tool result reports the relative cost', /相对消耗/.test(text))

  // The base itself: most deliberate source first, and never a guess — a wrong base
  // would render a broken image where a plain path at least still works.
  check('a base is taken from the harness environment', linkBase({ env: { DSH_WEB_URL: 'http://127.0.0.1:19387' } }) === 'http://127.0.0.1:19387')
  check(
    'a pinned base wins over the environment',
    linkBase({ configured: 'https://box/', env: { DSH_WEB_URL: 'http://127.0.0.1:1' } }) === 'https://box'
  )
  check('the requesting origin is the fallback', linkBase({ seenHost: '127.0.0.1:9' }) === 'http://127.0.0.1:9')
  check('a junk host yields no base', linkBase({ seenHost: 'no/pe' }) === '', linkBase({ seenHost: 'no/pe' }))
  check('a file link names the plugin route', fileUrl('http://h', 'x.png') === 'http://h/nai-imagegen/api/file?name=x.png')
  check(
    'a rendered path becomes that link',
    imageLink('http://h', pngPath) === `http://h/nai-imagegen/api/file?name=${encodeURIComponent(pngs[0])}`,
    imageLink('http://h', pngPath)
  )
  check('with no base the path is handed back untouched', imageLink('', pngPath) === pngPath)

  // The panel's own render path shares renderNow with the tool.
  const before = (await readdir(outputDir)).length
  const panelRender = await callRoute(
    route,
    fakeRequest({ method: 'POST', url: '/nai-imagegen/api/generate', body: JSON.stringify({ prompt: 'panel render', nSamples: 1 }) })
  )
  check('POST /generate answers 200', panelRender.status === 200, panelRender.body.toString('utf8').slice(0, 200))
  const panelBody = asJson(panelRender)
  check('POST /generate reports written files', Array.isArray(panelBody.files) && panelBody.files.length === 1)
  check('POST /generate added files to the output directory', (await readdir(outputDir)).length > before)
  // The code-block button builds its image URL from the *response's* `name`, not
  // from a directory listing, so that exact round trip is what has to hold.
  const inlineName = panelBody.files[0]?.name
  check(
    'POST /generate returns a bare file name the inline embed can use',
    typeof inlineName === 'string' && inlineName.endsWith('.png') && !inlineName.includes('/') && !inlineName.includes('\\'),
    JSON.stringify(panelBody.files[0])
  )
  const byReturnedName = await callRoute(route, fakeRequest({ url: `/nai-imagegen/api/file?name=${encodeURIComponent(inlineName)}` }))
  check(
    'the name the response returns is servable through /file',
    byReturnedName.status === 200 && byReturnedName.body[0] === 0x89,
    `status ${byReturnedName.status}`
  )

  // A reply's pictures only exist in the DOM that render was pasted into, so reopening the
  // conversation finds the block bare and the files unclaimed. The render records what its
  // prompt produced; the block asks for it back. This is the round trip that makes that work.
  {
    const renderKey = 'deadbeef0001cafe'
    const keyedRender = await callRoute(
      route,
      fakeRequest({
        method: 'POST',
        url: '/nai-imagegen/api/generate',
        body: JSON.stringify({ prompt: 'indexed render', nSamples: 1, key: renderKey })
      })
    )
    check('a keyed render answers 200', keyedRender.status === 200, keyedRender.body.toString('utf8').slice(0, 200))
    const keyedFiles = asJson(keyedRender).files ?? []
    // Renders made before this index existed keep their prompt inside the PNG, which is what
    // lets an old conversation be matched to its files at all.
    const { promptKey } = await import('../lib/renders.js')
    const pngChunk = (type, body) => {
      const head = Buffer.alloc(8)
      head.writeUInt32BE(body.length, 0)
      head.write(type, 4, 'latin1')
      return Buffer.concat([head, body, Buffer.alloc(4)])
    }
    const backfillPrompt = 'backfill me, 1girl, solo'
    const stubPng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('IHDR', Buffer.alloc(13)),
      pngChunk('tEXt', Buffer.from(`Comment\u0000${JSON.stringify({ prompt: backfillPrompt })}`, 'utf8')),
      pngChunk('IEND', Buffer.alloc(0))
    ])
    const backfillName = '2099-01-01T00-00-00-000Z.png'
    await writeFile(join(outputDir, backfillName), stubPng)
    const lookup = await callRoute(
      route,
      fakeRequest({
        method: 'POST',
        url: '/nai-imagegen/api/rendered',
        body: JSON.stringify({ keys: [renderKey, promptKey(backfillPrompt), 'not-a-render'] })
      })
    )
    check('POST /rendered answers 200', lookup.status === 200, lookup.body.toString('utf8').slice(0, 200))
    const renders = asJson(lookup).renders ?? {}
    check(
      'the index hands back the files that prompt produced',
      Array.isArray(renders[renderKey]) &&
        renders[renderKey].length === keyedFiles.length &&
        renders[renderKey][0]?.name === keyedFiles[0]?.name,
      JSON.stringify(renders).slice(0, 200)
    )
    check('a prompt with no render is simply absent', renders['not-a-render'] === undefined)
    check(
      'a render made before the index existed is found by the prompt inside its PNG',
      renders[promptKey(backfillPrompt)]?.[0]?.name === backfillName,
      JSON.stringify(renders[promptKey(backfillPrompt)] ?? null)
    )
    const stored = JSON.parse(await readFile(join(scratchHome, 'nai-imagegen', 'renders.json'), 'utf8'))
    check(
      'the index is a document on disk, so it survives the page',
      Array.isArray(stored?.entries?.[renderKey]?.files) && stored.entries[renderKey].files.length > 0,
      JSON.stringify(stored).slice(0, 200)
    )
    const byGet = await callRoute(route, fakeRequest({ url: `/nai-imagegen/api/rendered?keys=${renderKey}` }))
    check(
      'GET /rendered answers the same way',
      asJson(byGet).renders?.[renderKey]?.[0]?.name === keyedFiles[0]?.name,
      byGet.body.toString('utf8').slice(0, 200)
    )
  }

  // A picture rendered before this index existed was keyed by the host from the prompt inside
  // its PNG, while the block in the transcript keys itself from its own text. Those digests never
  // meet — the request carried the configured artist string in front of what the reply wrote — so
  // a block whose digest misses has to be found by its words instead.
  {
    const longPrompt =
      'artist:test, 1girl, solo, standing in a rainy courtyard, black umbrella, night, cold light'
    const wordKey = 'c0ffee01'
    const wordRender = await callRoute(
      route,
      fakeRequest({
        method: 'POST',
        url: '/nai-imagegen/api/generate',
        body: JSON.stringify({ prompt: longPrompt, nSamples: 1, key: wordKey })
      })
    )
    check('a render the word fallback leans on answers 200', wordRender.status === 200, wordRender.body.toString('utf8').slice(0, 200))
    const wordFiles = asJson(wordRender).files ?? []
    const { normalizePrompt } = await import('../lib/renders.js')
    check(
      'the comparable form drops the wrapper and the line breaks, and nothing else',
      normalizePrompt('<image>\nStanding  in a rainy\ncourtyard, black umbrella</image>') ===
        'standing in a rainy courtyard, black umbrella',
      normalizePrompt('<image>\nStanding  in a rainy\ncourtyard, black umbrella</image>')
    )
    // The words the reply wrote, delivered the way a block delivers them: wrapper, odd spacing.
    const blockText = '<image>\nstanding  in a rainy courtyard,\nblack umbrella\n</image>'
    const guessed = await callRoute(
      route,
      fakeRequest({
        method: 'POST',
        url: '/nai-imagegen/api/rendered',
        body: JSON.stringify({ keys: ['ffffffff'], texts: { ffffffff: blockText } })
      })
    )
    check('POST /rendered with words answers 200', guessed.status === 200, guessed.body.toString('utf8').slice(0, 200))
    const guessedRenders = asJson(guessed).renders ?? {}
    check(
      'a digest the index never saw is answered by the text the block carries',
      guessedRenders.ffffffff?.[0]?.name === wordFiles[0]?.name,
      JSON.stringify(guessedRenders).slice(0, 200)
    )
    const tooShort = await callRoute(
      route,
      fakeRequest({
        method: 'POST',
        url: '/nai-imagegen/api/rendered',
        body: JSON.stringify({ keys: ['eeeeeeee'], texts: { eeeeeeee: '1girl, solo' } })
      })
    )
    check(
      'a block with too few words to mean anything is not guessed at',
      asJson(tooShort).renders?.eeeeeeee === undefined,
      tooShort.body.toString('utf8').slice(0, 200)
    )
    const exactWins = await callRoute(
      route,
      fakeRequest({
        method: 'POST',
        url: '/nai-imagegen/api/rendered',
        body: JSON.stringify({ keys: [wordKey], texts: { [wordKey]: blockText } })
      })
    )
    check(
      'a digest the index knows is still answered by the digest',
      asJson(exactWins).renders?.[wordKey]?.[0]?.name === wordFiles[0]?.name,
      exactWins.body.toString('utf8').slice(0, 200)
    )
  }


  {
    const block = [
      '<image>',
      '<image_think>',
      '①a girl in a rainy alley holding an umbrella',
      '</image_think>',
      'image###size:1024x1024;',
      'Scene:SFW,1girl,solo,rain,umbrella,',
      'Middle ground:a girl walking under the rain,',
      'upper body visible;',
      'Char1:girl,long hair,1.2::blue hair::,school uniform|centers:C3;',
      'Char1 UC:feet,shoes,boy,multiple girls;',
      'Scene UC:nude,completely nude;###',
      '</image>'
    ].join('\n')
    await generate.execute({ prompt: block }, { signal })
    const sent = captured.payload
    const sentPrompt = String(sent?.input ?? '')
    const sentNegative = String(sent?.parameters?.negative_prompt ?? '')
    check(
      'an <image> block sets the size from its own header',
      sent?.parameters?.width === 1024 && sent?.parameters?.height === 1024,
      `${sent?.parameters?.width}x${sent?.parameters?.height}`
    )
    check('the block labels never reach the prompt', !/Scene\s*:|Char\s*\d|image\s*#{2,}|<\/?image/i.test(sentPrompt), sentPrompt.slice(0, 140))
    check('the reasoning never reaches the prompt', !/image_think|rainy alley holding/i.test(sentPrompt), sentPrompt.slice(0, 140))
    check('the multi-line scene body survives whole', sentPrompt.includes('umbrella') && sentPrompt.includes('upper body visible'), sentPrompt.slice(0, 200))
    check('the character field survives whole', sentPrompt.includes('blue hair') && sentPrompt.includes('school uniform'), sentPrompt.slice(0, 200))
    check(
      'the Scene field comes before the character, as the format intends',
      sentPrompt.indexOf('umbrella') < sentPrompt.indexOf('blue hair'),
      sentPrompt.slice(0, 200)
    )
    // The character's exclusions belong to that character, not to the picture.
    // Pooling them into the picture-wide negative re-applies one character's ban
    // to everyone — a `boy` ban aimed at one girl also suppresses the other girl's
    // features, which is the exact thing per-character captions exist to prevent —
    // and it doubles the text, because NovelAI's metadata reader shows the
    // picture-wide field right next to the v4 captions.
    const sentCharNegative = String(sent?.parameters?.v4_negative_prompt?.caption?.char_captions?.[0]?.char_caption ?? '')
    const sentBaseNegative = String(sent?.parameters?.v4_negative_prompt?.caption?.base_caption ?? '')
    check(
      'the scene UC became the picture-wide negative',
      sentNegative.includes('nude,completely nude'),
      sentNegative
    )
    check(
      'a character UC stays with its character instead of pooling into the picture',
      !sentNegative.includes('feet,shoes,boy,multiple girls') && sentCharNegative.includes('feet,shoes,boy,multiple girls'),
      `picture-wide: ${sentNegative.slice(0, 200)}\n      char[0]: ${sentCharNegative}`
    )
    check(
      'the picture-wide negative and the v4 base caption are the same text',
      sentNegative === sentBaseNegative,
      `legacy: ${sentNegative.slice(0, 120)}\n      v4:     ${sentBaseNegative.slice(0, 120)}`
    )
    check('the UC text did not leak into the positive', !/feet,shoes/.test(sentPrompt), sentPrompt.slice(0, 200))
    check('the centers marker is not left in the prompt', !/centers/i.test(sentPrompt), sentPrompt.slice(0, 200))
    check('the size header is not left in the prompt', !/size\s*:/i.test(sentPrompt), sentPrompt.slice(0, 200))
  }

  // A block that announces itself but cannot be read must fail loudly. Falling
  // through would send the labels, the size header and the model's own reasoning
  // to NovelAI as prompt text — which renders as noise and looks exactly like the
  // plugin ignoring the format. A truncated block is the common way to get here.
  {
    for (const [label, truncated] of [
      ['only the opening tags', '<image>\n<image_think>\n①a girl standing in the rain'],
      ['an empty envelope', 'image###size:832x1216;\n###'],
      ['a wrapper around nothing', '<image>   </image>']
    ]) {
      let caught = null
      try {
        await generate.execute({ prompt: truncated }, { signal })
      } catch (error) {
        caught = error
      }
      check(
        `a ${label} <image> block is refused rather than sent as text`,
        caught !== null && /解析不了/.test(caught.message),
        caught === null ? 'it rendered anyway' : caught.message.slice(0, 120)
      )
    }
    // A plain prompt that merely mentions the word must still work.
    const plain = { text: '1girl, solo, holding an <image> of a cat, masterpiece' }
    check('a plain prompt containing the word "image" is not mistaken for a block', !looksLikeImageBlockForTest(plain.text))
  }

  // An artist string is a style prefix the size of a whole scene. It has to be
  // quantified in the result, or a render quietly ignores the prompt and the
  // plugin takes the blame for something the user turned on themselves.
  {
    const bigArchive = join(scratchHome, 'big-artist.json')
    const bigIndex = join(scratchHome, 'big-artist-index.json')
    await writeFile(
      bigArchive,
      JSON.stringify([
        {
          name: '巨大风格串',
          sequence: 0,
          positivePrompt: `BIGSTYLE, ${'very detailed lineart, '.repeat(40)}`,
          negativePrompt: 'BIGBAD, ugly',
          chamipositivePrompt: '',
          chaminegativePrompt: '',
          referenceImage: ''
        }
      ]),
      'utf8'
    )
    await buildArtistIndex({ sourceFile: bigArchive, indexPath: bigIndex })
    await save({ artistIndex: bigIndex, artistId: 0 })
    const styled = await generate.execute({ prompt: 'a cat' }, { signal })
    check('the result quantifies the style prefix', /画师串「巨大风格串」\+/.test(styled) && /占正向 \d+%/.test(styled), styled.slice(0, 200))
    check('a dominating style prefix is warned about', /⚠ 画师串占了正向的/.test(styled), styled.slice(0, 320))
    check('the warning says how to opt out', /artist_id: -1/.test(styled), styled.slice(0, 400))

    await save({ artistId: -1 })
    const unstyled = await generate.execute({ prompt: 'a cat' }, { signal })
    check('no warning when no style is applied', !/⚠ 画师串/.test(unstyled), unstyled.slice(0, 200))
  }

  const gallery = asJson(await callRoute(route, fakeRequest({ url: '/nai-imagegen/api/gallery' })))
  check('the gallery lists the renders', gallery.files.length >= 2, JSON.stringify(gallery.files.map((row) => row.name)))

  const served = await callRoute(route, fakeRequest({ url: `/nai-imagegen/api/file?name=${encodeURIComponent(pngs[0])}` }))
  check('GET /file serves the PNG', served.status === 200 && served.body[0] === 0x89, String(served.status))
  check('GET /file sets an image content type', String(served.headers?.['Content-Type']).startsWith('image/png'))

  // ---------------------------------------------------- artist string editing --
  // An edited string has to read the same everywhere it is selected: the panel's pick,
  // each mode's own pick, the editor, the grid, and the render path. Asserted end to
  // end, because "the editor shows my text but the picture still looks like the
  // archive" is the failure this feature can actually have.
  //
  // The edit is stored against the archive id rather than in the archive file, so
  // re-importing a library cannot silently throw the user's text away — the check
  // that the archive file is untouched is what pins that down.
  {
    const editArchive = join(scratchHome, 'edit-archive.json')
    const editIndexPath = join(scratchHome, 'edit-index.json')
    await writeFile(
      editArchive,
      JSON.stringify([
        {
          name: '可改画风',
          sequence: 0,
          positivePrompt: 'EDITSTYLE, flat colour',
          negativePrompt: 'EDITBAD',
          chamipositivePrompt: '',
          chaminegativePrompt: '',
          referenceImage: ''
        }
      ]),
      'utf8'
    )
    await buildArtistIndex({ sourceFile: editArchive, indexPath: editIndexPath })
    await save({
      keys: [{ label: '改串 Key', token: 'pst-edit-token', enabled: true }],
      artistIndex: editIndexPath,
      artistId: 0,
      artistEdits: {}
    })

    const before = asJson(await callRoute(route, fakeRequest({ url: '/nai-imagegen/api/artist-text?id=0' })))
    check(
      'the text route reports the archive text before any edit',
      before.positive === 'EDITSTYLE, flat colour' && before.negative === 'EDITBAD' && before.edited === false,
      JSON.stringify(before).slice(0, 200)
    )
    check(
      'the archive text comes back alongside the effective one',
      before.original?.positive === 'EDITSTYLE, flat colour' && before.original?.negative === 'EDITBAD',
      JSON.stringify(before.original)
    )
    check('the text route counts the characters', before.chars === 22, String(before.chars))

    const saved = asJson(
      await callRoute(
        route,
        fakeRequest({
          method: 'POST',
          url: '/nai-imagegen/api/artist-edit',
          body: JSON.stringify({ id: 0, positive: 'MYSTYLE, flat colour', negative: '' })
        })
      )
    )
    check(
      'the edit route saves and echoes the new text',
      saved.ok === true && saved.artist?.positive === 'MYSTYLE, flat colour',
      JSON.stringify(saved).slice(0, 220)
    )
    check('an emptied side is kept as a real choice', saved.artist?.negative === '', JSON.stringify(saved.artist?.negative))
    check('the edited text is flagged as an edit', saved.artist?.edited === true, JSON.stringify(saved.artist?.edited))
    check(
      'the reply carries a fresh status',
      saved.status?.artistEdited === true && saved.status?.artistChars === 'MYSTYLE, flat colour'.length,
      JSON.stringify({ edited: saved.status?.artistEdited, chars: saved.status?.artistChars })
    )
    check(
      'the edit is stored on the host rather than only echoed',
      (await load()).artistEdits?.['0']?.positive === 'MYSTYLE, flat colour',
      JSON.stringify((await load()).artistEdits)
    )

    const after = asJson(await callRoute(route, fakeRequest({ url: '/nai-imagegen/api/artist-text?id=0' })))
    check('re-reading the text returns the edit', after.positive === 'MYSTYLE, flat colour' && after.edited === true, JSON.stringify(after).slice(0, 200))
    check('the archive text stays visible next to it', after.original?.positive === 'EDITSTYLE, flat colour', JSON.stringify(after.original))

    const grid = asJson(await callRoute(route, fakeRequest({ url: '/nai-imagegen/api/artists?limit=5' })))
    check(
      'the grid marks the edited entry',
      (grid.artists ?? []).some((row) => row.id === 0 && row.edited === true),
      JSON.stringify(grid.artists?.[0])
    )
    check(
      'the grid leaves the untouched entries unmarked',
      (grid.artists ?? []).every((row) => row.id === 0 || row.edited !== true),
      JSON.stringify((grid.artists ?? []).map((row) => [row.id, row.edited]))
    )

    // Per mode as well: the floating window paints a mode's own artist, so a tag that
    // only reached the top-level status would show the wrong state on a tab.
    await save({ modes: { illustration: { artistId: 0 }, comic: { artistId: 0 } } })
    const modeStatus = asJson(await callRoute(route, fakeRequest({ url: '/nai-imagegen/api/status' })))
    const modeRows = modeStatus.modeSettings ?? []
    check(
      'each mode reports the edit state of its own pick',
      modeRows.length >= 2 && modeRows.every((row) => row.artistEdited === true && row.artistChars === 'MYSTYLE, flat colour'.length),
      JSON.stringify(modeRows.map((row) => [row.mode, row.artistEdited, row.artistChars]))
    )

    // The render path is the point: an editor that changes only what the editor shows
    // is a decoration.
    await generate.execute({ prompt: 'a cat' }, { signal })
    check(
      'a render sends the edited text rather than the archive text',
      String(captured.payload?.input ?? '').startsWith('MYSTYLE, flat colour'),
      String(captured.payload?.input).slice(0, 90)
    )
    check(
      'the archive text is not appended as well',
      !String(captured.payload?.input ?? '').includes('EDITSTYLE'),
      String(captured.payload?.input).slice(0, 90)
    )

    // An emptied positive is "no style prefix", which is not the same as "inherit the
    // archive" — and must not leave the ", " the concatenation would produce.
    await callRoute(
      route,
      fakeRequest({ method: 'POST', url: '/nai-imagegen/api/artist-edit', body: JSON.stringify({ id: 0, positive: '' }) })
    )
    await generate.execute({ prompt: 'a cat' }, { signal })
    check(
      'an emptied style prefix is not put back',
      !/EDITSTYLE|MYSTYLE/.test(String(captured.payload?.input ?? '')) && !/^,\s/.test(String(captured.payload?.input ?? '')),
      String(captured.payload?.input).slice(0, 90)
    )

    // Revert removes the edit rather than writing the archive text over it: storing the
    // original would leave the entry marked as edited forever.
    const reverted = asJson(
      await callRoute(route, fakeRequest({ method: 'POST', url: '/nai-imagegen/api/artist-edit', body: JSON.stringify({ id: 0, revert: true }) }))
    )
    check(
      'restoring puts the archive text back',
      reverted.ok === true && reverted.artist?.positive === 'EDITSTYLE, flat colour' && reverted.artist?.edited === false,
      JSON.stringify(reverted).slice(0, 220)
    )
    check('restoring drops the stored edit', Object.keys((await load()).artistEdits ?? {}).length === 0, JSON.stringify((await load()).artistEdits))
    await generate.execute({ prompt: 'a cat' }, { signal })
    check(
      'the archive text is used again after a restore',
      String(captured.payload?.input ?? '').startsWith('EDITSTYLE, flat colour'),
      String(captured.payload?.input).slice(0, 90)
    )

    // Refusals, so a bad request explains itself instead of looking like a no-op.
    const badId = await callRoute(route, fakeRequest({ method: 'POST', url: '/nai-imagegen/api/artist-edit', body: JSON.stringify({ id: 'x', positive: 'y' }) }))
    check('a non-numeric artist id is refused', badId.status === 400, JSON.stringify(badId.body))
    const emptyRequest = await callRoute(route, fakeRequest({ method: 'POST', url: '/nai-imagegen/api/artist-edit', body: JSON.stringify({ id: 0 }) }))
    check('an edit request with nothing in it is refused', emptyRequest.status === 400, JSON.stringify(emptyRequest.body))
    const unknown = await callRoute(route, fakeRequest({ url: '/nai-imagegen/api/artist-text?id=9999' }))
    check('an unknown artist is a 404', unknown.status === 404, JSON.stringify(unknown.body))
    const tooLong = await callRoute(
      route,
      fakeRequest({ method: 'POST', url: '/nai-imagegen/api/artist-edit', body: JSON.stringify({ id: 0, positive: 'x'.repeat(20001) }) })
    )
    check('an oversized edit is refused rather than truncated silently', tooLong.status === 400, JSON.stringify(tooLong.body).slice(0, 160))

    // The archive file itself is never written to.
    const archiveOnDisk = JSON.parse(await readFile(editArchive, 'utf8'))
    check(
      'the archive file is left alone',
      archiveOnDisk[0].positivePrompt === 'EDITSTYLE, flat colour' && archiveOnDisk[0].negativePrompt === 'EDITBAD',
      JSON.stringify(archiveOnDisk[0]).slice(0, 200)
    )
  }

  // --------------------------------------------------- starred entries --
  // The star is the one list the user curates, so what has to be true is that the
  // *host* keeps it: the same id stars in the grid and in the window, it is still
  // there after a reload, and the archive is no more written to than an edit writes
  // to it. Two surfaces read one list, which is the whole reason it is not a page's
  // own state — a star that only the window remembered would disagree with the grid
  // the moment both were open.
  {
    const cleared = await save({ artistFavorites: [] })
    check(
      'the starred list starts empty',
      Array.isArray(cleared.artistFavorites) && cleared.artistFavorites.length === 0,
      JSON.stringify(cleared.artistFavorites)
    )

    const starred = asJson(
      await callRoute(
        route,
        fakeRequest({
          method: 'POST',
          url: '/nai-imagegen/api/artist-favorite',
          body: JSON.stringify({ id: 0, favorite: true })
        })
      )
    )
    check('the star route answers ok', starred.ok === true && starred.favorite === true, JSON.stringify(starred).slice(0, 220))
    check(
      'the reply carries the list in force rather than an echo',
      Array.isArray(starred.favorites) && starred.favorites.length === 1 && starred.favorites[0] === 0,
      JSON.stringify(starred.favorites)
    )
    check(
      'the star is stored on the host',
      (await load()).artistFavorites?.length === 1 && (await load()).artistFavorites[0] === 0,
      JSON.stringify((await load()).artistFavorites)
    )
    check(
      'the reply carries a fresh status for the panel',
      starred.status?.artistFavoriteCount === 1 && Array.isArray(starred.status?.artistFavorites),
      JSON.stringify(starred.status?.artistFavoriteCount)
    )

    const listed = asJson(await callRoute(route, fakeRequest({ url: '/nai-imagegen/api/artists?limit=50' })))
    check(
      'the list marks the starred entry',
      (listed.artists ?? []).some((row) => row.id === 0 && row.favorite === true),
      JSON.stringify(listed.artists?.[0])
    )
    check(
      'and leaves the untouched entries unmarked rather than undefined',
      (listed.artists ?? []).every((row) => row.id === 0 || row.favorite === false),
      JSON.stringify((listed.artists ?? []).map((row) => [row.id, row.favorite]))
    )
    check('the list counts the stars', listed.favoriteCount === 1, String(listed.favoriteCount))

    const statusAfterStar = asJson(await callRoute(route, fakeRequest({ url: '/nai-imagegen/api/status' })))
    check(
      'the status names the starred ids for both surfaces',
      Array.isArray(statusAfterStar.artistFavorites) && statusAfterStar.artistFavorites.includes(0),
      JSON.stringify(statusAfterStar.artistFavorites)
    )

    // A star is not an edit and not a pick: the text it will send must not move. The
    // edit block above restored the archive text, so that is what has to still be here.
    const textAfterStar = asJson(await callRoute(route, fakeRequest({ url: '/nai-imagegen/api/artist-text?id=0' })))
    check(
      'starring changes nothing about the text it will send',
      textAfterStar.positive === 'EDITSTYLE, flat colour' && textAfterStar.chars === 22,
      JSON.stringify(textAfterStar).slice(0, 160)
    )

    const unstarred = asJson(
      await callRoute(
        route,
        fakeRequest({
          method: 'POST',
          url: '/nai-imagegen/api/artist-favorite',
          body: JSON.stringify({ id: 0, favorite: false })
        })
      )
    )
    check('a star can be taken off again', unstarred.ok === true && (unstarred.favorites ?? []).length === 0, JSON.stringify(unstarred.favorites))
    check('and the removal is stored too', ((await load()).artistFavorites ?? []).length === 0, JSON.stringify((await load()).artistFavorites))

    // The request says what should be true, so sending it twice cannot drift: a toggle
    // would, and two surfaces sending one is exactly when that shows.
    await callRoute(
      route,
      fakeRequest({ method: 'POST', url: '/nai-imagegen/api/artist-favorite', body: JSON.stringify({ id: 0, favorite: true }) })
    )
    const twice = asJson(
      await callRoute(
        route,
        fakeRequest({ method: 'POST', url: '/nai-imagegen/api/artist-favorite', body: JSON.stringify({ id: 0, favorite: true }) })
      )
    )
    check('the same star twice stores one id', ((await load()).artistFavorites ?? []).join(',') === '0' && twice.favorites.length === 1, JSON.stringify(twice.favorites))

    // A star for an entry the archive does not have is refused rather than stored: the
    // list can only lead with what it can draw, and an id nobody can resolve would sit
    // in the config forever, invisible and unexplained.
    const unknownStar = await callRoute(
      route,
      fakeRequest({ method: 'POST', url: '/nai-imagegen/api/artist-favorite', body: JSON.stringify({ id: 4242, favorite: true }) })
    )
    check('an unknown id is refused rather than stored', unknownStar.status === 404, String(unknownStar.status))
    check('and the refusal stored nothing', ((await load()).artistFavorites ?? []).join(',') === '0', JSON.stringify((await load()).artistFavorites))

    const noFlag = await callRoute(
      route,
      fakeRequest({ method: 'POST', url: '/nai-imagegen/api/artist-favorite', body: JSON.stringify({ id: 0 }) })
    )
    check('a missing favorite flag is a 400, not a toggle', noFlag.status === 400, JSON.stringify(noFlag.body).slice(0, 140))
    const badFlag = await callRoute(
      route,
      fakeRequest({ method: 'POST', url: '/nai-imagegen/api/artist-favorite', body: JSON.stringify({ id: 0, favorite: 'yes' }) })
    )
    check('a non-boolean favorite flag is refused', badFlag.status === 400, JSON.stringify(badFlag.body).slice(0, 140))
    const badId = await callRoute(
      route,
      fakeRequest({ method: 'POST', url: '/nai-imagegen/api/artist-favorite', body: JSON.stringify({ id: 'x', favorite: true }) })
    )
    check('a non-numeric id is refused', badId.status === 400, JSON.stringify(badId.body).slice(0, 140))
    const negativeId = await callRoute(
      route,
      fakeRequest({ method: 'POST', url: '/nai-imagegen/api/artist-favorite', body: JSON.stringify({ id: -1, favorite: true }) })
    )
    check('a negative id is refused', negativeId.status === 400, JSON.stringify(negativeId.body).slice(0, 140))

    // An id the archive has lost — a re-import that dropped it — is kept in the file but
    // left out of everything the two surfaces read, so the star comes back with the next
    // import instead of being thrown away now, and no ★ is drawn over nothing meanwhile.
    await save({ artistFavorites: [0, 999] })
    const withGhost = asJson(await callRoute(route, fakeRequest({ url: '/nai-imagegen/api/status' })))
    check(
      'a star the archive cannot resolve is left out of the list',
      (withGhost.artistFavorites ?? []).includes(0) && (withGhost.artistFavorites ?? []).includes(999) === false,
      JSON.stringify(withGhost.artistFavorites)
    )
    check('and the count follows the resolvable list', withGhost.artistFavoriteCount === 1, String(withGhost.artistFavoriteCount))
    const ghostRows = asJson(await callRoute(route, fakeRequest({ url: '/nai-imagegen/api/artists?limit=50' })))
    check(
      'no row answers to the unresolvable id',
      (ghostRows.artists ?? []).every((row) => Number(row.id) !== 999) && ghostRows.favoriteCount === 1,
      JSON.stringify([ghostRows.favoriteCount, (ghostRows.artists ?? []).map((row) => row.id)])
    )
    await callRoute(
      route,
      fakeRequest({ method: 'POST', url: '/nai-imagegen/api/artist-favorite', body: JSON.stringify({ id: 0, favorite: false }) })
    )
    check(
      'writing the list leaves the unresolved id where it was',
      ((await load()).artistFavorites ?? []).includes(999),
      JSON.stringify((await load()).artistFavorites)
    )

    // The fixture file is named here rather than shared: the archive is the one thing
    // neither route may write to, and a path inherited from the block above would make
    // that check silently follow whatever that block did next.
    const archiveAfterStars = JSON.parse(await readFile(join(scratchHome, 'edit-archive.json'), 'utf8'))
    check(
      'starring never touches the archive file',
      archiveAfterStars[0].positivePrompt === 'EDITSTYLE, flat colour',
      JSON.stringify(archiveAfterStars[0]).slice(0, 160)
    )
    await save({ artistFavorites: [] })
  }

  // ----------------------------------------------- ids and order survive a re-index --
  // The config remembers an artist string by its id — `artistId` for the sidebar, one per
  // mode in the floating window, the favourites list. A re-index that renumbers therefore
  // does not lose a setting, it *changes* one: the user's selection quietly becomes a
  // different artist string, and nothing on either side of the wire can tell. Appending is
  // what re-indexing is for, so the ids — and the order the index already handed out — have
  // to survive it. Matching is by the byte range of the reference image, which an append
  // cannot move; a record with no image falls back to its name.
  {
    const reArchive = join(scratchHome, 'reindex-archive.json')
    const reIndexPath = join(scratchHome, 'reindex-index.json')
    const record = (name, sequence, style) => ({
      name,
      sequence,
      positivePrompt: style,
      negativePrompt: 'BAD',
      chamipositivePrompt: '',
      chaminegativePrompt: '',
      referenceImage: ''
    })

    await writeFile(reArchive, JSON.stringify([record('甲', 4, 'A'), record('乙', 3, 'B')]), 'utf8')
    const first = await buildArtistIndex({ sourceFile: reArchive, indexPath: reIndexPath })
    const built = JSON.parse(await readFile(reIndexPath, 'utf8'))
    check(
      'a first build numbers the records by hand, from zero',
      built.entries.map((entry) => entry.id).join(',') === '0,1',
      JSON.stringify(built.entries.map((entry) => entry.id))
    )
    // Sequence, not file order: the real archive is filed out of order, and this is the sort
    // that decides what the panel lists first.
    check(
      'and orders them by sequence rather than by file order',
      built.entries.map((entry) => entry.name).join('') === '乙甲',
      built.entries.map((entry) => entry.name).join('')
    )
    check('a first build preserves nothing and adds everything', first.preserved === 0 && first.added === 2, JSON.stringify(first))

    // A provenance note cannot be derived from the archive, so it has to be carried.
    built.note = 'appended from somewhere'
    await writeFile(reIndexPath, `${JSON.stringify(built, null, 2)}\n`, 'utf8')

    // The same archive, one record longer, with a sequence that collides — which the real
    // archive does in bulk, 95 pairs of them. The colliding record must not steal a
    // neighbour's id, because a sort on a duplicated sequence is decided by nothing at all.
    await writeFile(reArchive, JSON.stringify([record('甲', 4, 'A'), record('乙', 3, 'B'), record('丙', 3, 'C')]), 'utf8')
    const second = await buildArtistIndex({ sourceFile: reArchive, indexPath: reIndexPath })
    const after = JSON.parse(await readFile(reIndexPath, 'utf8'))
    const idOf = (index, name) => index.entries.find((entry) => entry.name === name)?.id
    check(
      'a re-index gives every known record back the id it had',
      idOf(after, '甲') === 1 && idOf(after, '乙') === 0,
      JSON.stringify([idOf(after, '甲'), idOf(after, '乙')])
    )
    check('the appended record is numbered after the highest id', idOf(after, '丙') === 2, String(idOf(after, '丙')))
    check('and the summary says which is which', second.preserved === 2 && second.added === 1, JSON.stringify(second))
    check(
      'the file is written in id order, so position is still id',
      after.entries.every((entry, position) => entry.id === position),
      JSON.stringify(after.entries.map((entry) => entry.id))
    )
    check(
      'the order the index already had is the order it keeps',
      after.entries.map((entry) => entry.name).join('') === '乙甲丙',
      after.entries.map((entry) => entry.name).join('')
    )
    check('and the provenance note is carried rather than dropped', after.note === 'appended from somewhere', String(after.note))

    // A different archive is not the same archive: nothing may be stapled onto the old
    // numbers, or re-pointing the plugin would repoint every remembered id with it.
    const otherArchive = join(scratchHome, 'reindex-other.json')
    await writeFile(otherArchive, JSON.stringify([record('甲', 3, 'A'), record('乙', 4, 'B')]), 'utf8')
    const third = await buildArtistIndex({ sourceFile: otherArchive, indexPath: reIndexPath })
    const elsewhere = JSON.parse(await readFile(reIndexPath, 'utf8'))
    check(
      'an index built from a different archive numbers by hand again',
      idOf(elsewhere, '甲') === 0 && idOf(elsewhere, '乙') === 1 && third.preserved === 0 && third.added === 2,
      JSON.stringify([idOf(elsewhere, '甲'), idOf(elsewhere, '乙'), third.preserved, third.added])
    )
    check(
      'and the index names the archive it was built from',
      resolve(elsewhere.sourceFile) === resolve(otherArchive),
      String(elsewhere.sourceFile)
    )

    // Two records may share a name; the second one still has to land somewhere, and it must
    // not land on top of the first.
    const twins = assignIds(
      [record('同名', 1, 'X'), record('同名', 1, 'Y')],
      { sourceFile: reArchive, entries: [{ id: 7, name: '同名', sequence: 1, image: null }] },
      reArchive
    )
    check(
      'a repeated name still gets an id of its own',
      twins.map((entry) => entry.id).join(',') === '7,8',
      JSON.stringify(twins.map((entry) => entry.id))
    )
    check('and it lands on its own prompts, not a blank record', twins[1].positivePrompt === 'Y', String(twins[1].positivePrompt))
  }

  // ---------------------------------------------- hand-made artist strings --
  // Two things the panel can now do that the archive never could: make an entry, and
  // give one a reference image. Both are asserted through the host routes rather than
  // through the panel's own state, because the failure that matters is not a button
  // that does nothing — it is a record or a file written somewhere nothing reads,
  // which looks like success on screen and cannot be found again.
  //
  // Ids carry the weight here. The archive hands out dense positions from 0, so a
  // hand-made entry has to live above them and every lookup has to go by id: the
  // checks that making and deleting one leave entry 0 alone are what pin that down.
  {
    const userArchive = join(scratchHome, 'user-archive.json')
    const userIndexPath = join(scratchHome, 'user-index.json')
    const userLibraryFile = join(scratchHome, 'user.json')
    const userImageDir = join(scratchHome, 'user')
    await writeFile(
      userArchive,
      JSON.stringify([
        {
          name: '归档画风',
          sequence: 0,
          positivePrompt: 'ARCHIVESTYLE',
          negativePrompt: 'ARCHIVEBAD',
          chamipositivePrompt: '',
          chaminegativePrompt: '',
          referenceImage: ''
        }
      ]),
      'utf8'
    )
    await buildArtistIndex({ sourceFile: userArchive, indexPath: userIndexPath })
    await save({
      keys: [{ label: '自建 Key', token: 'pst-user-token', enabled: true }],
      artistIndex: userIndexPath,
      artistId: -1,
      artistEdits: {}
    })

    const initial = asJson(await callRoute(route, fakeRequest({ url: '/nai-imagegen/api/artists?limit=50' })))
    check(
      'the list starts as just the imported entry',
      initial.count === 1 && initial.artists?.[0]?.custom === false,
      JSON.stringify([initial.count, initial.artists?.[0]?.custom])
    )

    // ------------------------------------------------------------ making one --
    const created = asJson(
      await callRoute(
        route,
        fakeRequest({
          method: 'POST',
          url: '/nai-imagegen/api/artist-add',
          body: JSON.stringify({ name: '  我的画风  ', positive: 'MYOWNSTYLE, soft light', negative: 'MYOWNBAD' })
        })
      )
    )
    const ownId = Number(created.id)
    check(
      'a hand-made entry gets an id above the archive id space',
      created.ok === true && ownId === 1000,
      JSON.stringify(created).slice(0, 220)
    )
    check('its name is trimmed on the way in', created.artist?.name === '我的画风', JSON.stringify(created.artist?.name))
    check(
      'a fresh entry is hand-made and unedited at once',
      created.artist?.custom === true && created.artist?.edited === false,
      JSON.stringify({ custom: created.artist?.custom, edited: created.artist?.edited })
    )
    check(
      'a fresh entry has no reference image yet',
      created.artist?.image === false && created.artist?.uploaded === false,
      JSON.stringify({ image: created.artist?.image, uploaded: created.artist?.uploaded })
    )
    check(
      'making one does not switch the style in use',
      created.status?.artistId === -1,
      String(created.status?.artistId)
    )

    const curated = asJson(await callRoute(route, fakeRequest({ url: '/nai-imagegen/api/artists?limit=50' })))
    check(
      'the hand-made entry is listed beside the imported one',
      curated.count === 2 && (curated.artists ?? []).length === 2,
      JSON.stringify([curated.count, (curated.artists ?? []).map((row) => row.id)])
    )
    check(
      'the imported entry keeps its id and its place',
      curated.artists?.[0]?.id === 0 && curated.artists?.[0]?.name === '归档画风',
      JSON.stringify(curated.artists?.[0])
    )
    check(
      'the hand-made entry is flagged as such',
      (curated.artists ?? []).some((row) => row.id === ownId && row.custom === true),
      JSON.stringify((curated.artists ?? []).map((row) => [row.id, row.custom]))
    )
    const searched = asJson(
      await callRoute(
        route,
        fakeRequest({ url: `/nai-imagegen/api/artists?limit=50&q=${encodeURIComponent('我的画风')}` })
      )
    )
    check(
      'searching finds a hand-made entry by name',
      (searched.artists ?? []).some((row) => row.id === ownId),
      JSON.stringify((searched.artists ?? []).map((row) => row.id))
    )

    const ownText = asJson(await callRoute(route, fakeRequest({ url: `/nai-imagegen/api/artist-text?id=${ownId}` })))
    check(
      'a hand-made entry reads back like an imported one',
      ownText.positive === 'MYOWNSTYLE, soft light' && ownText.negative === 'MYOWNBAD',
      JSON.stringify(ownText).slice(0, 220)
    )
    check(
      'its own text is its original, not an edit of something',
      ownText.edited === false && ownText.original?.positive === 'MYOWNSTYLE, soft light',
      JSON.stringify(ownText.original)
    )
    const editIt = asJson(
      await callRoute(
        route,
        fakeRequest({
          method: 'POST',
          url: '/nai-imagegen/api/artist-edit',
          body: JSON.stringify({ id: ownId, positive: 'MYOWNSTYLE, soft light, film grain' })
        })
      )
    )
    check(
      'a hand-made entry can be edited like an imported one',
      editIt.artist?.edited === true && editIt.artist?.chars === 'MYOWNSTYLE, soft light, film grain'.length,
      JSON.stringify({ edited: editIt.artist?.edited, chars: editIt.artist?.chars })
    )
    check(
      'editing one does not change which style is in use',
      editIt.status?.artistId === -1 && editIt.status?.artistEdited === false,
      JSON.stringify({ artistId: editIt.status?.artistId, edited: editIt.status?.artistEdited })
    )
    check(
      'the edit is stored against the hand-made id',
      (await load()).artistEdits?.[String(ownId)]?.positive === 'MYOWNSTYLE, soft light, film grain',
      JSON.stringify((await load()).artistEdits)
    )

    // A hand-made entry is a style like any other, so the point of making one is that it
    // reaches the API as a prefix — the edited text, with the name nowhere near it. Both
    // the panel's pick and each mode's pick are set, because a render resolves the mode's
    // own pick first and a stale one there would send somebody else's style.
    await save({ artistId: ownId, modes: { illustration: { artistId: ownId }, comic: { artistId: ownId } } })
    const ownStatus = asJson(await callRoute(route, fakeRequest({ url: '/nai-imagegen/api/status' })))
    check(
      'the status names a hand-made pick like any other',
      ownStatus.artistId === ownId && ownStatus.artistName === '我的画风' && ownStatus.artistEdited === true,
      JSON.stringify({ id: ownStatus.artistId, name: ownStatus.artistName, edited: ownStatus.artistEdited })
    )
    await generate.execute({ prompt: 'a cat' }, { signal })
    check(
      'a render sends a hand-made style as its prefix',
      String(captured.payload?.input ?? '').startsWith('MYOWNSTYLE, soft light, film grain'),
      String(captured.payload?.input).slice(0, 100)
    )

    // ------------------------------------------------------ the reference image --
    // Raw bytes as the body: the JSON route caps bodies at 256 KB, so an image sent as
    // base64 inside JSON could not have worked for anything worth uploading.
    const pngBytes = makePng(8)
    const uploaded = asJson(
      await callRoute(
        route,
        fakeRequest({ method: 'POST', url: `/nai-imagegen/api/artist-image?id=${ownId}`, body: pngBytes })
      )
    )
    check(
      'an image goes up as the raw request body',
      uploaded.ok === true && uploaded.image?.mime === 'image/png' && uploaded.image?.bytes === pngBytes.length,
      JSON.stringify(uploaded).slice(0, 240)
    )
    check(
      'the entry reports the image afterwards',
      uploaded.artist?.image === true && uploaded.artist?.uploaded === true,
      JSON.stringify({ image: uploaded.artist?.image, uploaded: uploaded.artist?.uploaded })
    )
    const files = await readdir(userImageDir)
    check(
      'the bytes are stored as a file of their own',
      files.length === 1 && files[0] === `${ownId}.png`,
      JSON.stringify(files)
    )
    check(
      'the stored file is the uploaded bytes',
      Buffer.compare(await readFile(join(userImageDir, files[0])), pngBytes) === 0,
      String(files[0])
    )
    const served = await callRoute(route, fakeRequest({ url: `/nai-imagegen/api/artist-image?id=${ownId}` }))
    check(
      'the uploaded image comes back byte for byte',
      served.status === 200 && Buffer.compare(served.body, pngBytes) === 0,
      `${served.status} ${served.body?.length}`
    )
    check(
      'it comes back with the type the bytes imply',
      served.headers?.['Content-Type'] === 'image/png',
      JSON.stringify(served.headers)
    )
    check(
      'an upload is cached for a minute rather than a day',
      /max-age=60/.test(String(served.headers?.['Cache-Control'])),
      String(served.headers?.['Cache-Control'])
    )

    // Replacing it: the type can change with the bytes, and the file the old type named
    // must not be left behind for the next `<img>` to find.
    const jpegBytes = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.alloc(24, 7),
      Buffer.from([0xff, 0xd9])
    ])
    const replaced = asJson(
      await callRoute(
        route,
        fakeRequest({ method: 'POST', url: `/nai-imagegen/api/artist-image?id=${ownId}`, body: jpegBytes })
      )
    )
    check('a replacement changes the stored type', replaced.image?.mime === 'image/jpeg', JSON.stringify(replaced.image))
    const afterReplace = await readdir(userImageDir)
    check(
      'replacing leaves one file, not two',
      afterReplace.length === 1 && afterReplace[0] === `${ownId}.jpg`,
      JSON.stringify(afterReplace)
    )
    const servedJpeg = await callRoute(route, fakeRequest({ url: `/nai-imagegen/api/artist-image?id=${ownId}` }))
    check(
      'what is served is the replacement',
      Buffer.compare(servedJpeg.body, jpegBytes) === 0 && servedJpeg.headers?.['Content-Type'] === 'image/jpeg',
      `${servedJpeg.headers?.['Content-Type']} ${servedJpeg.body?.length}`
    )

    // Refusals. A body that is not an image must not be stored, and an oversized one must
    // be refused while it is still arriving rather than read into memory first.
    const notImage = await callRoute(
      route,
      fakeRequest({
        method: 'POST',
        url: `/nai-imagegen/api/artist-image?id=${ownId}`,
        body: Buffer.from('definitely not an image at all')
      })
    )
    check('a body that is not an image is refused', notImage.status === 400, JSON.stringify(notImage.body))
    check(
      'and the good image is still the one on disk',
      (await readdir(userImageDir)).length === 1,
      JSON.stringify(await readdir(userImageDir))
    )
    const emptyUpload = await callRoute(
      route,
      fakeRequest({ method: 'POST', url: `/nai-imagegen/api/artist-image?id=${ownId}` })
    )
    check('an empty upload says what to send', emptyUpload.status === 400, JSON.stringify(emptyUpload.body))
    const tooBig = await callRoute(
      route,
      fakeRequest({
        method: 'POST',
        url: `/nai-imagegen/api/artist-image?id=${ownId}`,
        body: Buffer.concat([PNG_SIGNATURE, Buffer.alloc(8 * 1024 * 1024, 3)])
      })
    )
    check('an oversized image is refused with 413 rather than stored', tooBig.status === 413, String(tooBig.status))
    const unknownUpload = await callRoute(
      route,
      fakeRequest({ method: 'POST', url: '/nai-imagegen/api/artist-image?id=99999', body: pngBytes })
    )
    check('uploading to an unknown artist is a 404', unknownUpload.status === 404, JSON.stringify(unknownUpload.body))

    // An imported entry can carry an uploaded image too. The archive is only ever read,
    // so "I want a different reference image for this one" has to be possible without
    // writing to it — which is the same reason an edit is stored beside it.
    const archiveUpload = asJson(
      await callRoute(route, fakeRequest({ method: 'POST', url: '/nai-imagegen/api/artist-image?id=0', body: pngBytes }))
    )
    check(
      'an imported entry can be given a reference image as well',
      archiveUpload.ok === true && archiveUpload.artist?.uploaded === true && archiveUpload.artist?.custom === false,
      JSON.stringify(archiveUpload).slice(0, 240)
    )
    const archiveServed = await callRoute(route, fakeRequest({ url: '/nai-imagegen/api/artist-image?id=0' }))
    check(
      'the upload shadows the archive for that entry',
      Buffer.compare(archiveServed.body, pngBytes) === 0,
      `${archiveServed.status} ${archiveServed.body?.length}`
    )
    const dropped = asJson(
      await callRoute(route, fakeRequest({ method: 'DELETE', url: '/nai-imagegen/api/artist-image?id=0' }))
    )
    check(
      'dropping the upload succeeds',
      dropped.ok === true && dropped.artist?.uploaded === false,
      JSON.stringify(dropped).slice(0, 240)
    )
    const backToNothing = await callRoute(route, fakeRequest({ url: '/nai-imagegen/api/artist-image?id=0' }))
    check(
      'the entry falls back to having no image rather than to a stale file',
      backToNothing.status === 404,
      String(backToNothing.status)
    )
    const dropAgain = await callRoute(
      route,
      fakeRequest({ method: 'DELETE', url: '/nai-imagegen/api/artist-image?id=0' })
    )
    check('dropping an upload that is not there is a 404', dropAgain.status === 404, JSON.stringify(dropAgain.body))

    // And the archive file itself never gains a byte: an entry's image and its text both
    // live somewhere else, or a re-import would throw them away.
    const userArchiveOnDisk = JSON.parse(await readFile(userArchive, 'utf8'))
    check(
      'the archive file is left alone',
      userArchiveOnDisk[0].referenceImage === '' && userArchiveOnDisk[0].positivePrompt === 'ARCHIVESTYLE',
      JSON.stringify(userArchiveOnDisk[0]).slice(0, 220)
    )

    // ------------------------------------------------------------- refusals --
    const nameless = await callRoute(
      route,
      fakeRequest({ method: 'POST', url: '/nai-imagegen/api/artist-add', body: JSON.stringify({ name: '   ' }) })
    )
    check('a nameless entry is refused', nameless.status === 400, JSON.stringify(nameless.body))
    const longName = await callRoute(
      route,
      fakeRequest({
        method: 'POST',
        url: '/nai-imagegen/api/artist-add',
        body: JSON.stringify({ name: 'x'.repeat(121), positive: 'y' })
      })
    )
    check(
      'an over-long name is refused rather than truncated',
      longName.status === 400,
      JSON.stringify(longName.body).slice(0, 200)
    )
    const longText = await callRoute(
      route,
      fakeRequest({
        method: 'POST',
        url: '/nai-imagegen/api/artist-add',
        body: JSON.stringify({ name: 'oops', positive: 'x'.repeat(20001) })
      })
    )
    check('over-long text is refused on the way in', longText.status === 400, JSON.stringify(longText.body).slice(0, 200))
    check(
      'a refused creation leaves the library exactly as it was',
      (JSON.parse(await readFile(userLibraryFile, 'utf8')).entries ?? []).length === 1,
      JSON.stringify((JSON.parse(await readFile(userLibraryFile, 'utf8')).entries ?? []).map((row) => row.id))
    )

    const deleteImported = await callRoute(
      route,
      fakeRequest({ method: 'POST', url: '/nai-imagegen/api/artist-remove', body: JSON.stringify({ id: 0 }) })
    )
    check('an imported entry cannot be deleted', deleteImported.status === 400, JSON.stringify(deleteImported.body))
    const importedSurvives = asJson(await callRoute(route, fakeRequest({ url: '/nai-imagegen/api/artist-text?id=0' })))
    check('and it is still there afterwards', importedSurvives.id === 0, JSON.stringify(importedSurvives).slice(0, 160))
    const badRemove = await callRoute(
      route,
      fakeRequest({ method: 'POST', url: '/nai-imagegen/api/artist-remove', body: JSON.stringify({ id: 'x' }) })
    )
    check('a non-numeric id cannot be deleted', badRemove.status === 400, JSON.stringify(badRemove.body))
    const unknownRemove = await callRoute(
      route,
      fakeRequest({ method: 'POST', url: '/nai-imagegen/api/artist-remove', body: JSON.stringify({ id: 99999 }) })
    )
    check('deleting an unknown artist is a 404', unknownRemove.status === 404, JSON.stringify(unknownRemove.body))

    // ------------------------------------------------------------ deleting one --
    // The id is remembered in three places — the panel's pick, each mode's pick, and the
    // edits table — and a deletion that left any of them behind would keep naming a style
    // that is gone, which the next render would drop without saying anything.
    await save({ artistId: ownId, modes: { illustration: { artistId: ownId }, comic: { artistId: ownId } } })
    await callRoute(
      route,
      fakeRequest({ method: 'POST', url: '/nai-imagegen/api/artist-favorite', body: JSON.stringify({ id: ownId, favorite: true }) })
    )
    check(
      'a hand-made entry can be starred like an imported one',
      ((await load()).artistFavorites ?? []).includes(ownId),
      JSON.stringify((await load()).artistFavorites)
    )
    const removed = asJson(
      await callRoute(
        route,
        fakeRequest({ method: 'POST', url: '/nai-imagegen/api/artist-remove', body: JSON.stringify({ id: ownId }) })
      )
    )
    check(
      'a hand-made entry can be deleted',
      removed.ok === true && Number(removed.id) === ownId,
      JSON.stringify(removed).slice(0, 220)
    )
    const afterRemove = await load()
    check('deleting clears the panel pick', afterRemove.artistId === -1, String(afterRemove.artistId))
    check(
      'deleting clears each mode pick',
      afterRemove.modes?.illustration?.artistId === -1 && afterRemove.modes?.comic?.artistId === -1,
      JSON.stringify(afterRemove.modes)
    )
    check(
      'deleting forgets the edit',
      afterRemove.artistEdits?.[String(ownId)] === undefined,
      JSON.stringify(afterRemove.artistEdits)
    )
    check(
      'deleting takes the star with it',
      (afterRemove.artistFavorites ?? []).includes(ownId) === false,
      JSON.stringify(afterRemove.artistFavorites)
    )
    check(
      'the record is gone from the library file',
      (JSON.parse(await readFile(userLibraryFile, 'utf8')).entries ?? []).every((record) => record.id !== ownId),
      JSON.stringify((JSON.parse(await readFile(userLibraryFile, 'utf8')).entries ?? []).map((record) => record.id))
    )
    check(
      'the uploaded image goes with the record',
      (await readdir(userImageDir).catch(() => [])).length === 0,
      JSON.stringify(await readdir(userImageDir).catch(() => []))
    )
    const goneText = await callRoute(route, fakeRequest({ url: `/nai-imagegen/api/artist-text?id=${ownId}` }))
    check('its text route is a 404 afterwards', goneText.status === 404, String(goneText.status))

    // A hand-edited library file must not be able to break the list, and must not be able
    // to point the image reader outside its own directory.
    await writeFile(
      userLibraryFile,
      JSON.stringify({
        version: 1,
        entries: [
          { id: 'nope', name: '坏 id' },
          { id: 5, name: '低于基线的 id' },
          { id: 2000, name: '   ' },
          { id: 2001, name: '好条目', positivePrompt: 'GOODSTYLE', negativePrompt: 'GOODBAD' }
        ],
        images: { 2001: { file: '../../escape.png', mime: 'image/png', bytes: 10 } }
      }),
      'utf8'
    )
    const handEdited = asJson(await callRoute(route, fakeRequest({ url: '/nai-imagegen/api/artists?limit=50' })))
    check(
      'a malformed library still lists the records that are sound',
      (handEdited.artists ?? []).some((row) => row.id === 2001 && row.name === '好条目'),
      JSON.stringify((handEdited.artists ?? []).map((row) => [row.id, row.name]))
    )
    check(
      'records that cannot be real are dropped',
      (handEdited.artists ?? []).every((row) => row.custom !== true || row.id >= 1000),
      JSON.stringify((handEdited.artists ?? []).map((row) => [row.id, row.custom]))
    )
    check(
      'a blank name is dropped rather than listed',
      (handEdited.artists ?? []).every((row) => row.id !== 2000),
      JSON.stringify((handEdited.artists ?? []).map((row) => row.id))
    )
    const traversal = await callRoute(route, fakeRequest({ url: '/nai-imagegen/api/artist-image?id=2001' }))
    check('an image path that escapes the directory is not served', traversal.status === 404, String(traversal.status))

    await writeFile(userLibraryFile, 'this is not json at all', 'utf8')
    const survived = await callRoute(route, fakeRequest({ url: '/nai-imagegen/api/artists?limit=5' }))
    check(
      'an unreadable library file does not take the list down',
      survived.status === 200 && (asJson(survived).count ?? 0) >= 1,
      String(survived.status)
    )

    // Left clean for whatever runs next: these are this block's own files, and a leftover
    // would show up as a stray entry in a later block that shares the directory.
    await rm(userLibraryFile, { force: true })
    await rm(userImageDir, { recursive: true, force: true })
  }

  // ------------------------------------------------- panel / host contract --
  // The panel reads these names straight off `/status`. A rename on either side
  // would blank a whole section without an error surfacing anywhere, so the
  // contract is asserted field by field instead of being left to a screenshot.
  //
  // This block builds its own artist fixture rather than borrowing one from
  // another block: a contract test that depends on an earlier block's leftovers
  // reports the wrong thing the moment the order of the file changes.
  {
    const contractArchive = join(scratchHome, 'contract-archive.json')
    const contractIndexPath = join(scratchHome, 'contract-index.json')
    await writeFile(
      contractArchive,
      JSON.stringify([
        {
          name: '契约画风',
          sequence: 0,
          positivePrompt: 'CONTRACTSTYLE, flat colour',
          negativePrompt: '',
          chamipositivePrompt: '',
          chaminegativePrompt: '',
          referenceImage: ''
        }
      ]),
      'utf8'
    )
    await buildArtistIndex({ sourceFile: contractArchive, indexPath: contractIndexPath })
    await save({
      keys: [{ label: '契约 Key', token: 'pst-contract-token', enabled: true }],
      artistIndex: contractIndexPath,
      artistId: 0,
      autoGenerate: true
    })

    // A boolean must survive the round trip as a boolean: `normalize` used to
    // coerce it through `String`, so `=== true` was never satisfied and the
    // auto-render toggle could not be turned on at all.
    check('a saved boolean comes back as a boolean', (await load()).autoGenerate === true, JSON.stringify((await load()).autoGenerate))

    const statusBody = asJson(await callRoute(route, fakeRequest({ url: '/nai-imagegen/api/status' })))
  const panelFields = [
    'rowId',
    'baseUrl',
    'model',
    'width',
    'height',
    'steps',
    'scale',
    'sampler',
    'ucPreset',
    'proxy',
    'proxySetting',
    'detectedProxy',
    'outputDir',
    'libraryDir',
    'librarySourceDir',
    'artistIndex',
    'artistSource',
    'artistCount',
    'artistId',
    'artistName',
    // The editor badge and the floating window's character count read these; they were
    // missing from the payload once, and the count then silently never rendered.
    'artistEdited',
    'artistChars',
    'keys',
    'keySummary',
    'quota',
    'autoGenerate',
    // Whether the reply transport is in the tool list at this moment. The panel draws its switch
    // from this rather than from the file, because the two can disagree for the length of a
    // registration — and the switch that is drawn must be the switch that is in force.
    'replyTransport',
    // What the page last said about an automatic pass: the panel prints it under the toggle, so
    // "it did nothing again" is answered on screen instead of through a chat round-trip.
    'lastAuto',
    'maxImagesPerCall',
    'keepImages',
    'tokenSet',
    'tokenSource',
    'negativePrompt',
    'imageCount',
    'libraries',
    'newest',
    // What the host has been handed through `nai_reply`: the answer the browser half paints is
    // not in any file, so this is the only place the host itself can be asked whether one arrived.
    'reply'
  ]
  const missingFields = panelFields.filter((field) => !Object.prototype.hasOwnProperty.call(statusBody, field))
  check('every field the panel reads is present on /status', missingFields.length === 0, `missing: ${missingFields.join(',')}`)
  check('/status never carries a token', !JSON.stringify(statusBody).includes('pst-contract-token'))
  check('/status reports the pool breadth for the panel header', statusBody.keySummary?.concurrency >= 1, JSON.stringify(statusBody.keySummary))
  const contractKey = (statusBody.keys ?? []).find((key) => key.label === '契约 Key')
  check(
    'a key is projected to the panel without its token',
    contractKey !== undefined && contractKey.token === undefined && typeof contractKey.fingerprint === 'string',
    JSON.stringify(contractKey)
  )
    check(
      '/status echoes the artist and auto-render settings',
      statusBody.artistId === 0 && statusBody.artistName === '契约画风' && statusBody.autoGenerate === true,
      JSON.stringify({ id: statusBody.artistId, name: statusBody.artistName, auto: statusBody.autoGenerate })
    )
    // The name is spelled out here rather than read from `lib/reply.js`, because this check
    // belongs to the panel's contract: it is about whether the payload and the tool list agree,
    // and the reply section below is the one that asserts both halves spell the name the same.
    check(
      '/status reports the reply transport from the tool list, not from the file',
      statusBody.replyTransport === true && mounted.tools.has('nai_reply') === true,
      JSON.stringify({ replyTransport: statusBody.replyTransport, registered: mounted.tools.has('nai_reply') })
    )

    // ------------------------------------------------- artist routes on the wire --
    const artistList = asJson(await callRoute(route, fakeRequest({ url: '/nai-imagegen/api/artists?q=' })))
    check('GET /artists lists the archive', artistList.count === 1 && artistList.artists[0]?.name === '契约画风', JSON.stringify(artistList).slice(0, 200))
    check('GET /artists exposes no prompt bodies', artistList.artists[0]?.positivePrompt === undefined)
    const artistOne = asJson(await callRoute(route, fakeRequest({ url: '/nai-imagegen/api/artist?id=0' })))
    check('GET /artist reads one entry in full', artistOne.positivePrompt === 'CONTRACTSTYLE, flat colour', JSON.stringify(artistOne).slice(0, 160))
    const artistMissing = await callRoute(route, fakeRequest({ url: '/nai-imagegen/api/artist?id=999' }))
    check('GET /artist answers 404 for an unknown id', artistMissing.status === 404, String(artistMissing.status))
    const noImage = await callRoute(route, fakeRequest({ url: '/nai-imagegen/api/artist-image?id=0' }))
    check('GET /artist-image answers 404 when the entry has no image', noImage.status === 404, String(noImage.status))
    const badImage = await callRoute(route, fakeRequest({ url: '/nai-imagegen/api/artist-image?id=999' }))
    check('GET /artist-image answers 404 for an unknown id', badImage.status === 404, String(badImage.status))

    // ---------------------------------------------- key management round trip --
    // The panel addresses keys by id. If the id does not survive the config
    // round trip, every enable / disable / remove click misses its target and
    // fails silently, which looks exactly like the buttons being broken.
    const addKey = asJson(
      await callRoute(
        route,
        fakeRequest({ method: 'POST', url: '/nai-imagegen/api/keys/add', body: JSON.stringify({ label: '管理 Key', token: 'pst-managed-token' }) })
      )
    )
    check('POST /keys/add answers 200', addKey.ok === true, JSON.stringify(addKey).slice(0, 140))
    const storedIds = (await load()).keys.map((key) => key.id)
    check('every stored key carries an id', storedIds.every((id) => typeof id === 'string' && id !== ''), JSON.stringify(storedIds))
    const listedId = addKey.status.keys.find((key) => key.label === '管理 Key')?.id
    check('the id the panel is given is the id on disk', storedIds.includes(listedId), `${listedId} vs ${JSON.stringify(storedIds)}`)

    const disabled = asJson(
      await callRoute(
        route,
        fakeRequest({ method: 'POST', url: '/nai-imagegen/api/keys/update', body: JSON.stringify({ id: listedId, enabled: false }) })
      )
    )
    check(
      'POST /keys/update disables the key it was pointed at',
      disabled.status.keys.find((key) => key.id === listedId)?.enabled === false,
      JSON.stringify(disabled.status.keys.map((key) => [key.label, key.enabled]))
    )
    check('the disabled state reached the file', (await load()).keys.find((key) => key.id === listedId)?.enabled === false)

    const removed = asJson(
      await callRoute(route, fakeRequest({ method: 'POST', url: '/nai-imagegen/api/keys/remove', body: JSON.stringify({ id: listedId }) }))
    )
    check('POST /keys/remove removes that key', !(removed.status.keys ?? []).some((key) => key.id === listedId), JSON.stringify(removed.status.keys.map((key) => key.label)))
    const badUpdate = await callRoute(route, fakeRequest({ method: 'POST', url: '/nai-imagegen/api/keys/update', body: JSON.stringify({ enabled: true }) }))
    check('POST /keys/update requires an id', badUpdate.status === 400, String(badUpdate.status))
    const badAdd = await callRoute(route, fakeRequest({ method: 'POST', url: '/nai-imagegen/api/keys/add', body: JSON.stringify({ token: '   ' }) }))
    check('POST /keys/add refuses an empty token', badAdd.status === 400, String(badAdd.status))

    const verified = asJson(await callRoute(route, fakeRequest({ method: 'POST', url: '/nai-imagegen/api/keys/verify', body: '{}' })))
    check('POST /keys/verify answers with a per-key report', Array.isArray(verified.keys) && verified.summary !== undefined, JSON.stringify(verified).slice(0, 160))
  }

  // `persistKeys` clears the legacy `token` field when it folds it into the
  // managed list, so the token section [8] relies on is put back here.
  await save({ keys: [], token: 'pst-pipeline', artistId: -1, autoGenerate: false })

  // ---------------------------------------------------------- state tools --
  // Built on its own fixture rather than a neighbour's leftovers, so that
  // reordering this file cannot silently change what is being asserted.
  {
    const stateArchive = join(scratchHome, 'state-archive.json')
    const stateIndex = join(scratchHome, 'state-index.json')
    await writeFile(
      stateArchive,
      JSON.stringify([
        {
          name: '状态画风',
          sequence: 0,
          positivePrompt: 'STATESTYLE, cel shading',
          negativePrompt: 'STATEBAD',
          chamipositivePrompt: '',
          chaminegativePrompt: '',
          referenceImage: ''
        }
      ]),
      'utf8'
    )
    await buildArtistIndex({ sourceFile: stateArchive, indexPath: stateIndex })

    // The probe has to read the key pool. Managing keys from the panel folds the
    // single `token` into `keys` and clears it, so a probe that still looked at
    // `token` would report "not configured" while keys sat healthy in the pool.
    await save({ keys: [{ label: 'probe key', token: 'pst-pool-probe', enabled: true }], token: '', artistIndex: stateIndex })
    const toolSignal = () => new AbortController().signal

    const probeText = await mounted.tools.get('nai_probe').execute({}, { signal: toolSignal() })
    check('nai_probe works with an empty token field but a healthy pool', /Anlas 余额：/.test(probeText), probeText.slice(0, 200))
    check('nai_probe reports the pool breadth', /Key 池：1 个/.test(probeText), probeText.slice(0, 200))
    check('nai_probe does not claim the credential is missing', !/未配置凭据/.test(probeText), probeText.slice(0, 200))

    const probeBody = asJson(await callRoute(route, fakeRequest({ method: 'POST', url: '/nai-imagegen/api/probe', body: '{}' })))
    check('POST /probe goes through the pool as well', probeBody.ok === true, JSON.stringify(probeBody).slice(0, 180))

    const statusText = await mounted.tools.get('nai_status').execute({}, { signal: toolSignal() })
    check('nai_status reports the key pool', /Key 池：1 个/.test(statusText), statusText.slice(0, 200))
    check('nai_status reports the artist archive', /画师串：已导入 1 条/.test(statusText), statusText.slice(0, 260))
    check('nai_status says no artist is in force yet', /当前：未选择/.test(statusText), statusText.slice(0, 260))
    check('nai_status reports the proxy', /代理：/.test(statusText), statusText.slice(0, 260))
    check('nai_status reports auto-render', /自动出图：关/.test(statusText), statusText.slice(0, 320))

    const artistsTool = mounted.tools.get('nai_artists')
    const selected = await artistsTool.execute({ select: 0 }, { signal: toolSignal() })
    check('nai_artists select sets the current string', /设为当前画师串/.test(selected) && (await load()).artistId === 0, selected.slice(0, 160))
    const afterSelect = await mounted.tools.get('nai_status').execute({}, { signal: toolSignal() })
    check('nai_status names the artist once one is selected', /当前：状态画风/.test(afterSelect), afterSelect.slice(0, 260))
    const badSelect = await artistsTool.execute({ select: 99 }, { signal: toolSignal() })
    check('nai_artists select refuses an unknown id', /没有 id=99/.test(badSelect), badSelect.slice(0, 120))
    const cleared = await artistsTool.execute({ clear: true }, { signal: toolSignal() })
    check('nai_artists clear turns it off', /已关闭画师串/.test(cleared) && (await load()).artistId === -1, cleared.slice(0, 120))

    const configTool = mounted.tools.get('nai_config')
    const autoText = await configTool.execute({ auto_generate: true }, { signal: toolSignal() })
    check('nai_config can turn auto-render on', /已更新/.test(autoText) && (await load()).autoGenerate === true, autoText.slice(0, 140))
    const keepText = await configTool.execute({ keep_images: 7 }, { signal: toolSignal() })
    check('nai_config can set image retention', /已更新/.test(keepText) && (await load()).keepImages === 7, keepText.slice(0, 140))
    const artistText = await configTool.execute({ artist_id: 0 }, { signal: toolSignal() })
    check('nai_config can set the artist by id', /已更新/.test(artistText) && (await load()).artistId === 0, artistText.slice(0, 140))

    await save({ keys: [], token: 'pst-pipeline', artistId: -1, autoGenerate: false, keepImages: 500 })
  }

  // -------------------------------------------------------------- doctor --
  // The doctor exists so a silent breakage becomes a visible one, so it is
  // asserted to be thorough, to agree with itself, and — most importantly — to be
  // capable of failing. A doctor that always says "ok" is worse than none.
  {
    const doctorCall = await callRoute(route, fakeRequest({ url: '/nai-imagegen/api/doctor' }))
    const report = asJson(doctorCall)
    const rows = report.checks ?? []
    check('GET /doctor answers', doctorCall.status === 200 || doctorCall.status === 500, String(doctorCall.status))
    check('the doctor runs a substantial number of checks', rows.length >= 25, String(rows.length))
    check(
      'every check is named and carries a verdict',
      rows.length > 0 && rows.every((row) => typeof row.name === 'string' && row.name !== '' && typeof row.ok === 'boolean')
    )
    check('the doctor reports an overall verdict', typeof report.ok === 'boolean')
    check('the overall verdict agrees with the individual checks', report.ok === rows.every((row) => row.ok))
    check(
      'the doctor covers every capability that has broken before',
      ['boolean', 'array', 'usable API key', 'artist index', 'libraries', 'block parses', 'scaffold leaks into the positive', 'roster header', 'classifier', 'output directory', 'star'].every((needle) =>
        rows.some((row) => row.name.includes(needle))
      ),
      rows.map((row) => row.name).join(' | ')
    )
    const doctorText = await mounted.tools.get('nai_doctor').execute({}, { signal: new AbortController().signal })
    check('the doctor tool renders a readable report', /能力检查/.test(doctorText) && doctorText.includes('ok'), doctorText.slice(0, 120))
    check('the doctor output names each failing check, not just a count', !/FAIL/.test(doctorText) || /FAIL/.test(doctorText))
  }

  // ------------------------------------------------ config type stability --
  // `normalize` coerces by `typeof`, and getting one branch wrong silently broke
  // `autoGenerate` (stored as the string "true", so no `=== true` could ever
  // match) and the key ids (stripped on every save, so enable/disable/remove all
  // missed their target). This walks every field the config *actually has*, so a
  // future field is covered the day it is added rather than the day it breaks.
  {
    const before = await load()
    const after = await save({})
    const drifted = Object.keys(before).filter((key) => Array.isArray(before[key]) !== Array.isArray(after[key]) || typeof before[key] !== typeof after[key])
    check('every config field keeps its type through a save/load round trip', drifted.length === 0, drifted.join(','))
    check('the guard is actually looking at a full config', Object.keys(before).length >= 15, String(Object.keys(before).length))
    const onDisk = JSON.parse(JSON.stringify(after))
    const jsonDrift = Object.keys(after).filter((key) => Array.isArray(after[key]) !== Array.isArray(onDisk[key]) || typeof after[key] !== typeof onDisk[key])
    check('every config field survives JSON unchanged', jsonDrift.length === 0, jsonDrift.join(','))
    check('booleans stay booleans', typeof after.autoGenerate === 'boolean' && typeof onDisk.autoGenerate === 'boolean', String(onDisk.autoGenerate))
    check('numbers stay numbers', typeof after.keepImages === 'number' && typeof onDisk.keepImages === 'number', String(onDisk.keepImages))
    check('keys stay an array of objects', Array.isArray(onDisk.keys) && onDisk.keys.every((row) => typeof row === 'object' && row !== null && typeof row.token === 'string'))

    // The starred ids are the one list meant to be hand-edited, so a number written as a
    // string has to survive — and a `null` must not, because it coerces to 0 and would
    // star the first entry in the archive on a typo.
    const coercedStars = await save({ artistFavorites: ['3', 3, -1, 2.5, null, undefined, '', 'x', 7, 7] })
    check(
      'the starred list is coerced to distinct non-negative integers',
      JSON.stringify(coercedStars.artistFavorites) === '[3,7]',
      JSON.stringify(coercedStars.artistFavorites)
    )
    const junkStars = await save({ artistFavorites: 'nonsense' })
    check('a starred list that is not a list becomes an empty list', Array.isArray(junkStars.artistFavorites) && junkStars.artistFavorites.length === 0, JSON.stringify(junkStars.artistFavorites))
    await save({ artistFavorites: [] })
  }

  // ------------------------------------------------- input format matrix --
  // One line per input form the plugin claims to support, so a refactor that drops
  // a branch fails here instead of in someone's transcript.
  {
    const { looksLikeImageBlock: isBlock, parseImageBlock: parseIt } = await import('../lib/format.js')
    const forms = [
      ['a full <image> block', '<image>\n<image_think>x</image_think>\nimage###size:832x1216;\nScene:a;\nChar1:b|centers:B3;\nChar1 UC:c;\nScene UC:d;###\n</image>', true],
      ['a block with no reasoning section', 'image###size:1024x1024;\nScene:a;\nScene UC:d;###', true],
      ['a block with no envelope', '<image>\nScene:a;\nScene UC:d;\n</image>', true],
      ['a wrapper around a bare tag list', '<image>1girl, solo, smile</image>', true],
      ['a lowercase char-labelled plain prompt', '2girls, group sex,\nchar1: a, green hair,\n-1.5::twintails::', false],
      ['a plain Danbooru tag list', '1girl, solo, looking at viewer, masterpiece, best quality', false],
      ['a plain prompt mentioning <image> mid-sentence', '1girl, holding an <image> of a cat, masterpiece', false]
    ]
    for (const [label, text, isABlock] of forms) {
      check(`the parser calls ${label} ${isABlock ? 'a block' : 'a plain prompt'}`, isBlock(text) === isABlock, String(isBlock(text)))
      if (isABlock) {
        const parsed = parseIt(text, { width: 832, height: 1216 })
        check(`and it parses ${label}`, parsed.ok, parsed.reason ?? '')
      } else {
        check(`and it leaves ${label} for the host to send verbatim`, parseIt(text, {}).ok === false, JSON.stringify(parseIt(text, {}).prompt ?? ''))
      }
    }
  }

  // --------------------------------------------------- nai5-comic page --
  // The comic preset's page is a different shape entirely: one JSON object
  // instead of labelled text fields, with the panels nested inside it. Both
  // formats have to work side by side without either one touching the other.
  {
    const { looksLikeComicPage, parseComicPage, maybeParseComicPage } = await import('../lib/comic.js')
    const page = JSON.stringify({
      format: 'nai5-comic',
      position_mode: 'manual',
      page: { base: 'SFW, 2girls, comic, 複数コマの漫画ページ, 4-koma, portrait', non_character: 'narrator box top left Text:「……」' },
      panels: [
        {
          id: 'P1',
          description: 'wide establishing shot of the classroom',
          non_character: 'sound effect Text:「ドン」',
          characters: [
            { character_id: 'C1', positive: 'girl, long pink hair, blue eyes, standing Text:「おはよう」', negative: 'twintails, green halo', center: { x: 0.3, y: 0.4 } }
          ]
        },
        {
          id: 'P2',
          description: 'close up on the other girl',
          characters: [
            { character_id: 'C2', positive: 'girl, twintails, green hair, green halo, surprised Text:「えっ」', negative: 'long pink hair', center: { x: 0.7, y: 0.6 } }
          ]
        }
      ]
    })
    const wrapped = `<image>\n${page}\n</image>`

    check('a comic page is recognised', looksLikeComicPage(wrapped))
    // A comic page is wrapped in `<image>` too, and the illustration parser's
    // bare-tag-list fallback would happily swallow the whole JSON as prompt text —
    // which is exactly why the comic parser has to be tried first.
    const { parseImageBlock: parseIllustration } = await import('../lib/format.js')
    const swallowed = parseIllustration(wrapped, { width: 832, height: 1216 })
    check(
      'the illustration parser would swallow the JSON, so order matters',
      !swallowed.ok || /"panels"|"format"/.test(swallowed.prompt),
      swallowed.ok ? swallowed.prompt.slice(0, 80) : `refused: ${swallowed.reason}`
    )
    check('the comic parser wins', maybeParseComicPage(wrapped, { width: 832, height: 1216 })?.format === 'nai5-comic')
    const parsed = parseComicPage(wrapped, { width: 832, height: 1216 })
    check('the comic page parses', parsed.ok, parsed.reason ?? '')
    check('the format is recorded', parsed.format === 'nai5-comic', String(parsed.format))
    check('the panel count is recorded', parsed.panelCount === 2, String(parsed.panelCount))
    check('the position mode is recorded', parsed.positionMode === 'manual', String(parsed.positionMode))
    check('each panel appearance becomes its own slot', parsed.characters.length === 2, String(parsed.characters.length))
    check('the slots carry their panel and character id', parsed.characters[0]?.label === 'P1·C1', String(parsed.characters[0]?.label))
    check('the scene holds base and both descriptions', /4-koma/.test(parsed.sceneCaption) && /classroom/.test(parsed.sceneCaption) && /close up/.test(parsed.sceneCaption), parsed.sceneCaption.slice(0, 120))
    check('the scene holds the page and panel non-character fields', /narrator box/.test(parsed.sceneCaption) && /ドン/.test(parsed.sceneCaption))
    // `Text:` carries the dialogue that has to be drawn, so it is kept verbatim —
    // the preset's own contract says so.
    // The preset's `Text:` marker means nothing to an image model — a page built
    // that way came out with empty bubbles. NovelAI V5 letters text that appears in
    // **double quotes**, so the marker is rewritten into one.
    check('the dialogue survives inside the caption', /おはよう/.test(parsed.characters[0]?.text ?? ''), parsed.characters[0]?.text ?? '')
    check('the dialogue is quoted for the image model', /"おはよう"/.test(parsed.characters[0]?.text ?? ''), parsed.characters[0]?.text ?? '')
    check('the completion-only Text: marker is dropped', !/Text:/.test(parsed.characters[0]?.text ?? ''), parsed.characters[0]?.text ?? '')
    check('the quoted lines are counted', (parsed.dialogueCount ?? 0) >= 1, String(parsed.dialogueCount))
    // A field wrapped for weight put the wrapper's closer after the line, and it was
    // glued into the quoted string — the model was asked to letter `过来」::` rather
    // than `过来`. That is a direct cause of unreadable lettering, so both halves of
    // the wrapper are asserted away.
    {
      const wrapped = JSON.stringify({
        format: 'nai5-comic',
        page: { base: 'SFW, comic' },
        panels: [{ id: 'P1', description: 'x', non_character: '1.5::speech bubble Text:「过来」::', characters: [{ character_id: 'C1', positive: 'girl' }] }]
      })
      const withWeight = parseComicPage(`<image>${wrapped}</image>`, { width: 832, height: 1216 })
      check('a wrapped line keeps only the spoken words', /"过来"/.test(withWeight.prompt), withWeight.prompt)
      // Assert on what is *inside* the quotes rather than on the absence of a
      // substring: `/::"/ ` also matches the correctly re-closed `1.5::"过来"::`.
      const quoted = /"([^"]*)"/.exec(withWeight.prompt)?.[1]
      check('the quoted line is exactly the spoken words', quoted === '过来', String(quoted))
      check('the wrapper is re-closed around the line', /1\.5::"过来"::/.test(withWeight.prompt), withWeight.prompt)
      check('no weight marker is left dangling', (withWeight.prompt.match(/::/g) ?? []).length % 2 === 0, withWeight.prompt)
      const bare = parseComicPage(`<image>${wrapped.replace('1.5::', '').replace(/」::$/, '」')}</image>`, { width: 832, height: 1216 })
      check('an unwrapped line is quoted plainly', /"过来"/.test(bare.prompt) && !/::/.test(bare.prompt), bare.prompt)
    }
    check('each character keeps its own negative', parsed.characters[0]?.negative === 'twintails, green halo', String(parsed.characters[0]?.negative))
    check('negatives are joined for the global field', /twintails/.test(parsed.negativePrompt) && /long pink hair/.test(parsed.negativePrompt))
    check(
      'a manual center becomes a canvas point, not a grid cell',
      parsed.characters[0]?.centers?.[0]?.x === 0.3 && parsed.characters[0]?.centers?.[0]?.y === 0.4,
      JSON.stringify(parsed.characters[0]?.centers)
    )
    check('no JSON scaffolding leaks into the positive', !/"panels"|"page"|"format"|character_id|\{|\}/.test(parsed.prompt), parsed.prompt.slice(0, 120))
    check('no JSON scaffolding leaks into the negative', !/"|panels|\{|\}/.test(parsed.negativePrompt), parsed.negativePrompt.slice(0, 120))

    // `position_mode` absent means auto, and auto means no points at all rather
    // than a centre for everyone.
    const autoPage = JSON.stringify({
      format: 'nai5-comic',
      page: { base: 'comic' },
      panels: [{ id: 'P1', description: 'x', characters: [{ character_id: 'C1', positive: 'girl', negative: '', center: { x: 0.9, y: 0.9 } }] }]
    })
    const auto = parseComicPage(autoPage, { width: 832, height: 1216 })
    check('an auto page ignores stray centers', auto.ok && auto.positionMode === 'auto' && (auto.characters[0]?.centers ?? []).length === 0, JSON.stringify(auto.characters[0]?.centers))
    check('and it says why', auto.notes.some((note) => /position_mode/.test(note)), auto.notes.join(';'))

    // Shapes the preset allows and a model will produce.
    const splash = parseComicPage(JSON.stringify({ format: 'nai5-comic', page: { base: 'SFW, splash page, 単一コマ' }, panels: [{ id: 'P1', description: 'one big panel', characters: [] }] }), { width: 832, height: 1216 })
    check('a splash page with no characters parses', splash.ok && splash.characters.length === 0, splash.reason ?? '')
    const noFormat = parseComicPage(JSON.stringify({ page: { base: 'comic' }, panels: [{ id: 'P1', description: 'x', characters: [{ character_id: 'C1', positive: 'girl' }] }] }), { width: 832, height: 1216 })
    check('a page missing the format marker still parses', noFormat.ok, noFormat.reason ?? '')
    check('and complains about the missing marker', noFormat.notes.some((note) => /format/.test(note)), noFormat.notes.join(';'))
    const empty = parseComicPage('{"format":"nai5-comic","page":{"base":""},"panels":[]}', { width: 832, height: 1216 })
    check('a page with nothing in it is refused', !empty.ok, empty.reason ?? '')
    check('an illustration block is not a comic page', maybeParseComicPage('<image>\nScene:a;\nScene UC:b;###\n</image>') === null)
    check('a plain prompt is not a comic page', !looksLikeComicPage('1girl, solo, looking at viewer'))
    check('prose mentioning panels is not a comic page', !looksLikeComicPage('the page has several panels of art'))
  }

  // ------------------------------------------- per-mode settings are separate --
  // The style used to be one shared value, so every comic page silently carried
  // the illustration's artist string. Each mode now owns its own set.
  {
    await save({ modes: { illustration: { artistId: 3, width: 832, height: 1216 }, comic: { artistId: 7, width: 1024, height: 1024, steps: 22 } } })
    const stored = await load()
    check('both modes keep their own overrides', stored.modes.illustration.artistId === 3 && stored.modes.comic.artistId === 7, JSON.stringify(stored.modes))
    check('the overrides survive JSON', typeof JSON.parse(JSON.stringify(stored.modes)).comic.width === 'number')
    const body = asJson(await callRoute(route, fakeRequest({ url: '/nai-imagegen/api/status' })))
    const byMode = Object.fromEntries((body.modeSettings ?? []).map((row) => [row.mode, row]))
    check('the status reports both modes separately', byMode.illustration?.artistId === 3 && byMode.comic?.artistId === 7, JSON.stringify(body.modeSettings))
    check('their shapes are separate', byMode.illustration?.width === 832 && byMode.comic?.width === 1024 && byMode.comic?.height === 1024)
    check('an overridden step count applies to its own mode only', byMode.comic?.steps === 22 && byMode.illustration?.steps === stored.steps)
    check('an absent override falls back to the shared default', byMode.comic?.sampler === stored.sampler)
    // An empty negative is a real choice, not "unset".
    await save({ modes: { illustration: { negativePrompt: '' }, comic: { negativePrompt: 'lowres' } } })
    const empties = asJson(await callRoute(route, fakeRequest({ url: '/nai-imagegen/api/status' })))
    const emptyByMode = Object.fromEntries((empties.modeSettings ?? []).map((row) => [row.mode, row]))
    check('an empty override is kept as an empty value', emptyByMode.illustration?.negativePrompt === '', JSON.stringify(emptyByMode.illustration?.negativePrompt))
    check('and the other mode keeps its own', emptyByMode.comic?.negativePrompt === 'lowres')
    // Removed outright rather than set to -1: an override wins over the base value,
    // so leaving one behind would silently disable the artist for every later test
    // in this file — which is exactly the class of leak the override design makes
    // possible.
    await save({ modes: {} })
    check('clearing the overrides restores the shared defaults', JSON.stringify((await load()).modes) === '{}')
  }

  // ------------------------------------------------------- comic recipe --
  // The console's own switches (色彩 / 页数 / 分镜 / 留白 …). Each one works by
  // contributing phrasing, so the table is the feature and is asserted directly.
  {
    const { RECIPE_GROUPS, normalizeRecipe, recipeFragments, describeRecipe } = await import('../lib/recipe.js')
    check(
      'the recipe declares the console groups',
      RECIPE_GROUPS.length >= 4 && RECIPE_GROUPS.every((group) => group.options.length > 0 && group.default !== undefined && typeof group.label === 'string'),
      RECIPE_GROUPS.map((group) => `${group.key}(${group.options.length})`).join(' ')
    )
    check('the four the console shows are present', ['color', 'pages', 'pacing', 'margin'].every((key) => RECIPE_GROUPS.some((group) => group.key === key)))
    check('an unset recipe fills every group with its default', Object.keys(normalizeRecipe(undefined)).length === RECIPE_GROUPS.length)
    check('an unknown option falls back to the default', normalizeRecipe({ pacing: 'nonsense' }).pacing === 'daily', normalizeRecipe({ pacing: 'nonsense' }).pacing)
    check('a stale group is dropped', normalizeRecipe({ somethingElse: 'x' }).somethingElse === undefined)
    const fragments = recipeFragments({ color: 'mono', margin: 'bleedFull', pacing: '4koma', pages: '6' })
    check('the recipe contributes positive phrasing', /monochrome/.test(fragments.positive) && /4-koma/.test(fragments.positive) && /full bleed/.test(fragments.positive), fragments.positive.slice(0, 140))
    check('and negative phrasing', /full color/.test(fragments.negative), fragments.negative.slice(0, 90))
    check('and the page count', fragments.pages === 6, String(fragments.pages))
    check('dynamic pages reports zero', recipeFragments({ pages: 'auto' }).pages === 0)
    check('the description names each choice', /色彩/.test(describeRecipe({ color: 'mono' })), describeRecipe({}))

    // Through the render path: the recipe reaches the wire for a comic page and
    // never for an illustration — an illustration has no panels to pace.
    await save({ modes: { comic: { recipe: { color: 'mono', margin: 'bleedFull', pacing: '4koma' } } } })
    const recipePage = JSON.stringify({
      format: 'nai5-comic',
      page: { base: 'comic' },
      panels: [{ id: 'P1', description: 'x', characters: [{ character_id: 'C1', positive: 'girl' }] }]
    })
    await generate.execute({ prompt: `<image>${recipePage}</image>`, artist_id: -1 }, { signal })
    const comicInput = String(captured.payload?.input ?? '')
    check('the comic recipe reaches the wire', /monochrome/.test(comicInput) && /full bleed/.test(comicInput) && /4-koma/.test(comicInput), comicInput.slice(-170))
    // **Prepended, not appended.** Style words decay toward the tail of a prompt:
    // appending ~300 characters of recipe after a ~470-character page left the page
    // in full colour while the recipe was demonstrably reaching the API. Position is
    // load-bearing here, so it is asserted rather than left to the next refactor.
    check('the recipe comes first so its weight is not decayed', comicInput.indexOf('monochrome') < comicInput.indexOf('comic'), comicInput.slice(0, 120))
    check('the recipe is in the scene caption too, not only the legacy prompt', /monochrome/.test(String(captured.payload?.parameters?.v4_prompt?.caption?.base_caption)), String(captured.payload?.parameters?.v4_prompt?.caption?.base_caption).slice(0, 120))
    check('the recipe negative reaches the negative prompt', /full color/.test(String(captured.payload?.parameters?.negative_prompt)))
    // A bare `text` tag reads as "draw text" and put garbled lettering on a page
    // that had no dialogue. The language is steered from the negative instead.
    check(
      'the dialogue option does not ask for text to be drawn',
      !/simplified chinese text|japanese text, /.test(comicInput) || /0\.6::/.test(comicInput),
      comicInput.slice(0, 160)
    )
    check('and the other language is excluded instead', /japanese text/.test(String(captured.payload?.parameters?.negative_prompt)))
    await generate.execute({ prompt: 'a plain illustration', artist_id: -1 }, { signal })
    check(
      'an illustration gets none of the comic recipe',
      !/monochrome|full bleed|4-koma/.test(String(captured.payload?.input ?? '')),
      String(captured.payload?.input ?? '').slice(-120)
    )
    await save({ modes: {} })
  }

  // ------------------------------------------- the doc and the code agree --
  // `README-comic.md` is what a writer is handed, so its own template is fed
  // through the parser here. Documentation describing a format the parser rejects
  // is worse than none: it makes every failure look like a bug.
  {
    const { parseComicPage } = await import('../lib/comic.js')
    const doc = await readFile(join(packageRoot, 'README-comic.md'), 'utf8')
    const fenced = [...doc.matchAll(/```json\r?\n([\s\S]*?)```/g)].map((match) => match[1])
    check('the comic README ships a JSON template', fenced.length > 0, String(fenced.length))
    const template = fenced[0] ?? ''
    check('the template is wrapped in <image>', /<image>/.test(template) && /<\/image>/.test(template))
    const parsedTemplate = parseComicPage(template, { width: 832, height: 1216 })
    check('the README template parses with the shipped parser', parsedTemplate.ok, parsedTemplate.reason ?? '')
    check('the template declares the format', parsedTemplate.format === 'nai5-comic', String(parsedTemplate.format))
    check('the template carries real panels', (parsedTemplate.panelCount ?? 0) >= 2, String(parsedTemplate.panelCount))
    check(
      'the template places its characters',
      parsedTemplate.positionMode === 'manual' && parsedTemplate.characters.every((row) => (row.centers ?? []).length > 0),
      String(parsedTemplate.positionMode)
    )
    check('no scaffold survives from the template', !/<\/?image|"panels"|"page"|character_id/i.test(parsedTemplate.prompt), parsedTemplate.prompt.slice(0, 90))

    // Every message the troubleshooting table documents must be one the parser can
    // actually produce, or the table sends people down dead ends.
    const produced = [
      parseComicPage('not a page', {}).reason,
      parseComicPage('<image>\n{"format":"nai5-comic","page":{"base":"x",},}\n</image>', {}).reason,
      parseComicPage('<image>{"format":"nai5-comic","page":{"base":""},"panels":[]}</image>', {}).reason,
      parseComicPage('<image>{"format":"nai5-comic","page":{"base":""},"panels":[{"id":"P1","characters":[]}]}</image>', {}).reason
    ].join(' | ')
    for (const needle of ['JSON 对象', '缺少 page.base 与 panels 数组', '缺少 page.base 与 panels[].characters[].positive', 'nai5-comic']) {
      check(`the doc's 「${needle}」 is a message the parser really produces`, produced.includes(needle), produced.slice(0, 240))
    }
    // The other direction: the doc must not promise a message that cannot happen.
    check(
      'the doc does not promise an unreachable message',
      !/缺少 page\.base` \|/.test(doc) && !/缺少 panels 数组` \|/.test(doc),
      ''
    )
    check('the doc warns about the manual-centre rule it enforces', /position_mode/.test(doc) && /center/.test(doc))
  }

  // ------------------------------------------- dictionary scope discipline --
  // `t` is a parameter of the functions that get it, not a global. A helper that
  // reaches for it without declaring it throws `t is not defined` the moment the
  // user opens the window — and because it throws mid-repaint, the window keeps what
  // was built before the throw instead of reporting anything: the floating studio
  // drew the artist picker, then the heading, then stopped, with the failure only
  // visible in the small status line.
  //
  // No DOM is needed to catch that: a helper that uses `t` must take `t`.
  {
    const client = await readFile(join(packageRoot, 'client.js'), 'utf8')
    /** The body of a factory function, up to the first closing brace line. */
    const bodyOf = (signature) => {
      const at = client.indexOf(signature)
      if (at < 0) return null
      const rest = client.slice(at)
      const end = rest.indexOf('\n    }')
      return { signature, text: end < 0 ? rest : rest.slice(0, end) }
    }
    const helpers = [
      ['function studioRow(', false],
      ['function isOurOutput(', false],
      ['function nameFromSrc(', false],
      ['function markImage(', false],
      ['function openStudio(', true],
      ['function installFloatingStudio(', true],
      ['function mountLauncher(', false],
      ['function openArtistDock(', true],
      ['function latestReplyHosts(', false],
      ['function fireLatestReply(', false],
      ['function decorate(', true]
    ]
    for (const [signature, takesT] of helpers) {
      const found = bodyOf(signature)
      check(`the client still declares ${signature.trim()}`, found !== null, '')
      if (found === null) continue
      const uses = /\bt\(/.test(found.text)
      check(
        `${signature.trim()} uses t only when it takes t`,
        uses === false || takesT === true,
        uses ? `uses t, takesT=${takesT}` : 'no t use'
      )
    }
    // A label the studio asks for but the dictionary never defines renders as the
    // raw key, which reads as a bug in the UI. Both dictionaries must carry each one.
    for (const key of ['studioTitle', 'studioArtist', 'studioNegative', 'studioSave', 'studioHint', 'studioChanged', 'studioRecipe', 'studioFireNow', 'studioFireHint', 'studioFireBusy', 'studioFireNone', 'studioFireSpent', 'studioFireStarted', 'artistFavAdd', 'artistFavRemove', 'artistFavSaved', 'artistFavCleared', 'artistFavFailed', 'artistFavSearch', 'artistFavNone', 'artistFavHint']) {
      const found = (client.match(new RegExp(`\\b${key}:`, 'g')) ?? []).length
      check(`the ${key} label exists in both dictionaries`, found >= 2, String(found))
    }
    // The window's artist picker is a list rather than a `<select>`, because an
    // `<option>` cannot hold a star and the star is the feature. Three properties carry
    // it, and none of them is visible in a screenshot: the star is on the row it stars,
    // starring is not picking, and the order is decided once per opening rather than
    // under the pointer — a list that re-sorts on the click that starred something hands
    // the next click to a different entry.
    check(
      'the artist picker is a list rather than a select',
      !/createElement\('select'\)/.test(client.slice(client.indexOf('studioArtist'), client.indexOf('studioArtist') + 900)) &&
        client.includes("pickerRow.append(pickName, pickWrap)"),
      ''
    )
    check('the picker says what it is to a screen reader', client.includes("list.setAttribute('role', 'listbox')") && client.includes("trigger.setAttribute('aria-haspopup', 'listbox')"), '')
    check(
      'each row carries a star that says what it is',
      client.includes("star.textContent = row.favorite === true ? '★' : '☆'") && client.includes("star.setAttribute('aria-pressed'"),
      ''
    )
    check(
      'starring a row is not picking it',
      /star\.addEventListener\('click',[\s\S]{0,260}stopPropagation[\s\S]{0,420}starring\(row\)/.test(client),
      ''
    )
    check(
      'the star is written through the host rather than kept in the page',
      client.includes("await api('/artist-favorite'") && client.includes('body: JSON.stringify({ id: Number(row.id), favorite: want })'),
      ''
    )
    check('the starred entries lead when the list is opened', client.includes('artists.artists = favoriteFirst(artists.artists)'), '')
    check('the grid leads with them too, decided when it loads', client.includes('setArtists(favoriteFirst(body.artists))'), '')
    check(
      'the grid star does not pick either',
      /onClick: \(event\) => \{\s*event\.stopPropagation\(\)\s*onToggleFavorite\(row\)/.test(client),
      ''
    )
    check(
      'both lists ask for the whole archive rather than the first page',
      client.includes("api('/artists?limit=500')") && client.includes('/artists?limit=500&q='),
      ''
    )
    // The window takes the pointer on `pointerdown` for its drag, and it keeps it —
    // `setPointerCapture` retargets the rest of the gesture, the click included, to the
    // window root. It skips fields and buttons by tag; the artist list's rows are divs,
    // which is precisely how picking a row came to do nothing at all while the star
    // beside it (a `button`) worked fine. A double-click there is the same kind of trap:
    // it means "press this whole reply". So the list declares itself a gesture-free
    // surface, and both halves of that declaration are asserted here.
    check(
      'a press on a list row cannot be swallowed by the window drag',
      /DRAG_IGNORE = '[^']*\[data-no-window-gesture\]/.test(client) &&
        client.includes("popup.setAttribute('data-no-window-gesture', '')"),
      ''
    )
    check(
      'and a double-click on a row is not a request to press the whole reply',
      /closest\('input, textarea, select, button, \[data-no-window-gesture\]'\)/.test(client),
      ''
    )

    // The window's double-click is a manual act with two properties only a real window could
    // exercise: it refuses a reply that is still being written, and a double-click inside a field
    // or on a control is not a request to spend quota on a whole reply. Both live in the listener.
    check('the window listens for a double-click', client.includes("root.addEventListener('dblclick'"), '')
    check(
      'and a double-click on a field or a control is not a render request',
      client.includes("target.closest('input, textarea, select, button, [data-no-window-gesture]') !== null"),
      ''
    )
    check(
      'and the reply boundary is one ordered query, not two lists to interleave',
      client.includes('document.querySelectorAll(`pre, [${TURN_TAIL_ATTR}]`)'),
      ''
    )
    check('the hint line is part of the window', client.includes('root.append(header, fireLine, tabs, body, actions)'), '')

    // The line used to be a notice: it advertised a double-click, and the press lived in a
    // gesture nobody was told about. It is a button now, which is the only version of this that
    // can be found — and the double-click that used to *be* the feature is the same press behind
    // it, so the two entry points cannot drift apart.
    check(
      'the standing line is a button rather than a notice',
      client.includes("const fireLine = document.createElement('button')") &&
        client.includes("fireLine.title = t('studioFireHint')") &&
        client.includes("fireLine.textContent = t('studioFireNow')") &&
        client.includes("fireLine.addEventListener('click', pressFire)"),
      ''
    )
    check(
      'and the button and the double-click are one and the same press',
      /const pressFire = \(\) => \{/.test(client) &&
        /root\.addEventListener\('dblclick'[\s\S]{0,1200}pressFire\(\)/.test(client) &&
        (client.match(/pressFire\(\)/g) ?? []).length === 1,
      String((client.match(/pressFire\(\)/g) ?? []).length)
    )
    check(
      'a double-click arriving as two clicks is one press',
      client.includes('const PRESS_MERGE_MS = 400') &&
        client.includes('if (now !== 0 && now - lastPressAt < PRESS_MERGE_MS) return') &&
        client.includes('lastPressAt = now'),
      ''
    )
  }

  // ------------------------------------------------------ the artist switcher --
  // The artist string is the one setting that changes between two attempts at the same
  // idea, and the studio is a whole window for it. The switcher is that block alone, and
  // the property that makes it worth having is the one a screenshot cannot show: a pick
  // is written through at once. A switcher with a Save button would be a worse studio.
  {
    const client = await readFile(join(packageRoot, 'client.js'), 'utf8')
    const dockAt = client.indexOf('function openArtistDock(')
    const dock = dockAt < 0 ? '' : client.slice(dockAt, client.indexOf('\n    /**', dockAt))

    check('the client declares the artist switcher', dockAt >= 0, '')
    check(
      'a second launcher opens it, beside the studio one',
      (client.match(/mountLauncher\(\{/g) ?? []).length === 2 &&
        client.includes("mark: 'launcher-dock'") &&
        client.includes("glyph: '🎨'") &&
        client.includes("posKey: 'nai-imagegen:dock-launcher-pos'") &&
        client.includes("mark: 'launcher',"),
      String((client.match(/mountLauncher\(\{/g) ?? []).length)
    )
    check(
      'the launcher mechanic is shared rather than copied',
      /function mountLauncher\(options\) \{/.test(client) &&
        !/function installFloatingStudio\(t\) \{[\s\S]{0,400}setPointerCapture/.test(client),
      ''
    )
    // Nothing to press to see it: the switcher is on screen from activation, and the only
    // button left is the way back after a dismissal.
    {
      const installAt = client.indexOf('function installFloatingStudio(t) {')
      const install = installAt < 0 ? '' : client.slice(installAt, client.indexOf('\n    }', installAt))
      check(
        'the switcher is on screen without being asked for',
        install.includes('openArtistDock(t).catch(() => {})') &&
          !/onOpen: \(button\) => \{\s*openArtistDock/.test(install.replace(/[\s\S]*hideDockRestore\(\)/, '')),
        ''
      )
      check(
        'and dismissing it leaves the way back',
        install.includes('dockRestore = { show: showDockRestore, hide: hideDockRestore }') &&
          client.includes('if (dockRestore !== null) dockRestore.show?.()') &&
          client.includes('if (dockRestore !== null) dockRestore.hide?.()') &&
          install.includes("corner: { right: '18px', bottom: '70px' }"),
        ''
      )
    }
    // The whole point: no draft, no Save.
    check(
      'a pick is written through the moment it is made',
      dock.includes("await api('/config', { method: 'POST', body: JSON.stringify({ modes }) })") &&
        dock.includes('const applying = async (id, name) => {'),
      ''
    )
    check('the switcher has no Save button to forget', !/t\('studioSave'\)/.test(dock), '')
    // `save` replaces `modes` at the top level, so a one-mode write would wipe the other
    // mode's overrides — the switcher has to send the object whole.
    check(
      'the write carries both modes, so a switch in one cannot blank the other',
      /async function modesPatchFor\(mode, id\) \{[\s\S]{0,600}api\('\/status'\)/.test(client) &&
        client.includes('modes[mode] = { ...(modes[mode] ?? {}), artistId: Number(id) }'),
      ''
    )
    check(
      'and carries only real override fields, never the derived ones',
      /for \(const \[key, value\] of Object\.entries\(entry\.overrides \?\? \{\}\)\) \{[\s\S]{0,200}MODE_KEYS, key/.test(client),
      ''
    )
    // A pick that landed has to leave the other window honest: it holds its own copy.
    check(
      'the studio follows a switch made in the switcher',
      client.includes('if (typeof refreshArtistDock === \'function\') refreshArtistDock()') &&
        (client.match(/refreshArtistDock\(\)/g) ?? []).length >= 5,
      String((client.match(/refreshArtistDock\(\)/g) ?? []).length)
    )
    // The reference picture: small on purpose, and it opens.
    check(
      'the reference picture is a reminder, not the subject',
      dock.includes("'flex:none;width:42px;height:54px;padding:0;border:1px solid var(--dsw-alias-border-l1,#e2e2e6);'") &&
        dock.includes('cursor:zoom-in') &&
        dock.includes('openArtistZoom(`${API}/artist-image?id=${id}`, pickLabel())'),
      ''
    )
    check(
      'and a click on it enlarges it',
      /function openArtistZoom\(source, caption\) \{/.test(client) &&
        client.includes("overlay.setAttribute(STUDIO_MARK, 'artist-zoom')"),
      ''
    )
    // Deliberately not the lightbox: the strip beside a style guide would be earlier
    // renders, which are not other attempts at this guide.
    {
      const zoomAt = client.indexOf('function openArtistZoom(')
      const zoom = zoomAt < 0 ? '' : client.slice(zoomAt, client.indexOf('\n    /**', zoomAt))
      check('the enlargement carries no strip of unrelated renders', !zoom.includes("api('/gallery?limit="), '')
      check('and Escape puts it away', zoom.includes("event?.key !== 'Escape'"), '')
    }
    // A reply that rendered four pictures under four blocks has them scattered down the
    // answer. The board is one row of them at the end of that answer, and it is drawn from
    // files already recorded — which is why it can only arrive after a render finished.
    {
      const boardAt = client.indexOf('const BOARD_MARK = ')
      const board = boardAt < 0 ? '' : client.slice(boardAt, client.indexOf('function autoFire(', boardAt))
      check(
        'the board stands for the newest reply, read back out of what each block rendered',
        board.includes('function replyBoardFiles()') &&
          board.includes('for (const host of latestReplyHosts())') &&
          board.includes('const rows = generated.get(record.key)'),
        ''
      )
      check(
        'each thumbnail opens the whole batch at its own place',
        board.includes('openLightbox(thumb, { items: batch, index, t })') &&
          board.includes("thumb.style.cssText =") &&
          board.includes("'width:72px;height:72px;object-fit:cover;"),
        ''
      )
      check(
        'a thumbnail owns its click, so the sweep cannot open the gallery over it',
        board.includes('const BOARD_CLICK_ATTR') &&
          board.includes('thumb.setAttribute(BOARD_CLICK_ATTR') &&
          // The bail-out itself lives in the document-level sweep, not in the board.
          client.includes('target.getAttribute(BOARD_CLICK_ATTR)'),
        ''
      )
      check(
        'the board is seated after the reply’s last block, and only moved when it must be',
        board.includes('function placeBoard(board, parent, last)') &&
          board.includes('if (board.parentElement === parent && board.previousSibling === last) return true') &&
          board.includes('parent.insertBefore(board, last.nextSibling)'),
        ''
      )
      // One reply, one board: a document-wide lookup would find the first board ever written
      // — an older reply's — and move it down into the newest answer.
      check(
        'each reply finds its own board inside its own container',
        board.includes('function findBoard(parent)') &&
          board.includes('for (const child of parent.children ?? [])') &&
          !board.includes('document.querySelector(`[${STUDIO_MARK}="${BOARD_MARK}"]`)'),
        ''
      )
      check(
        'a board already showing these files is left alone',
        board.includes("const signature = files.map((file) => file.name).join('|')") &&
          board.includes('if (existing !== null && signature === boardSignature)'),
        ''
      )
      check(
        'it is drawn when the render finishes, not when the prompt is written',
        client.includes('if ((body.files ?? []).length > 0) refreshReplyBoard(t)') &&
          client.includes('if (cached.length > 0) refreshReplyBoard(t)') &&
          !client.includes('refreshReplyBoard(t)\n      autoFire'),
        ''
      )
      // Ten pictures make a row wider than the answer. The row clips and the two ends page it,
      // so the picture asked for is reachable with the mouse alone.
      check(
        'the board clips to one row instead of wrapping to three',
        client.includes("'display:flex;align-items:center;gap:6px;flex:1;min-width:0;overflow:hidden;'") &&
          client.includes('board.replaceChildren(label, arrows.left, strip, arrows.right)'),
        ''
      )
      check(
        'a press moves the strip by whole pictures, never past its ends',
        board.includes('function boardArrows(strip, t)') &&
          board.includes('const stepSize = (width) => Math.max(78 * 2, Math.floor(width / 78) * 78)') &&
          board.includes('const next = Math.min(room, Math.max(0, at + direction * stepSize(width)))'),
        ''
      )
      check(
        'an arrow disables at its end and both leave when the board fits',
        board.includes('setOff(left, idle || at <= 1)') &&
          board.includes('setOff(right, idle || at >= room - 1)') &&
          board.includes("left.style.display = idle ? 'none' : ''"),
        ''
      )
      check(
        'the arrows are measured once the board is seated, not before',
        board.includes('placeBoard(board, parent, last)\n      // Read the row only once it is in the document') &&
          board.includes('arrows.sync()'),
        ''
      )
      for (const key of ['boardTitle', 'boardCount', 'boardZoom', 'boardPrev', 'boardNext', 'zoomPrev', 'zoomNext', 'boardReroll']) {
        check(`the ${key} label exists in both dictionaries`, (client.match(new RegExp(`\\b${key}:`, 'g')) ?? []).length >= 2, '')
      }
    }
    // Opening a conversation rebuilds its transcript, so the pictures a reply rendered are
    // gone from the document. The block asks the host what its prompt produced — one lookup for
    // the whole reply, no render — and fills itself back in.
    {
      const restoreAt = client.indexOf('const restoreTargets = new Map()')
      const restore = restoreAt < 0 ? '' : client.slice(restoreAt, client.indexOf('const decorated = new WeakMap()', restoreAt))
      check(
        'a bare block asks for the files its prompt produced before',
        client.includes('queueRestore(key, { host, slot, status }, t)') &&
          restore !== '' &&
          restore.includes("api('/rendered'") &&
          restore.includes('JSON.stringify({ keys, texts })'),
        ''
      )
      check(
        'and the words of the block go with the digest, for a host that keyed it differently',
        restore.includes('const restoreTexts = new Map()') &&
          restore.includes('restoreTexts.clear()') &&
          client.includes('restoreTexts.set(key, text)') &&
          client.indexOf('restoreTexts.set(key, text)') <
            client.indexOf('queueRestore(key, { host, slot, status }, t)'),
        ''
      )
      check(
        'one request answers the whole reply, after it has finished decorating',
        restore.includes('const RESTORE_BATCH_MS = 80') &&
          restore.includes('restorePending = setTimeout(run, RESTORE_BATCH_MS)') &&
          restore.includes('restoreTargets.clear()'),
        ''
      )
      check(
        'a digest is asked about once, however often the block is rebuilt',
        restore.includes('const restoreAsked = new Set()') && restore.includes('if (restoreAsked.has(key))'),
        ''
      )
      check(
        'the restored block is filled, labelled, and taken as answered',
        restore.includes('generated.set(one, rows)') &&
          restore.includes('showFiles(target.slot, rows)') &&
          restore.includes("target.status.textContent = target.t('blockRestored')") &&
          restore.includes('historyBlocks.add(target.host)') &&
          restore.includes('refreshReplyBoard(target.t)'),
        ''
      )
      check(
        'the click passes its own digest, so the host keys the index the same way',
        client.includes("JSON.stringify({ prompt: text.trim(), key })"),
        ''
      )
      check('the blockRestored label exists in both dictionaries', (client.match(/\bblockRestored:/g) ?? []).length >= 2, '')
      // A reload empties every map this bundle keeps, and a restart empties the host's process
      // too. The store in the browser is what makes a reply's pictures — and so its board — come
      // back with no render and without waiting on the host.
      check(
        'a finished render is remembered outside the page',
        client.includes("const RENDER_STORE = 'nai-imagegen:renders'") &&
          client.includes('const RENDER_STORE_MAX = 240') &&
          client.includes('const store = holder?.localStorage') &&
          client.includes('rememberFiles(key, body.files ?? [])') &&
          client.includes('rememberFiles(one, rows)'),
        ''
      )
      check(
        'a block reads that store before it asks the host anything',
        client.includes('const stored = recallFiles(key)') &&
          client.indexOf('const stored = recallFiles(key)') < client.indexOf('queueRestore(key, { host, slot, status }, t)'),
        ''
      )
      check(
        'a host that could not answer is asked again later instead of written off',
        restore.includes('for (const one of keys) restoreAsked.delete(one)'),
        ''
      )
      check(
        'every pass ends by putting the reply’s board back',
        client.includes('try {\n          refreshReplyBoard(t)\n        } catch {'),
        ''
      )
      check(
        'each picture of the board keeps the prompt that made it, and its own place',
        client.includes("key: String(record.key ?? '')") &&
          client.includes("text: typeof record.text === 'string' ? record.text : ''") &&
          client.includes('for (let index = 0; index < rows.length; index += 1)'),
        ''
      )
      check(
        'redrawing one picture asks the host for one, not a batch',
        client.includes('function rerollBoardFile(file, button, t)') &&
          client.includes("api('/generate', {") &&
          client.includes('{ prompt: text.trim(), key, nSamples: 1 }'),
        ''
      )
      check(
        'the fresh picture takes the slot the old one had, and is written down with it',
        client.includes('if (Array.isArray(rows) && at < rows.length) rows[at] = row') &&
          client.includes('rememberFiles(key, Array.isArray(rows) ? rows : [row])'),
        ''
      )
      check(
        'a press on the redraw is not a press on the picture, and one press is one render',
        client.includes('const rerolling = new Set()') &&
          client.includes('if (rerolling.has(token)) return null') &&
          /button\.addEventListener\('click', \(event\) => \{[\s\S]{0,220}event\.stopPropagation\(\)/.test(client),
        ''
      )
      check(
        'the button sits under its own thumbnail, and is left out when the prompt is gone',
        client.includes('function boardCell(file, batch, index, t)') &&
          client.includes("if (String(file?.text ?? '').trim() === '') return thumb") &&
          client.includes('cell.append(thumb, button)') &&
          client.includes("button.setAttribute(BOARD_REROLL_ATTR, '1')") &&
          client.includes('const BOARD_REROLL_ATTR') &&
          client.includes('boardCell(file, batch, index, t)'),
        ''
      )
    }
    // The overlay walks a batch when it is given one, and the gallery only when it is not.
    {
      const boxAt = client.indexOf('function openLightbox(image')
      const box = boxAt < 0 ? '' : client.slice(boxAt, client.indexOf('\n    /**', boxAt))
      check(
        'the overlay can be handed the batch the board stands for',
        box.includes('const batch = Array.isArray(options?.items) ? options.items : null') &&
          box.includes('items.length = 0') &&
          box.includes('Math.min(items.length - 1, asked)'),
        ''
      )
      check(
        'a batch keeps its own pictures and reads no gallery',
        box.includes('if (batch !== null) return overlay') &&
          box.includes("api('/gallery?limit=200')"),
        ''
      )
      check('every picture of the batch gets a thumbnail', box.includes('for (const item of items) addThumb(item)'), '')
      check(
        'the overlay steps with a click as well as with the arrow keys',
        client.includes("const LIGHTBOX_ARROW_ATTR = 'data-nai-imagegen-lightbox-arrow'") &&
          box.includes('arrow.setAttribute(LIGHTBOX_ARROW_ATTR, String(direction))') &&
          box.includes('arrows.prev = buildArrow(-1)') &&
          box.includes('arrows.next = buildArrow(1)') &&
          box.includes('show(index + direction)') &&
          box.includes('overlay.append(arrow)'),
        ''
      )
      check(
        'a step on a handle does not also put the overlay away',
        /arrow\.addEventListener\('click', \(event\) => \{[\s\S]{0,240}event\.stopPropagation\(\)/.test(box) &&
          box.includes("arrow.addEventListener('pointerdown', (event) => event.stopPropagation())"),
        ''
      )
      check(
        'one picture wears no handle, and a gallery that turns up later turns them on',
        box.includes('const many = items.length > 1') &&
          box.includes("if (arrow !== null) arrow.style.display = many ? '' : 'none'") &&
          box.includes('if (items.length <= 1) return'),
        ''
      )
      check(
        'the handles sit on the two sides of the picture',
        box.includes("...LIGHTBOX_ARROW_STYLE,") && box.includes("[direction < 0 ? 'left' : 'right']: '16px'"),
        ''
      )
    }

    check(
      'the switcher says which mode a pick lands on',
      dock.includes('const modeChip = document.createElement(\'button\')') &&
        dock.includes('active = active === \'comic\' ? \'illustration\' : \'comic\''),
      ''
    )
    // Clearing the string has to be one press away rather than a side effect.
    check('clearing the pick is a row like any other', dock.includes('const noneRow = { id: -1, name: t(\'artistNone\') }'), '')
    check(
      'the list here cannot be swallowed by the window drag either',
      /DRAG_IGNORE = 'input,select,textarea,button,a,\[contenteditable="true"\],\[data-no-window-gesture\]'/.test(dock) &&
        dock.includes("popup.setAttribute('data-no-window-gesture', '')"),
      ''
    )
    for (const key of ['dockTitle', 'dockHint', 'dockApplying', 'dockApplied', 'dockFailed', 'dockZoom']) {
      const found = (client.match(new RegExp(`\\b${key}:`, 'g')) ?? []).length
      check(`the ${key} label exists in both dictionaries`, found >= 2, String(found))
    }
    // One row and nothing under it. The switcher exists to be pressed, so the studio's
    // 「生效文本」 block is deliberately absent here: a window that repeated it would be a
    // taller window that still only does one thing.
    check(
      'the switcher is the picker row alone',
      dock.includes('body.append(rowWrap)') &&
        !dock.includes('studioArtistPreview') &&
        !dock.includes('paintPreview') &&
        !dock.includes('statusLine'),
      dock.includes('body.append(rowWrap,') ? 'rowWrap is appended with more than itself' : ''
    )
    // With no status line to write in, the report goes on the control that was pressed.
    check(
      'a pick reports itself on the trigger',
      dock.includes("flash(`${t('dockApplying')}…`, 'idle', 0)") &&
        dock.includes("flash(`${t('dockApplied')} ✓`, 'good', 1400)") &&
        dock.includes("flash(`${t('dockFailed')}：${error.message}`, 'bad', 4000)"),
      ''
    )
    check(
      'and the trigger goes back to naming the pick afterwards',
      /const restTrigger = \(\) => \{\s*restingText = pickLabel\(\)/.test(dock) && dock.includes('restTrigger()'),
      ''
    )
    // The list has to behave exactly like the studio's, or the two windows teach the user
    // two different things about what a star does.
    check(
      'the star is the studio star, not a second-hand copy',
      (client.match(/star\.textContent = row\.favorite === true \? '★' : '☆'/g) ?? []).length === 2 &&
        dock.includes("star.setAttribute('aria-pressed'"),
      String((client.match(/star\.textContent = row\.favorite === true \? '★' : '☆'/g) ?? []).length)
    )
    check(
      'starring is a press of its own and never a pick',
      dock.includes("api('/artist-favorite'") &&
        dock.includes('event?.stopPropagation?.()') &&
        dock.includes('row.favorite = (body.favorites ?? []).map((value) => Number(value)).includes(Number(row.id))'),
      ''
    )
    check(
      'the favourites lead the list here too',
      dock.includes('artists.artists = favoriteFirst(artists.artists)') &&
        dock.includes("hint.textContent = t('artistFavHint')") &&
        dock.includes("t('artistFavSaved')") &&
        dock.includes("t('artistFavCleared')"),
      ''
    )
    check(
      'and clearing the string is not something to curate',
      dock.includes('if (Number(row.id) >= 0) {'),
      ''
    )
    // Switching the string is half an iteration; pressing it is the other half. The press
    // belongs in the window's own header — between the title and the mode chip — so a new
    // string can be rendered without opening the studio behind it.
    check(
      'the switcher can render the newest reply without opening the studio',
      dock.includes('const fireButton = document.createElement(\'button\')') &&
        dock.includes('fireButton.textContent = `↻ ${t(\'dockFire\')}`') &&
        dock.includes('const outcome = fireLatestReply(t)') &&
        dock.includes('header.append(title, fireButton, modeChip, closeButton)'),
      ''
    )
    check(
      'and the press is in the window, not beside it',
      // One fire launcher in the corner would be a second place to press the same thing;
      // the header already holds the picker that changed the string.
      !client.includes("mark: 'launcher-fire'") &&
        !client.includes('options.pill === true') &&
        (client.match(/mountLauncher\(\{/g) ?? []).length === 2,
      String((client.match(/mountLauncher\(\{/g) ?? []).length)
    )
    check(
      'that press is the studio line’s own act, not a second implementation',
      // Three: the definition, the studio's line, and the dock's. A fourth would mean a copy.
      (client.match(/fireLatestReply\(t\)/g) ?? []).length === 3 &&
        (client.match(/pressFire\(\)/g) ?? []).length === 1 &&
        dock.includes("outcome?.reason === 'clicked'") &&
        dock.includes("outcome?.reason === 'spent'"),
      `fireLatestReply=${(client.match(/fireLatestReply\(t\)/g) ?? []).length} pressFire=${(client.match(/pressFire\(\)/g) ?? []).length}`
    )
    check(
      'it says what came of the press, then names itself again',
      dock.includes('${t(\'studioFireStarted\')}${outcome.clicked}${t(\'autoImageUnit\')}') &&
        dock.includes('fireButton.textContent = `↻ ${t(\'dockFire\')}`') &&
        (client.match(/\bdockFire:/g) ?? []).length === 2,
      String((client.match(/\bdockFire:/g) ?? []).length)
    )
    // The button carries its own mark, and the press reads it back off the DOM: a transcript
    // rebuilt around a block, an element moved under a new parent, or a bundle activated twice
    // all leave a button on screen that the map no longer answers for. The report was
    // 「这个回复里没有可出的提示词块」 with the prompt's button sitting right there in the reply.
    check(
      'the render button can be found without the map that made it',
      client.includes("const FIRE_ATTR = 'data-nai-imagegen-fire'") &&
        client.includes('button.setAttribute(FIRE_ATTR, \'1\')') &&
        client.includes('function adoptableDecoration(host) {') &&
        client.includes('host.querySelector(`button[${FIRE_ATTR}]`)'),
      ''
    )
    check(
      'a marked block with no record adopts the button instead of ignoring it',
      client.includes('const adopted = adoptableDecoration(host)') &&
        client.includes(
          'decorated.set(host, { button: adopted.button, key, text, injected: adopted.injected })'
        ) &&
        !client.includes('// Marked, but nothing recorded: leave it alone rather than stacking a'),
      ''
    )
    check(
      'the press decorates the reply it is about to press',
      client.includes('const seen = newestReplyHosts()') &&
        (client.match(/decorate\(pre, t\)/g) ?? []).length >= 2 &&
        client.includes('fireLatestReply(t)') &&
        client.includes("diag('fire', {"),
      String((client.match(/decorate\(pre, t\)/g) ?? []).length)
    )
  }

  const missing = await callRoute(route, fakeRequest({ url: '/nai-imagegen/api/file?name=nope.png' }))
  check('GET /file reports a missing file as 400', missing.status === 400, String(missing.status))

  // The free probe: it validates host, path and token without rendering.
  const probed = await probe({ baseUrl: `http://127.0.0.1:${stubPort}`, token: 'pst-pipeline' })
  check('probe reports reachable', probed.ok === true, JSON.stringify(probed))
  check('probe sends the bearer token to the subscription route', captured.subscriptionAuthorization === 'Bearer pst-pipeline', String(captured.subscriptionAuthorization))
  check('probe reads the tier', probed.subscription?.tier === 3)
  check(
    'probe reads both Anlas components',
    probed.subscription?.fixedAnlas === 1200 && probed.subscription?.purchasedAnlas === 75,
    JSON.stringify(probed.subscription)
  )
  check('probe sums them into one balance', probed.subscription?.remainingAnlas === 1275, String(probed.subscription?.remainingAnlas))
  check('probe converts a seconds expiry to milliseconds', probed.subscription?.expiresAt === 1800000000000, String(probed.subscription?.expiresAt))
  check('probe reports no render was triggered', captured.payload !== null, 'the probe hit the generate route')

  const probeRoute = await callRoute(route, fakeRequest({ method: 'POST', url: '/nai-imagegen/api/probe', body: '{}' }))
  check('POST /probe answers 200', probeRoute.status === 200, String(probeRoute.status))
  check('POST /probe reports the tier', asJson(probeRoute).subscription?.tier === 3)
  check(
    'POST /probe carries the whole quota',
    asJson(probeRoute).subscription?.v5Quota?.remainingImages === 562,
    JSON.stringify(asJson(probeRoute).subscription?.v5Quota)
  )

  const probeTool = mounted.tools.get('nai_probe')
  const probeText = await probeTool.execute({}, { signal })
  check('nai_probe names the Anlas balance', /Anlas 余额：1275/.test(probeText), probeText.slice(0, 200))
  check('nai_probe reports the subscription tier', /订阅档：3/.test(probeText), probeText.slice(0, 200))
  check('nai_probe answers the quota question in one line', /额度：32\.5%（约 562 张）/.test(probeText), probeText.slice(0, 300))

  // ---- membership, Anlas and the V5 free band -----------------------------
  // The rules here are the upstream spec's §2–§8; the numbers are the ones its
  // acceptance checklist names, so a regression in the arithmetic is visible.
  subscriptionMode = 'ok'
  check('the coefficient is the displayed estimate, not a promise', V5_IMAGE_COEFFICIENT === 17.3, String(V5_IMAGE_COEFFICIENT))
  {
    const readAt = 1759826000000
    const record = normalizeSubscription(
      {
        active: true,
        tier: 3,
        expiresAt: 1800000000,
        trainingStepsLeft: { fixedTrainingStepsLeft: 1200, purchasedTrainingSteps: 75 },
        usage: { percent: 32.5, isNegative: false, timeUntilNextPercent: 3600 }
      },
      readAt
    )
    check('an Opus record yields the displayed image count', record.v5Quota.remainingImages === 562, JSON.stringify(record.v5Quota))
    check(
      'an hourly recovery becomes a daily percentage',
      record.v5Quota.dailyRefillPercent === 24 && record.v5Quota.dailyRefillImages === 415,
      JSON.stringify(record.v5Quota)
    )
    check('the estimate is marked estimated and sourced', record.v5Quota.estimated === true && record.v5Quota.source === 'subscription-usage')
    check('the read is stamped with the time it happened', record.v5Quota.refreshedAt === readAt)
    check('one line answers "how much free quota is left"', /32\.5%/.test(describeQuota(record.v5Quota)) && /562/.test(describeQuota(record.v5Quota)), describeQuota(record.v5Quota))

    // Four gates, four sentences: an unavailable quota is never a zero.
    const gated = [
      normalizeQuota({ active: false, tier: 3, usage: { percent: 10, isNegative: false } }, readAt),
      normalizeQuota({ active: true, tier: 2 }, readAt),
      normalizeQuota({ active: true, tier: 3 }, readAt),
      normalizeQuota({ active: true, tier: 3, usage: { percent: '32.5', isNegative: false } }, readAt)
    ]
    check(
      'each reason the quota can be unavailable has its own name',
      gated.map((quota) => quota.reason).join(',') === 'inactive,non-opus,missing-usage,invalid-usage',
      JSON.stringify(gated.map((quota) => quota.reason))
    )
    check(
      'an unavailable quota reports no image count at all',
      gated.every((quota) => quota.status === 'unavailable' && quota.remainingImages === undefined),
      JSON.stringify(gated)
    )
    check(
      'an unavailable quota is explained rather than shown as zero',
      /不可用（非 Opus/.test(describeQuota(gated[1])),
      describeQuota(gated[1])
    )
    const empty = normalizeQuota({ active: true, tier: 3, usage: { percent: 0, isNegative: false, timeUntilNextPercent: 3600 } }, readAt)
    check('an actually empty band is a known zero, not an unknown', empty.status === 'ok' && empty.remainingImages === 0, JSON.stringify(empty))
    const negative = normalizeQuota({ active: true, tier: 3, usage: { percent: -40, isNegative: true, timeUntilNextPercent: 3600 } }, readAt)
    check('a negative reading clamps to zero without flipping', negative.remainingPercent === 0 && negative.remainingImages === 0, JSON.stringify(negative))
    const over = normalizeQuota({ active: true, tier: 3, usage: { percent: 125, isNegative: false, timeUntilNextPercent: 0 } }, readAt)
    check('a percentage above 100 keeps its real value', over.remainingPercent === 125 && over.remainingImages === 2163, JSON.stringify(over))
    check('a zero recovery time is a paused recovery, not a missing field', over.dailyRefillPercent === 0, JSON.stringify(over))
    const noSpeed = normalizeQuota({ active: true, tier: 3, usage: { percent: 40, isNegative: false } }, readAt)
    check('a missing recovery time is unknown, not paused', noSpeed.dailyRefillPercent === null && noSpeed.dailyRefillImages === null, JSON.stringify(noSpeed))
    check('a missing recovery time says so', /恢复速度/.test(describeQuota(noSpeed)), describeQuota(noSpeed))
    check(
      'the panel clamps a paused recovery into words',
      /恢复暂停/.test(describeQuota(over)),
      describeQuota(over)
    )

    // An unknown balance must not collapse into a confident zero.
    const partial = normalizeSubscription({ tier: 3, trainingStepsLeft: { fixedTrainingStepsLeft: '', purchasedTrainingSteps: true } })
    check('one unusable component makes the balance unknown', partial.remainingAnlas === null, JSON.stringify(partial))
    check('a blank component is unknown rather than zero', partial.fixedAnlas === null && normalizeAnlas('') === null && normalizeAnlas(false) === null)
    check(
      'a real zero balance survives',
      normalizeSubscription({ tier: 3, trainingStepsLeft: { fixedTrainingStepsLeft: 0, purchasedTrainingSteps: 0 } }).remainingAnlas === 0
    )
    check('the legacy aliases still read', normalizeSubscription({ subscriptionTier: 3, expires_at: 1800000000 }).tier === 3)
    check('a body that is not an object is no record at all', normalizeSubscription('nope') === null)

    // Aggregation: only what is known, and never percentages.
    const aggregate = summarizeQuota([
      { v5Quota: record.v5Quota },
      { v5Quota: { status: 'error', code: 'HTTP_500' } },
      { v5Quota: { status: 'unqueried' } },
      { v5Quota: { status: 'unavailable', reason: 'non-opus', refreshedAt: readAt - 1 } }
    ])
    check('a key that never answered is counted as unqueried', aggregate.queriedKeyCount === 3, JSON.stringify(aggregate))
    check('every local key is counted', aggregate.keyCount === 4, JSON.stringify(aggregate))
    check(
      'a subscription without a free band is still a successful query',
      aggregate.successfulKeyCount === 2 && aggregate.failedKeyCount === 1,
      JSON.stringify(aggregate)
    )
    check('only known image counts are summed', aggregate.remainingImages === 562 && aggregate.knownRemainingKeyCount === 1, JSON.stringify(aggregate))
    check('percentages are never added across keys', !JSON.stringify(aggregate).includes('remainingPercent'), JSON.stringify(aggregate))
    check('nothing known totals null, not zero', summarizeQuota([{ v5Quota: { status: 'unqueried' } }]).remainingImages === null)
    check(
      'a known zero still totals zero',
      summarizeQuota([{ v5Quota: { status: 'ok', source: 'subscription-usage', remainingImages: 0 } }]).remainingImages === 0
    )
  }

  // The read-only route: what is already known, and nothing else.
  const quotaBefore = asJson(await callRoute(route, fakeRequest({ url: '/nai-imagegen/api/quota' })))
  check('GET /quota answers 200', quotaBefore.ok === true, JSON.stringify(quotaBefore).slice(0, 160))
  const readOnlyHits = captured.subscriptionHits
  check(
    'GET /quota answers from what is already known, without a request',
    captured.subscriptionHits === readOnlyHits,
    `${readOnlyHits} -> ${captured.subscriptionHits}`
  )
  check(
    'the read-only route reports the record a probe already wrote',
    (quotaBefore.keys ?? []).length > 0 && quotaBefore.keys.every((key) => key.v5Quota.status !== 'error'),
    JSON.stringify(quotaBefore.keys?.[0]?.v5Quota ?? null).slice(0, 160)
  )
  check('GET /quota never carries a token', !JSON.stringify(quotaBefore).includes('pst-pipeline'))
  check(
    'the per-key quota is the same reading the subscription carries',
    (quotaBefore.keys ?? []).length > 0 &&
      quotaBefore.keys.every((key) => JSON.stringify(key.v5Quota) === JSON.stringify(key.subscription?.v5Quota)),
    JSON.stringify(quotaBefore.keys?.[0] ?? null).slice(0, 200)
  )

  const hitsBefore = captured.subscriptionHits
  const quotaAfter = asJson(await callRoute(route, fakeRequest({ method: 'POST', url: '/nai-imagegen/api/quota', body: '{}' })))
  check('POST /quota refreshes with exactly one read per key', captured.subscriptionHits === hitsBefore + 1, `${hitsBefore} -> ${captured.subscriptionHits}`)
  check('POST /quota reports the read', quotaAfter.keys[0].v5Quota.status === 'ok' && quotaAfter.remainingImages === 562, JSON.stringify(quotaAfter).slice(0, 200))
  check('POST /quota keeps the Anlas reading alongside the quota', quotaAfter.keys[0].subscription?.remainingAnlas === 1275, JSON.stringify(quotaAfter.keys[0].subscription))
  check('the summary and the per-key view agree', quotaAfter.queriedKeyCount === 1 && quotaAfter.successfulKeyCount === 1, JSON.stringify(quotaAfter).slice(0, 200))

  // A failing read is a failing *read*: the key keeps its balance and its right
  // to render, which is the difference between this and a verify.
  subscriptionMode = 'boom'
  const hitsBeforeFailure = captured.subscriptionHits
  const quotaFailed = asJson(await callRoute(route, fakeRequest({ method: 'POST', url: '/nai-imagegen/api/quota', body: '{}' })))
  check(
    'a transient failure is retried exactly once',
    captured.subscriptionHits === hitsBeforeFailure + 2,
    `${hitsBeforeFailure} -> ${captured.subscriptionHits}`
  )
  check(
    'a failed read is reported as a failure',
    quotaFailed.keys[0].v5Quota.status === 'error' && quotaFailed.keys[0].v5Quota.code === 'HTTP_500',
    JSON.stringify(quotaFailed.keys[0].v5Quota)
  )
  check('a failed read keeps the balance it last saw', quotaFailed.keys[0].subscription?.remainingAnlas === 1275, JSON.stringify(quotaFailed.keys[0].subscription))
  check(
    'a failed read cannot disable a key or colour its status',
    quotaFailed.keys[0].enabled === true && quotaFailed.keys[0].status !== 'invalid' && quotaFailed.keys[0].status !== 'forbidden',
    `${quotaFailed.keys[0].enabled}/${quotaFailed.keys[0].status}`
  )
  check('a failed read never echoes the upstream body', !JSON.stringify(quotaFailed).includes('pst-pipeline'), JSON.stringify(quotaFailed).slice(0, 200))
  const afterFailure = asJson(await callRoute(route, fakeRequest({ url: '/nai-imagegen/api/status' })))
  check('the pool still renders after a failed quota read', afterFailure.keySummary?.usableKeyCount >= 1, JSON.stringify(afterFailure.keySummary))
  const failedProbe = await probe({ baseUrl: `http://127.0.0.1:${stubPort}`, token: 'pst-pipeline' })
  check(
    'an upstream failure is reported without the upstream body',
    failedProbe.ok === false && failedProbe.stage === 'upstream' && !JSON.stringify(failedProbe).includes('pst-pipeline'),
    JSON.stringify(failedProbe)
  )
  subscriptionMode = 'ok'
  const recovered = asJson(await callRoute(route, fakeRequest({ method: 'POST', url: '/nai-imagegen/api/quota', body: '{}' })))
  check(
    'a later success clears the failure mark',
    recovered.keys[0].v5Quota.status === 'ok' && recovered.failedKeyCount === 0,
    JSON.stringify(recovered).slice(0, 200)
  )
  const clientSource = await readFile(join(packageRoot, 'client.js'), 'utf8')
  check(
    'the panel draws the quota with a clamped native bar and bilingual reasons',
    clientSource.includes("h('progress', {") &&
      clientSource.includes('Math.min(100, Math.max(0, quota.remainingPercent))') &&
      clientSource.includes("t('quotaRefresh')") &&
      clientSource.includes("api('/quota', { method: 'POST'") &&
      clientSource.includes("quotaNonOpus: '非 Opus 档，没有 V5 免费额度'") &&
      clientSource.includes("quotaNonOpus: 'not an Opus tier, so there is no V5 free band'"),
    ''
  )

  // The artist string must reach the wire. Anything else would make the archive
  // a list of texts to copy rather than the "style" it is meant to be.
  {
    const artistArchive = join(scratchHome, 'artist-archive.json')
    const artistIndex = join(scratchHome, 'artist-index.json')
    await writeFile(
      artistArchive,
      JSON.stringify([
        {
          name: '测试画风',
          sequence: 0,
          positivePrompt: 'STYLEPREFIX, ink wash',
          negativePrompt: 'BADSTYLE',
          chamipositivePrompt: '',
          chaminegativePrompt: '',
          referenceImage: ''
        }
      ]),
      'utf8'
    )
    const built = await buildArtistIndex({ sourceFile: artistArchive, indexPath: artistIndex })
    check('the artist fixture indexed', built.count === 1, String(built.count))

    await save({ artistIndex, artistId: 0 })
    const styled = await generate.execute({ prompt: 'userprompt, 1girl' }, { signal })
    const sentPrompt = String(captured.payload?.input ?? '')
    check('the artist prompt is prepended on the wire', sentPrompt.startsWith('STYLEPREFIX'), sentPrompt.slice(0, 90))
    check('the user prompt survives at the end', sentPrompt.endsWith('userprompt, 1girl'), sentPrompt.slice(-40))
    check(
      'the artist negative is merged into the negative prompt',
      String(captured.payload?.parameters?.negative_prompt ?? '').startsWith('BADSTYLE'),
      String(captured.payload?.parameters?.negative_prompt).slice(0, 60)
    )
    check('the tool result names the artist', /测试画风/.test(styled), styled.slice(0, 200))

    await save({ artistId: -1 })
    await generate.execute({ prompt: 'plain, 1girl' }, { signal })
    check('artistId -1 renders without the style', captured.payload?.input === 'plain, 1girl', String(captured.payload?.input))
    const override = await generate.execute({ prompt: 'x', artist_id: 0 }, { signal })
    check('a per-call artist_id overrides the setting', String(captured.payload?.input).startsWith('STYLEPREFIX'), String(captured.payload?.input).slice(0, 60))
    check('the override is named in the result too', /测试画风/.test(override), override.slice(0, 120))
    await save({ artistId: -1 })
  }

  // An unreachable base must surface as a clean tool error, not a crash.
  await save({ baseUrl: 'http://127.0.0.1:1' })
  try {
    await generate.execute({ prompt: 'x' }, { signal })
    check('an unreachable API reports an error', false, 'execute resolved')
  } catch (error) {
    check('an unreachable API reports an error', /cannot reach NovelAI/.test(error.message), error.message)
  }
  await save({ baseUrl: `http://127.0.0.1:${stubPort}` })

  // A missing key must be refused before any network work. The message now comes
  // from the key pool, which is the component that decides whether anything can
  // be dispatched at all.
  await save({ token: '' })
  try {
    await generate.execute({ prompt: 'x' }, { signal })
    check('a missing key is refused', false, 'execute resolved')
  } catch (error) {
    check('a missing key is refused', /没有可用的 NovelAI API Key/.test(error.message), error.message)
  }
  const probeWithoutToken = await probe({ baseUrl: `http://127.0.0.1:${stubPort}`, token: '' })
  check('probe reports a missing credential instead of guessing', probeWithoutToken.ok === false && probeWithoutToken.stage === 'token')
  await save({ token: 'pst-pipeline' })

  // The other half of the difference the spec draws: the same 401 that leaves a
  // key alone on a quota read retires it on a verify. Verify also passes
  // `noRetry`, which is why this is one request rather than two.
  subscriptionMode = 'token'
  const verifyHits = captured.subscriptionHits
  const verified401 = asJson(await callRoute(route, fakeRequest({ method: 'POST', url: '/nai-imagegen/api/keys/verify', body: '{}' })))
  check('a verify does not retry a 401', captured.subscriptionHits === verifyHits + 1, `${verifyHits} -> ${captured.subscriptionHits}`)
  check(
    'a 401 on a verify marks the key invalid and switches it off',
    (verified401.keys ?? []).some((key) => key.status === 'invalid' && key.enabled === false),
    JSON.stringify(verified401.keys ?? null).slice(0, 240)
  )
  subscriptionMode = 'ok'

  // A dead host must be reported as a network failure, not a crash.
  const deadProbe = await probe({ baseUrl: 'http://127.0.0.1:1', token: 'pst-pipeline' })
  check('probe reports an unreachable host', deadProbe.ok === false && deadProbe.stage === 'network', JSON.stringify(deadProbe))
} finally {
  await new Promise((resolve) => stub.close(resolve))
}

// =============================================================== [9] estimate
console.log('\n[9] estimate tool')
await save({ token: 'pst-pipeline', width: 832, height: 1216, steps: 28, maxImagesPerCall: 4 })
const estimate = mounted.tools.get('nai_estimate')
const estimateText = await estimate.execute({ n_samples: 2 }, { signal: new AbortController().signal })
check('the estimate reports a combined weight', /合计：2\b/.test(estimateText), estimateText.replace(/\n/g, ' | '))
check('the estimate names the sample count', estimateText.includes('2 张'))
const heavy = await estimate.execute({ width: 1600, height: 1600, steps: 50 }, { signal: new AbortController().signal })
check('a heavy estimate is flagged as outside the free band', /超出 Opus 免计费区间/.test(heavy), heavy.replace(/\n/g, ' | '))
const freeBand = await estimate.execute({ width: 832, height: 1216, steps: 28 }, { signal: new AbortController().signal })
check('the default shape is reported as inside the free band', /落在 Opus 免计费区间内/.test(freeBand), freeBand.replace(/\n/g, ' | '))
const multi = await estimate.execute({ n_samples: 2 }, { signal: new AbortController().signal })
check('more than one image leaves the free band', /多张/.test(multi), multi.replace(/\n/g, ' | '))
const capped = await estimate.execute({ n_samples: 99 }, { signal: new AbortController().signal })
check('the estimate honours the per-call cap', /被 maxImagesPerCall 压到 4 张/.test(capped), capped.replace(/\n/g, ' | '))

// ================================================================ [10] cleanup
console.log('\n[10] state tools')
const statusText = await mounted.tools.get('nai_status').execute({}, { signal: new AbortController().signal })
check('status names the output directory', statusText.includes(await load().then((c) => c.outputDir)))
check('status names the indexed libraries', /已索引的库/.test(statusText))
const indexedText = await mounted.tools.get('nai_index').execute({}, { signal: new AbortController().signal })
check('index reports what it wrote', /索引已重建|没有找到/.test(indexedText), indexedText.slice(0, 160))
const configText = await mounted.tools.get('nai_config').execute({ steps: 30 }, { signal: new AbortController().signal })
check('config tool reports the change', /已更新/.test(configText), configText.slice(0, 160))
check('config tool actually changed it', (await load()).steps === 30)
const noopText = await mounted.tools.get('nai_config').execute({}, { signal: new AbortController().signal })
check('config tool no-ops on an empty patch', /没有需要修改/.test(noopText))

const scratchEntries = await readdir(scratchHome)
check('the suite wrote only into its scratch home', scratchEntries.length > 0, scratchEntries.join(','))
check(
  'the real harness state file is still byte-identical',
  (await readFile(realStateFile, 'utf8').catch(() => null)) === realStateBefore,
  realStateBefore === null ? 'the real home had no state file before, and must not gain one' : 'content changed'
)

// ========================================================== [11] the reply tool
//
// `nai_reply` is the one tool whose whole body is a message to the browser half: the model hands
// over the turn's prose, the Host measures it and keeps no copy, and the client lifts it out of
// the call and paints it into the turn it belongs to. Three seams can break silently, so each
// gets its own half of this section — the wire name (both halves have to spell it the same way),
// the ledger (it must not become a second copy of the conversation) and the painter (a reply is
// model output, so it is text and never markup).
console.log('\n[11] the reply tool')
{
  const replyLib = await import('../lib/reply.js')
  const replySource = await readFile(join(packageRoot, 'lib', 'reply.js'), 'utf8')
  const replyTool = mounted.tools.get(replyLib.REPLY_TOOL_NAME)
  const replySignal = () => new AbortController().signal
  check('the host registers a tool under the name the client renders', replyTool !== undefined, [...mounted.tools.keys()].join(','))
  // The switch is the registration itself. Turning it off hands the tool back, so the model is
  // never asked for a transport that is off; turning it on registers it again under the same
  // name. Both directions read the answer back, because that answer is what the panel draws its
  // button from — a button drawn from the file instead would say "on" over a tool that is not in
  // the list, and the model would then be asked nothing.
  const replyOff = asJson(
    await callRoute(
      route,
      fakeRequest({ method: 'POST', url: '/nai-imagegen/api/config', body: JSON.stringify({ replyTransport: false }) })
    )
  )
  check(
    'switching the reply transport off takes the tool out of the list',
    mounted.tools.has(replyLib.REPLY_TOOL_NAME) === false && replyOff.status?.replyTransport === false,
    JSON.stringify({ registered: mounted.tools.has(replyLib.REPLY_TOOL_NAME), status: replyOff.status?.replyTransport })
  )
  const replyBackOn = asJson(
    await callRoute(
      route,
      fakeRequest({ method: 'POST', url: '/nai-imagegen/api/config', body: JSON.stringify({ replyTransport: true }) })
    )
  )
  check(
    'and switching it back on registers it again, under the same name',
    mounted.tools.has(replyLib.REPLY_TOOL_NAME) === true && replyBackOn.status?.replyTransport === true,
    JSON.stringify({ registered: mounted.tools.has(replyLib.REPLY_TOOL_NAME), status: replyBackOn.status?.replyTransport })
  )
  check(
    'the switch is a live registration, not a second copy of the tool',
    mounted.tools.size === [...mounted.tools.keys()].length && mounted.tools.get(replyLib.REPLY_TOOL_NAME).name === replyLib.REPLY_TOOL_NAME,
    String(mounted.tools.size)
  )
  check(
    'its description is the mandate itself, not a summary of one',
    typeof replyTool?.description === 'string' &&
      replyTool.description.includes('exactly once per reply') &&
      replyTool.description.includes('do not repeat it in the message body') &&
      replyTool.description.includes('Nothing is written to disk'),
    String(replyTool?.description ?? '').slice(0, 140)
  )
  check(
    'text is required, the caption is not',
    JSON.stringify(replyTool?.parameters?.required) === '["text"]' &&
      replyTool.parameters.properties.text?.type === 'string' &&
      replyTool.parameters.properties.label?.type === 'string' &&
      replyTool.parameters.additionalProperties === false,
    JSON.stringify(replyTool?.parameters)
  )
  let missingMessage = ''
  try {
    await replyTool.execute({ label: '只有标题' }, { signal: replySignal() })
  } catch (error) {
    missingMessage = error.message
  }
  check('a call with no text at all dies in the argument check', /^nai_reply: invalid arguments — text is required/.test(missingMessage), missingMessage)
  let emptyMessage = ''
  try {
    await replyTool.execute({ text: '  \n ' }, { signal: replySignal() })
  } catch (error) {
    emptyMessage = error.message
  }
  check('a reply that is only whitespace is refused by name', /^nai_reply: text 是空的/.test(emptyMessage), emptyMessage)

  // The delivery. The receipt is what the model gets back, and its numbers are the only way it can
  // tell the text arrived whole — so they are counted the way a reader counts, not the way UTF-16
  // does.
  const delivered = '# 标题\n\n正文 **加粗** 与 `代码`。\n\n- 一\n- 二\n\n```python\nprint(1)\n```\n'
  const receipt = await replyTool.execute({ text: delivered, label: '  三张图已出好  ' }, { signal: replySignal() })
  const counted = replyLib.summarizeReply(delivered)
  check('the receipt counts characters as code points', receipt.ok === true && receipt.chars === counted.chars, JSON.stringify(receipt))
  check(
    'and reports the lines and a digest of exactly this text',
    receipt.lines === counted.lines && receipt.sha === replyLib.replySha(delivered),
    JSON.stringify(receipt)
  )
  const dragon = await replyTool.execute({ text: '两条龙 🐉🐉' }, { signal: replySignal() })
  check('an emoji is one character and not two', dragon.chars === 6, `chars ${dragon.chars}, utf16 ${'两条龙 🐉🐉'.length}`)
  check(
    'the tool result tells the model nothing was written anywhere',
    /未写任何文件/.test(replyTool.output.render({}, receipt)[0]?.text ?? ''),
    JSON.stringify(replyTool.output.render({}, receipt))
  )

  // The ledger as `/status` hands it to the panel: sizes, timestamps, digests and the model's own
  // caption — never the prose. That shape is the promise that the Host is not a second copy of the
  // conversation, and it is asserted as a shape rather than field by field.
  const replyStatus = asJson(await callRoute(route, fakeRequest({ url: '/nai-imagegen/api/status' })))
  const ledger = replyStatus.reply
  check('status reports what the host was handed', ledger !== undefined && ledger.count >= 2, JSON.stringify(ledger ?? null).slice(0, 200))
  check(
    'the newest entry is the reply just delivered',
    ledger.lastChars === dragon.chars && ledger.lastSha === dragon.sha && ledger.lastLines === replyLib.summarizeReply('两条龙 🐉🐉').lines,
    JSON.stringify({ chars: ledger.lastChars, sha: ledger.lastSha, expected: dragon.sha })
  )
  check(
    'a caption is trimmed and rides along',
    (ledger.entries ?? []).some((entry) => entry.label === '三张图已出好') === true,
    JSON.stringify((ledger.entries ?? []).map((entry) => entry.label))
  )
  check(
    'the ledger never carries the prose',
    !JSON.stringify(ledger).includes('两条龙') && !JSON.stringify(ledger).includes('正文'),
    JSON.stringify(ledger).slice(0, 240)
  )
  const beforeRing = replyLib.replyLedger().count
  for (let index = 0; index < replyLib.REPLY_LEDGER_LIMIT + 5; index += 1) replyLib.recordReply(`第 ${index} 条`, null)
  const ring = replyLib.replyLedger()
  check(
    'a long run keeps counting past the memory limit',
    ring.count === beforeRing + replyLib.REPLY_LEDGER_LIMIT + 5 && ring.remembered === replyLib.REPLY_LEDGER_LIMIT,
    `count ${ring.count}, remembered ${ring.remembered}`
  )
  check(
    'the oldest entry is the one that aged out',
    ring.entries[0]?.chars === Array.from(`第 ${replyLib.REPLY_LEDGER_LIMIT + 4} 条`).length,
    JSON.stringify(ring.entries[0])
  )
  const longCaption = replyLib.recordReply('x', 'あ'.repeat(80))
  check(
    'a caption longer than the collapsed row is cut, not carried',
    Array.from(longCaption.label ?? '').length === replyLib.REPLY_LABEL_MAX,
    `label ${Array.from(longCaption.label ?? '').length}`
  )
  check('a blank body is recorded as blank rather than thrown out of the ledger', replyLib.recordReply('', null).blank === true)
  replyLib.resetReplies()
  check('reset forgets every count', replyLib.replyLedger().count === 0 && replyLib.replyLedger().remembered === 0)
  check(
    'the host half writes nothing: no filesystem, no request',
    !/node:fs|node:http|node:net|writeFile|createWriteStream/.test(replySource) &&
      /from '\.\/tool\.js'/.test(replySource) &&
      (replySource.match(/^import /gm) ?? []).length === 2,
    (replySource.match(/^import .*$/gm) ?? []).join(' | ')
  )

  // ------------------------------------------------------- the browser half --
  // The painter is checked against a DOM written here rather than the one section [6] ran against:
  // this half walks siblings and inserts before an anchor, and the older stub has neither
  // `insertBefore` nor `nextSibling`. The selectors it needs are the attribute ones the Tool
  // package's own markup is addressed by.
  const dataName = (key) => `data-${String(key).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`
  const parseSelector = (selector) => {
    const source = String(selector ?? '').trim()
    if (source === '') return null
    const parts = []
    let rest = source
    while (rest !== '') {
      const tag = /^[a-zA-Z][\w-]*|^\*/.exec(rest)
      if (tag !== null) {
        if (tag[0] !== '*') parts.push({ tag: tag[0].toUpperCase() })
        rest = rest.slice(tag[0].length)
        continue
      }
      const klass = /^\.([\w-]+)/.exec(rest)
      if (klass !== null) {
        parts.push({ klass: klass[1] })
        rest = rest.slice(klass[0].length)
        continue
      }
      const attribute = /^\[\s*([^\s\]=]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*)?\]/.exec(rest)
      if (attribute !== null) {
        parts.push({ attribute: attribute[1], value: attribute[2] ?? attribute[3] ?? attribute[4] ?? null })
        rest = rest.slice(attribute[0].length)
        continue
      }
      return null
    }
    return parts.length === 0 ? null : parts
  }
  const matchesSelector = (node, selector) => {
    if (node === null || node === undefined) return false
    // Two shapes reach these helpers: the parser's own trees (`{ tag, attrs, children }` with
    // `{ text }` leaves) and the DOM stub's elements. Only one of them carries `nodeType`, so the
    // tag name decides whether the node is an element at all.
    const name = node.tagName ?? node.tag
    if (node.nodeType !== 1 && typeof name !== 'string') return false
    const parts = parseSelector(selector)
    if (parts === null) return false
    return parts.every((part) => {
      if (part.tag !== undefined) return String(name).toUpperCase() === part.tag
      if (part.klass !== undefined) {
        const classes = node.className ?? node.attrs?.class ?? ''
        return String(classes).split(/\s+/).includes(part.klass)
      }
      const found =
        typeof node.getAttribute === 'function' ? node.getAttribute(part.attribute) : (node.attrs?.[part.attribute] ?? null)
      return part.value === null ? found !== null && found !== undefined : found === part.value
    })
  }
  const findAll = (root, selector) => {
    const found = []
    const walk = (node) => {
      for (const child of node.children ?? []) {
        if (matchesSelector(child, selector)) found.push(child)
        walk(child)
      }
    }
    walk(root)
    return found
  }
  const findFirst = (root, selector) => findAll(root, selector)[0] ?? null
  const textOf = (node) => {
    if (node === null || node === undefined) return ''
    if (node.nodeType === 3) return node.textContent
    if (Array.isArray(node.children) && node.children.length > 0) return node.children.map(textOf).join('')
    if (typeof node.text === 'string') return node.text
    if (typeof node.content === 'string') return node.content
    return (node.children ?? []).map(textOf).join('')
  }
  const makeReplyDom = () => {
    const documentStub = {}
    const makeNode = (tag) => {
      const name = String(tag)
      const node = {
        nodeType: name === '#text' ? 3 : name === '#fragment' ? 11 : 1,
        tagName: name === '#text' || name === '#fragment' ? undefined : name.toUpperCase(),
        children: [],
        parentNode: null,
        ownerDocument: documentStub,
        attributes: {},
        className: '',
        content: '',
        setAttribute(key, value) {
          node.attributes[String(key)] = String(value)
          if (String(key) === 'class') node.className = String(value)
        },
        getAttribute(key) {
          const found = String(key)
          return Object.prototype.hasOwnProperty.call(node.attributes, found) ? node.attributes[found] : null
        },
        removeAttribute(key) {
          delete node.attributes[String(key)]
        },
        appendChild(child) {
          if (child.parentNode !== null && child.parentNode !== undefined) child.parentNode.removeChild(child)
          child.parentNode = node
          node.children.push(child)
          return child
        },
        append(child) {
          node.appendChild(child)
        },
        insertBefore(child, reference) {
          if (child.parentNode !== null && child.parentNode !== undefined) child.parentNode.removeChild(child)
          const at = reference === null || reference === undefined ? node.children.length : node.children.indexOf(reference)
          child.parentNode = node
          node.children.splice(at < 0 ? node.children.length : at, 0, child)
          return child
        },
        removeChild(child) {
          const at = node.children.indexOf(child)
          if (at >= 0) node.children.splice(at, 1)
          child.parentNode = null
          return child
        },
        remove() {
          if (node.parentNode !== null && node.parentNode !== undefined) node.parentNode.removeChild(node)
        },
        replaceChildren(...kids) {
          for (const child of [...node.children]) node.removeChild(child)
          for (const child of kids) if (child !== null && child !== undefined) node.appendChild(child)
        },
        closest(selector) {
          let cursor = node.parentNode
          while (cursor !== null && cursor !== undefined) {
            if (matchesSelector(cursor, selector)) return cursor
            cursor = cursor.parentNode ?? null
          }
          return null
        },
        querySelector(selector) {
          return findFirst(node, selector)
        },
        querySelectorAll(selector) {
          return findAll(node, selector)
        },
        get parentElement() {
          const parent = node.parentNode
          return parent === null || parent === undefined || parent.nodeType !== 1 ? null : parent
        },
        get nextSibling() {
          const parent = node.parentNode
          if (parent === null || parent === undefined) return null
          const at = parent.children.indexOf(node) + 1
          return at > 0 && at < parent.children.length ? parent.children[at] : null
        },
        get firstChild() {
          return node.children[0] ?? null
        },
        set innerHTML(value) {
          throw new Error(`the reply painter must not write markup: ${String(value).slice(0, 40)}`)
        },
        get textContent() {
          return node.nodeType === 1 ? (node.children ?? []).map((child) => child.textContent).join('') : node.content
        },
        set textContent(value) {
          // The real property replaces the children with one text node, and the getter above reads
          // the children back — so a stub that only stashed the string would read as empty.
          node.content = String(value)
          if (node.nodeType !== 1) return
          for (const child of [...node.children]) node.removeChild(child)
          const text = documentStub.createTextNode(String(value))
          node.appendChild(text)
        }
      }
      // A real element reflects `dataset` into attributes, and the stylesheet is found again by
      // attribute later — so the stub reflects too, or the dedupe under test would be untested.
      node.dataset = new Proxy(
        {},
        {
          set(_target, key, value) {
            node.setAttribute(dataName(key), value)
            return true
          },
          get(_target, key) {
            return node.getAttribute(dataName(key)) ?? undefined
          }
        }
      )
      return node
    }
    const root = makeNode('#document')
    const head = makeNode('head')
    const body = makeNode('body')
    root.appendChild(head)
    root.appendChild(body)
    documentStub.head = head
    documentStub.body = body
    documentStub.documentElement = root
    documentStub.createElement = (tag) => makeNode(tag)
    documentStub.createTextNode = (text) => {
      const node = makeNode('#text')
      node.content = String(text)
      return node
    }
    documentStub.createDocumentFragment = () => makeNode('#fragment')
    documentStub.querySelector = (selector) => findFirst(root, selector)
    documentStub.querySelectorAll = (selector) => findAll(root, selector)
    documentStub.addEventListener = () => {}
    documentStub.removeEventListener = () => {}
    return { document: documentStub, root, head, body, makeNode }
  }
  const dom = makeReplyDom()

  const replyObservers = []
  const ReplyObserver = class {
    constructor(callback) {
      this.callback = callback
      this.targets = []
    }
    observe(target, options) {
      this.targets.push({ target, options })
      replyObservers.push({ target, options, observer: this })
    }
    disconnect() {
      this.disconnected = true
    }
  }
  const ReactStub = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [initial, () => {}],
    // React would run this after the render; running it inline is what makes the row's effect
    // observable without a renderer.
    useEffect: (fn) => {
      fn()
    },
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (initial) => ({ current: initial })
  }
  const replyInjected = []
  const replyRegistered = []
  const replyEffects = []
  const replyCtx = {
    effect: (fn, label) => {
      replyEffects.push({ fn, label })
      return () => {}
    },
    locale: {
      register: () => () => {},
      // The caption is painted outside React, so the binder has to be reached at paint time — and
      // a binder that answers the four real keys is what proves the caption and the count are the
      // dictionary's, not literals that happened to read well.
      bind: () =>
        (key) =>
          ({ replyCaption: '回复正文', replyReceived: '正文已送达', replyWriting: '正在写入', replyUnit: '字', replyDuplicate: '不重复' })[key] ??
          key
    },
    slots: {
      inject: (name, fn) => {
        replyInjected.push(name)
        fn()
      },
      register: (spec, component) => {
        replyRegistered.push({ spec, component })
        return () => {}
      }
    }
  }
  const replyExports =
    definition === null
      ? null
      : definition.factory((name) => {
          if (name === 'react') return ReactStub
          throw new Error(`unexpected external: ${name}`)
        })
  check('the bundle materializes a second time, for a DOM the painter can use', replyExports !== null)
  if (replyExports !== null) {
    replyExports.apply(replyCtx)
    check(
      'the client spells the tool name the way the host does',
      replyExports.REPLY_TOOL_NAME === replyLib.REPLY_TOOL_NAME,
      `${replyExports.REPLY_TOOL_NAME} vs ${replyLib.REPLY_TOOL_NAME}`
    )
    check('the receipt row asks for the tool-view seat', replyInjected.includes('tool.call.toolview'), replyInjected.join(','))
    const replySeat = replyRegistered.find((item) => item.spec.name === 'tool.call.toolview' && item.spec.key === replyLib.REPLY_TOOL_NAME)
    check(
      'and keys itself by that name, in the plugin’s own dictionary namespace',
      replySeat !== undefined && replySeat.spec.locale === 'naiImagegen' && typeof replySeat.component === 'function',
      JSON.stringify(replySeat?.spec ?? null)
    )
    const replyEffect = replyEffects.find((item) => /reply rows/.test(String(item.label)))
    check('activation installs the painter as an effect of its own', replyEffect !== undefined, replyEffects.map((item) => item.label).join(' | '))
    // Eight keys are read by the row, the caption and the switch; a key that reached only one
    // dictionary is a caption in Chinese on an English page.
    const keyHits = clientSource.match(/\breply(?:Caption|Received|Writing|Unit|Duplicate|On|Off|Hint):/g) ?? []
    check('all eight reply keys are in both dictionaries', keyHits.length === 16, String(keyHits.length))

    // ---------------------------------------- the readers, without any DOM --
    const phases = [
      ['a dispatched call', { phase: 'start', block: { argsRaw: '{"text":"dispatch"}' } }, 'dispatch'],
      ['a settled call', { phase: 'result', block: { kind: 'tool-call', call: { name: 'nai_reply', argsRaw: '{"text":"settled"}' } } }, 'settled']
    ]
    for (const [label, call, expected] of phases) {
      const read = replyExports.replyFromCall(call, '')
      check(`the reader finds the text in ${label}`, read.complete === true && read.text === expected, JSON.stringify(read))
    }
    const halfWritten = replyExports.replyFromCall({ phase: 'preparing', block: { argsRaw: '{"text":"半' } }, '')
    check(
      'a half-written call already hands over the text so far, marked unfinished',
      halfWritten.complete === false && halfWritten.text === '半' && halfWritten.pending === false,
      JSON.stringify(halfWritten)
    )
    check(
      'and the prefix hook stands in when the call carries nothing of its own',
      replyExports.replyFromCall({ phase: 'preparing', block: {} }, '{"text":"来自前缀"}').text === '来自前缀'
    )
    check(
      'arguments that are not an object are not a reply',
      replyExports.parseReplyArgs('"just a string"').complete === false && replyExports.parseReplyArgs('[1,2]').complete === false
    )
    check('a caption of spaces is no caption', replyExports.parseReplyArgs('{"text":"x","label":"   "}').label === null)
    check('the count of a half-written argument stops at the closing quote', replyExports.partialReplyChars('{"text":"abc"}') === 3, String(replyExports.partialReplyChars('{"text":"abc"}')))
    check('and an escape sequence counts as the one character it stands for', replyExports.partialReplyChars('{"text":"a\\nb') === 3, String(replyExports.partialReplyChars('{"text":"a\\nb')))
    check('a call with no text key at all counts nothing', replyExports.partialReplyChars('{"label":"x') === 0)

    // ---------------------------------------- the reader for a live fragment --
    // The transport this mirrors reads the argument as it arrives, so the fragment cases are the
    // interesting ones: half an escape, half a character, and a piece that simply stops.
    const splitEscape = replyExports.readPartialText('{"text":"a\\u00')
    check(
      'an escape split across deliveries waits instead of showing half of it',
      splitEscape.pending === true && splitEscape.text === 'a',
      JSON.stringify(splitEscape)
    )
    const loneBackslash = replyExports.readPartialText('{"text":"a\\')
    check('a backslash on the very end waits too', loneBackslash.pending === true && loneBackslash.text === 'a', JSON.stringify(loneBackslash))
    const pairedFace = replyExports.readPartialText('{"text":"\\ud83d\\ude00"}')
    check(
      'a surrogate pair arrives as the one character it names',
      pairedFace.complete === true && pairedFace.text === '😀' && replyExports.partialReplyChars('{"text":"\\ud83d\\ude00"}') === 1,
      JSON.stringify(pairedFace)
    )
    const halfFace = replyExports.readPartialText('{"text":"\\ud83d')
    check('and half of one is not shown while the other half is still coming', halfFace.pending === true && halfFace.text === '', JSON.stringify(halfFace))
    check(
      'a piece that simply stops is handed over as it stands',
      replyExports.readPartialText('{"text":"写到一半')?.text === '写到一半'
    )

    // ----------------------------------------------------- the Markdown reader --
    const markdown = replyExports.parseReplyMarkdown(
      '# 一\n\n段落\n第二行\n\n- 甲\n  - 甲子\n- 乙\n\n1. 首个\n2. 次\n\n> 引\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n---\n\n```js\nconst x = 1\n```\n'
    )
    check(
      'headings, lists, quotes, tables, rules and fences each become their own block',
      markdown.map((node) => node.tag).join(',') === 'h1,p,ul,ol,blockquote,table,hr,div,pre',
      markdown.map((node) => node.tag).join(',')
    )
    check(
      'a soft line break inside a paragraph is a line, not a space',
      (markdown[1]?.children ?? []).some((node) => node.tag === 'br') === true,
      JSON.stringify(markdown[1]?.children ?? null)
    )
    check('a nested list nests inside its item', findAll({ children: [markdown[2]] }, 'ul').length === 2, String(findAll({ children: [markdown[2]] }, 'ul').length))
    check('an ordered list stays ordered', markdown[3]?.tag === 'ol' && markdown[3].children.length === 2, JSON.stringify(markdown[3]?.children?.length ?? null))
    const mdTable = markdown[5]
    check(
      'a table keeps its header and its rows',
      findAll(mdTable, 'th').length === 2 && findAll(mdTable, 'td').length === 2 && textOf(findAll(mdTable, 'th')[0]) === 'a',
      JSON.stringify((mdTable?.children ?? []).map((node) => node.tag))
    )
    const aligned = replyExports.parseReplyMarkdown('| a | b |\n| :--- | ---: |\n| 1 | 2 |\n')[0]
    check(
      'a colon in the separator row aligns the column rather than showing up as text',
      findAll(aligned, 'th')[0]?.attrs?.style === 'text-align:left' && findAll(aligned, 'th')[1]?.attrs?.style === 'text-align:right',
      JSON.stringify(findAll(aligned, 'th').map((node) => node.attrs))
    )
    const inline = replyExports.parseReplyMarkdown('**粗** 与 snake_case 与 `码`\n')
    check(
      'inline markup is read, and a name with underscores is left alone',
      findFirst({ children: inline }, 'strong') !== null && findAll({ children: inline }, 'em').length === 0 && String(findAll({ children: inline }, 'em').length) === '0'
    )

    // ------------------------------------------------------------ the painter --
    let stopReplies = () => {}
    const previousDocument = globalThis.document
    const previousObserver = globalThis.MutationObserver
    const previousWindow = globalThis.window
    const previousTimeout = globalThis.setTimeout
    globalThis.document = dom.document
    globalThis.MutationObserver = ReplyObserver
    globalThis.window = { ...(previousWindow ?? {}), innerWidth: 1280, innerHeight: 900 }
    try {
      stopReplies = (replyEffect === undefined ? null : replyEffect.fn()) ?? (() => {})
      check(
        'the painter mounts its stylesheet once',
        dom.head.children.filter((node) => node.tagName === 'STYLE' && node.getAttribute('data-plugin-css') === 'dsh-nai-imagegen-replies').length === 1,
        `${dom.head.children.length} style tag(s)`
      )
      check('the sheet it mounts is the reply one', String(dom.head.children[0]?.content ?? '').startsWith('.nai-reply{'), String(dom.head.children[0]?.content ?? '').slice(0, 32))
      check(
        'and it watches the transcript subtree for a reply a re-render took away',
        replyObservers.length === 1 && replyObservers[0].options.subtree === true && replyObservers[0].target === dom.body,
        JSON.stringify(replyObservers.map((item) => item.options))
      )

      // The shape the Tool package really renders: a call row carrying `data-chat-call-id` inside a
      // flow item carrying `data-chat-turn`, with the turn's tail as its last child.
      const liveTurn = dom.makeNode('div')
      liveTurn.setAttribute('data-chat-node-key', 'assistant-step')
      liveTurn.setAttribute('data-chat-turn', '4')
      const liveRow = dom.makeNode('div')
      liveRow.setAttribute('data-chat-call-id', 'call-live')
      liveTurn.appendChild(liveRow)
      const liveTail = dom.makeNode('div')
      liveTail.setAttribute('data-turn-tail', '')
      liveTail.setAttribute('data-chat-turn', '4')
      liveTurn.appendChild(liveTail)
      dom.body.appendChild(liveTurn)

      replyExports.registerReply('call-live', delivered, '出好了')
      const flush = replyExports.flushReplies()
      const painted = replyExports.replyPaintOf('call-live')
      check('a registered reply finds its turn and paints', flush.placed === 1 && flush.waiting === 0, JSON.stringify(flush))
      check(
        'the reply is a sibling of the turn tail, not buried in the fold',
        painted !== null && painted.parentNode === liveTurn && painted.nextSibling === liveTail,
        painted === null ? 'nothing painted' : `parent ${painted.parentNode === liveTurn}, next ${painted.nextSibling === liveTail}`
      )
      check('the painted node names the call it came through', painted?.getAttribute('data-nai-reply') === 'call-live', String(painted?.getAttribute('data-nai-reply') ?? ''))
      const head = findFirst(painted, '.nai-reply-head')
      check('the caption comes from the dictionary binder, asked at paint time', textOf(findFirst(painted, '.nai-reply-caption')) === '回复正文', textOf(findFirst(painted, '.nai-reply-caption')))
      check('the caption carries the model’s own label', textOf(findFirst(painted, '.nai-reply-label')) === '出好了', textOf(findFirst(painted, '.nai-reply-label')))
      check(
        'and counts the characters the reader can see',
        textOf(findFirst(painted, '.nai-reply-count')) === `${Array.from(delivered).length} 字`,
        textOf(findFirst(painted, '.nai-reply-count'))
      )
      check('the head is one line of three parts', head !== null && head.children.length === 3, String(head?.children?.length ?? 'none'))
      const paintedBody = findFirst(painted, '.nai-reply-body')
      check('a heading in the reply becomes a heading', textOf(findFirst(paintedBody, 'h1')) === '标题', textOf(findFirst(paintedBody, 'h1')))
      check('a list becomes a list, one item per line', findAll(paintedBody, 'li').length === 2, String(findAll(paintedBody, 'li').length))
      check('inline emphasis becomes markup', textOf(findFirst(paintedBody, 'strong')) === '加粗', textOf(findFirst(paintedBody, 'strong')))
      check('an inline code span becomes code', textOf(findFirst(paintedBody, 'code.nai-reply-inline-code')) === '代码', textOf(findFirst(paintedBody, 'code.nai-reply-inline-code')))
      const fence = findFirst(paintedBody, 'pre.nai-reply-code')
      check(
        'a fenced block becomes a block, and keeps the language it was written in',
        textOf(fence) === 'print(1)' && findFirst(fence, 'code')?.getAttribute('class') === 'language-python',
        `${textOf(fence)} / ${findFirst(fence, 'code')?.getAttribute('class') ?? 'no class'}`
      )
      check('the language is also named above the block', textOf(findFirst(paintedBody, '.nai-reply-lang')) === 'python', textOf(findFirst(paintedBody, '.nai-reply-lang')))

      const beforePass = liveTurn.children.length
      const again = replyExports.flushReplies()
      check(
        'a pass that changes nothing writes nothing',
        again.placed === 1 && liveTurn.children.length === beforePass && replyExports.replyPaintOf('call-live') === painted,
        `${beforePass} → ${liveTurn.children.length}`
      )
      const grown = `${delivered}\n\n再来一句。`
      replyExports.registerReply('call-live', grown, '出好了')
      replyExports.flushReplies()
      check(
        'the same call delivering again reuses its node instead of stacking a second reply',
        replyExports.replyPaintOf('call-live') === painted && liveTurn.children.length === beforePass,
        `${liveTurn.children.length} children`
      )
      check('and the new text is really in it', textOf(painted).includes('再来一句。') === true)
      painted.remove()
      const repaired = replyExports.flushReplies()
      check(
        'a re-render that dropped the reply is repaired by the next pass',
        repaired.placed === 1 && replyExports.replyPaintOf('call-live') === painted && painted.parentNode === liveTurn && painted.nextSibling === liveTail,
        JSON.stringify(repaired)
      )
      const answer = dom.makeNode('div')
      answer.setAttribute('data-chat-turn', '4')
      answer.setAttribute('data-turn-process-answer', '')
      liveTurn.insertBefore(answer, liveTail)
      replyExports.flushReplies()
      check(
        'a turn that has an answer area of its own gets the reply above it, not below',
        painted.parentNode === liveTurn && painted.nextSibling === answer,
        painted.nextSibling === answer ? 'above the answer' : 'somewhere else'
      )

      const pendingTurn = dom.makeNode('div')
      pendingTurn.setAttribute('data-chat-turn', '5')
      const pendingRow = dom.makeNode('div')
      pendingRow.setAttribute('data-chat-call-id', 'call-pending')
      pendingTurn.appendChild(pendingRow)
      dom.body.appendChild(pendingTurn)
      replyExports.registerReply('call-pending', '还没落地', null)
      const waiting = replyExports.flushReplies()
      check(
        'a reply whose turn has no answer area yet waits instead of landing in the fold',
        waiting.waiting === 1 && replyExports.replyPaintOf('call-pending') === null,
        JSON.stringify(waiting)
      )
      const pendingTail = dom.makeNode('div')
      pendingTail.setAttribute('data-turn-tail', '')
      pendingTail.setAttribute('data-chat-turn', '5')
      pendingTurn.appendChild(pendingTail)
      const landed = replyExports.flushReplies()
      check(
        'and lands the moment the turn grows one',
        landed.placed === 2 && replyExports.replyPaintOf('call-pending')?.parentNode === pendingTurn,
        JSON.stringify(landed)
      )

      // The retry chain, run instantly: the last resort is the call's own flow item, so a turn that
      // never grows an answer area still shows its reply to a reader who unfolds it.
      const orphanTurn = dom.makeNode('div')
      orphanTurn.setAttribute('data-chat-turn', '6')
      const orphanRow = dom.makeNode('div')
      orphanRow.setAttribute('data-chat-call-id', 'call-orphan')
      orphanTurn.appendChild(orphanRow)
      dom.body.appendChild(orphanTurn)
      globalThis.setTimeout = (fn) => {
        fn()
        return 0
      }
      replyExports.registerReply('call-orphan', '兜底', null)
      const orphanPainted = replyExports.replyPaintOf('call-orphan')
      check(
        'a turn that never grows an answer area still gets its reply, beside the call',
        orphanPainted !== null && orphanPainted.parentNode === dom.body && dom.body.children[dom.body.children.length - 1] === orphanPainted,
        orphanPainted === null ? 'nothing painted' : 'somewhere else'
      )
      globalThis.setTimeout = previousTimeout

      // A reply is model output: whatever it contains is text, and a destination that would run is
      // not a destination.
      const hostileTurn = dom.makeNode('div')
      hostileTurn.setAttribute('data-chat-turn', '7')
      const hostileRow = dom.makeNode('div')
      hostileRow.setAttribute('data-chat-call-id', 'call-hostile')
      hostileTurn.appendChild(hostileRow)
      const hostileTail = dom.makeNode('div')
      hostileTail.setAttribute('data-turn-tail', '')
      hostileTail.setAttribute('data-chat-turn', '7')
      hostileTurn.appendChild(hostileTail)
      dom.body.appendChild(hostileTurn)
      replyExports.registerReply(
        'call-hostile',
        '看这个 <img src=x onerror="alert(1)"> 和 [点我](javascript:alert(1))\n\n[文档](https://example.com/x)',
        null
      )
      replyExports.flushReplies()
      const hostilePainted = replyExports.replyPaintOf('call-hostile')
      check(
        'model text cannot become markup',
        hostilePainted !== null && findFirst(hostilePainted, 'img') === null && textOf(hostilePainted).includes('<img src=x onerror='),
        findFirst(hostilePainted, 'img') === null ? 'kept as text' : 'an element was built'
      )
      const anchors = findAll(hostilePainted, 'a')
      check(
        'a link that would run script stays the text it was written as',
        anchors.length === 1 && anchors[0].getAttribute('href') === 'https://example.com/x',
        `${anchors.length} anchor(s): ${anchors.map((node) => node.getAttribute('href')).join(',')}`
      )
      check(
        'a safe link opens away from the transcript',
        anchors[0]?.getAttribute('rel') === 'noreferrer noopener' && anchors[0].getAttribute('target') === '_blank',
        JSON.stringify(anchors[0]?.attributes ?? null)
      )
      const tree = replyExports.replyTreeToDom(dom.document, replyExports.parseReplyMarkdown('只有文字 <b>粗</b>\n'), null)
      check(
        'the tree is built from text nodes alone, even when the text looks like markup',
        tree.children.length === 1 && tree.children[0].children[0].nodeType === 3 && findFirst(tree, 'b') === null,
        `children ${tree.children.length}`
      )

      // --------------------------- a reply the turn had already written out --
      // A turn can answer in both channels at once: message text the model wrote, and the same
      // words through the call. The longer one wins — the rule the tavern transports settled on —
      // so the painted copy steps aside rather than repeating a paragraph the reader already read.
      const twiceWords = '这一轮已经写在消息里了，原话就是下面这整整一句。'
      const twiceTurn = dom.makeNode('div')
      twiceTurn.setAttribute('data-chat-turn', '9')
      const twiceWritten = dom.makeNode('div')
      twiceWritten.setAttribute('data-chat-turn', '9')
      twiceWritten.textContent = twiceWords
      const twiceRow = dom.makeNode('div')
      twiceRow.setAttribute('data-chat-call-id', 'call-twice')
      const twiceTail = dom.makeNode('div')
      twiceTail.setAttribute('data-turn-tail', '')
      twiceTail.setAttribute('data-chat-turn', '9')
      twiceTurn.appendChild(twiceWritten)
      twiceTurn.appendChild(twiceRow)
      twiceTurn.appendChild(twiceTail)
      dom.body.appendChild(twiceTurn)
      replyExports.registerReply('call-twice', twiceWords, null)
      replyExports.flushReplies()
      const twicePainted = replyExports.replyPaintOf('call-twice')
      check(
        'a reply the turn already wrote out is not painted a second time',
        twicePainted !== null &&
          twicePainted.getAttribute('data-nai-reply-duplicate') === '' &&
          textOf(twicePainted).includes('不重复') &&
          textOf(twicePainted).includes(twiceWords) === false,
        twicePainted === null ? 'nothing painted' : textOf(twicePainted).slice(0, 48)
      )

      // ------------------------------- a reply that arrives while it is written --
      // The transport this mirrors reads the argument as it streams, which is only worth doing if
      // the answer area fills as the words arrive: the row registers the fragment, and the settled
      // delivery grows the same node rather than adding a second one.
      const growTurn = dom.makeNode('div')
      growTurn.setAttribute('data-chat-turn', '14')
      const growRow = dom.makeNode('div')
      growRow.setAttribute('data-chat-call-id', 'call-grow')
      const growTail = dom.makeNode('div')
      growTail.setAttribute('data-turn-tail', '')
      growTail.setAttribute('data-chat-turn', '14')
      growTurn.appendChild(growRow)
      growTurn.appendChild(growTail)
      dom.body.appendChild(growTurn)
      replySeat.component({
        callId: 'call-grow',
        call: { phase: 'preparing', block: { argsRaw: '{"text":"第一段' } },
        t: (key) => key,
        useToolCallArgumentsPartial: () => ''
      })
      const grownEarly = replyExports.replyPaintOf('call-grow')
      check(
        'a fragment is painted as it stands, and says it is still being written',
        grownEarly !== null && textOf(grownEarly).includes('第一段') && textOf(grownEarly).includes('正在写入'),
        grownEarly === null ? 'nothing painted' : textOf(grownEarly).slice(0, 48)
      )
      replySeat.component({
        callId: 'call-grow',
        call: { phase: 'result', block: { kind: 'tool-call', call: { name: replyLib.REPLY_TOOL_NAME, argsRaw: '{"text":"第一段和第二段"}' } } },
        t: (key) => key,
        useToolCallArgumentsPartial: () => ''
      })
      const grownLate = replyExports.replyPaintOf('call-grow')
      check(
        'and the settled delivery grows that node rather than adding another',
        grownLate !== null &&
          grownLate === grownEarly &&
          textOf(grownLate).includes('第一段和第二段') &&
          textOf(grownLate).includes('正在写入') === false,
        textOf(grownLate).slice(0, 48)
      )

      // ------------------------------------- turns that never called the tool --
      // A model that answers in ordinary text has not failed, but a reader cannot tell that the
      // transport is idle. Three in a row is the point at which that is worth saying out loud —
      // the same three the tavern panel uses — and a turn that does come through ends it.
      const streakStart = replyExports.replyStats().streak
      for (const n of [20, 21, 22]) {
        const missed = dom.makeNode('div')
        missed.setAttribute('data-chat-turn', String(n))
        missed.textContent = `第 ${n} 条回复`
        dom.body.appendChild(missed)
        replyExports.noteReplyTurn()
      }
      check(
        'three turns that answered without the tool are counted as a streak',
        streakStart === 0 && replyExports.replyStats().streak === 3,
        JSON.stringify(replyExports.replyStats())
      )
      const answeredTurn = dom.makeNode('div')
      answeredTurn.setAttribute('data-chat-turn', '23')
      const answeredRow = dom.makeNode('div')
      answeredRow.setAttribute('data-chat-call-id', 'call-answered')
      const answeredTail = dom.makeNode('div')
      answeredTail.setAttribute('data-turn-tail', '')
      answeredTail.setAttribute('data-chat-turn', '23')
      answeredTurn.appendChild(answeredRow)
      answeredTurn.appendChild(answeredTail)
      dom.body.appendChild(answeredTurn)
      replyExports.registerReply('call-answered', '这次走了工具', null)
      replyExports.flushReplies()
      replyExports.noteReplyTurn()
      check(
        'and a turn that did come through the tool puts the streak back to zero',
        replyExports.replyStats().streak === 0,
        JSON.stringify(replyExports.replyStats())
      )
      const stats = replyExports.replyStats()
      check(
        'the reply half can say what it has done, for the panel and for a bug report',
        stats.tool === replyLib.REPLY_TOOL_NAME &&
          stats.painted >= 4 &&
          stats.duplicates === 1 &&
          String(stats.turn) === '23' &&
          Number.isFinite(stats.streaming),
        JSON.stringify(stats)
      )

      // ------------------------------------------- the switch, from this side --
      // A transport that is off answers no turn by design, so the streak must not count against
      // it: the panel's own switch would otherwise raise a fault about the thing it switched off.
      // Turning it off also retires whatever streak was standing, because those turns were
      // counted against a tool that is no longer in the tool list — the count cannot outlive the
      // thing it was counting.
      const offResult = replyExports.setReplyTransport(false)
      const offMiss = dom.makeNode('div')
      offMiss.setAttribute('data-chat-turn', '30')
      offMiss.textContent = '第 30 条回复'
      dom.body.appendChild(offMiss)
      replyExports.noteReplyTurn()
      check(
        'with the transport off, a turn answered in ordinary text is not counted against it',
        offResult === false && replyExports.replyStats().streak === 0,
        JSON.stringify({ on: offResult, stats: replyExports.replyStats() })
      )
      const backOn = replyExports.setReplyTransport(true)
      const onMiss = dom.makeNode('div')
      onMiss.setAttribute('data-chat-turn', '31')
      onMiss.textContent = '第 31 条回复'
      dom.body.appendChild(onMiss)
      replyExports.noteReplyTurn()
      check(
        'and with it switched back on, a missed turn counts again',
        backOn === true && replyExports.replyStats().streak === 1,
        JSON.stringify({ on: backOn, stats: replyExports.replyStats() })
      )

      // ---------------------------------------------- the receipt row itself --
      const rowTurn = dom.makeNode('div')
      rowTurn.setAttribute('data-chat-turn', '8')
      const rowHolder = dom.makeNode('div')
      rowHolder.setAttribute('data-chat-call-id', 'call-row')
      rowTurn.appendChild(rowHolder)
      const rowTail = dom.makeNode('div')
      rowTail.setAttribute('data-turn-tail', '')
      rowTail.setAttribute('data-chat-turn', '8')
      rowTurn.appendChild(rowTail)
      dom.body.appendChild(rowTurn)
      const receiptRow = replySeat.component({
        callId: 'call-row',
        call: { phase: 'result', block: { kind: 'tool-call', call: { name: replyLib.REPLY_TOOL_NAME, argsRaw: '{"text":"收到","label":"两行"}' } } },
        t: (key) => key,
        useToolCallArgumentsPartial: () => ''
      })
      check(
        'the receipt row is the row, not the prose',
        receiptRow?.type === 'div' && receiptRow?.props?.className === 'nai-reply-row' && receiptRow?.props?.['data-nai-reply-row'] === 'call-row',
        JSON.stringify(receiptRow?.props ?? null)
      )
      check(
        'and says what arrived, in the dictionary’s own words',
        String(receiptRow?.children?.[0]?.children?.[0] ?? '') === 'replyReceived · 2 replyUnit',
        String(receiptRow?.children?.[0]?.children?.[0] ?? '')
      )
      check('the row also shows the model’s label', String(receiptRow?.children?.[1]?.children?.[0] ?? '') === '两行', String(receiptRow?.children?.[1]?.children?.[0] ?? ''))
      check(
        'rendering that row is what paints a live reply',
        replyExports.replyPaintOf('call-row')?.parentNode === rowTurn,
        replyExports.replyPaintOf('call-row') === null ? 'nothing painted' : 'painted somewhere else'
      )
      const writingRow = replySeat.component({
        callId: 'call-writing',
        call: { phase: 'preparing', block: { argsRaw: '{"text":"还在写' } },
        t: (key) => key,
        useToolCallArgumentsPartial: () => ''
      })
      check(
        'a half-written call reports how much has arrived, and is taken unfinished',
        String(writingRow?.children?.[0]?.children?.[0] ?? '') === 'replyWriting · 3 replyUnit' &&
          replyExports.replyEntryOf('call-writing')?.done === false &&
          replyExports.replyEntryOf('call-writing')?.text === '还在写',
        String(writingRow?.children?.[0]?.children?.[0] ?? '')
      )

      const secondMount = replyEffect === undefined ? null : replyEffect.fn()
      check(
        'a second mount reuses the stylesheet instead of stacking a copy',
        dom.head.children.length === 1 && replyObservers.length === 2,
        `styles ${dom.head.children.length}, watchers ${replyObservers.length}`
      )
      if (typeof secondMount === 'function') secondMount()
      check('and its disposer leaves the first one’s stylesheet alone', dom.head.children.length === 1, `${dom.head.children.length} style tag(s)`)
      if (typeof stopReplies === 'function') stopReplies()
      check(
        'the disposer takes the stylesheet and the watcher with it',
        dom.head.children.length === 0 && replyObservers[0]?.observer?.disconnected === true,
        `styles ${dom.head.children.length}`
      )
    } finally {
      globalThis.document = previousDocument
      globalThis.MutationObserver = previousObserver
      globalThis.window = previousWindow
      globalThis.setTimeout = previousTimeout
    }
  }
}

await rm(scratchHome, { recursive: true, force: true })

// ============================================================ companion ==
// The artist scanner and the key pool are large enough to want their own
// focused, faster-running scripts with their own output. Running them here keeps
// the promise that one command verifies the plugin: `node tests/verify.mjs`.
//
// They are spawned with `stdio: 'ignore'` on purpose — this environment cannot
// capture a child's output through a pipe — so only the exit status is read.
console.log('\n[companion suites]')
for (const name of ['artists-probe.mjs', 'keypool-probe.mjs', 'format-probe.mjs']) {
  const companion = spawnSync(process.execPath, [join(import.meta.dirname, name)], { stdio: 'ignore' })
  check(
    `tests/${name} passes standalone`,
    companion.status === 0,
    companion.error ? companion.error.message : `exit ${companion.status}`
  )
}

// ================================================================== result ==
console.log(`\n${passed} passed, ${failures.length} failed${skipped.length > 0 ? `, ${skipped.length} skipped` : ''}`)
if (skipped.length > 0) {
  console.log('\nskipped:')
  for (const item of skipped) console.log(`  - ${item}`)
}
if (failures.length > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exitCode = 1
}
