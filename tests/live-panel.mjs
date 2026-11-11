/**
 * Live panel check.
 *
 * Every other panel test runs against a scratch configuration or a hand-written
 * fixture. This one renders the sidebar panel against the responses the *running*
 * plugin actually returns, over HTTP, from the real configuration — four real
 * API keys and the real 96-entry artist archive.
 *
 * It is the closest thing to opening the sidebar without a browser: the payloads
 * are genuine, so a mismatch between what the host sends and what the panel reads
 * shows up here instead of as a blank section on screen.
 *
 * Read-only. It never renders an image and never spends Anlas.
 *
 * Usage:
 *   node tests/live-panel.mjs [http://127.0.0.1:19387/nai-imagegen/api]
 *
 * Requires DSH to be running with the plugin loaded.
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASE = process.argv[2] ?? process.env.NAI_PANEL_BASE ?? 'http://127.0.0.1:19387/nai-imagegen/api'

let failures = 0
/**
 * Assert one condition.
 * @param name - what is being checked.
 * @param ok - the observed truth.
 * @param detail - extra text on failure.
 */
const check = (name, ok, detail) => {
  if (!ok) failures += 1
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || detail === undefined || detail === '' ? '' : ` — ${detail}`}`)
}

/**
 * GET a JSON endpoint.
 * @param path - path below the plugin's API root.
 * @returns the parsed body.
 */
const get = async (path) => {
  const response = await fetch(`${BASE}${path}`)
  if (!response.ok) throw new Error(`GET ${path} → HTTP ${response.status}`)
  return response.json()
}

console.log(`live panel check against ${BASE}\n`)

const [status, keys, artists, config] = await Promise.all([
  get('/status'),
  get('/keys'),
  get('/artists?limit=200'),
  get('/config')
])

console.log('[1] the live host answers with what the panel needs')
check('the host reports the new status fields', Object.prototype.hasOwnProperty.call(status, 'keys'), Object.keys(status).join(','))
check('the artist archive is indexed', status.artistCount > 0, String(status.artistCount))
check('the key list carries the pool breadth', status.keySummary?.concurrency >= 1, JSON.stringify(status.keySummary))
check('no token leaks through /status', !JSON.stringify(status).includes('pst-'))
check('no token leaks through /keys', !JSON.stringify(keys).includes('pst-'))
check('a key is described without its secret', (keys.keys ?? []).every((key) => key.token === undefined && typeof key.fingerprint === 'string'))
check('the artist list is non-empty', (artists.artists ?? []).length > 0, String(artists.count))
check('the artist list carries no prompt bodies', (artists.artists ?? []).every((row) => row.positivePrompt === undefined))

// --------------------------------------------------------------- render --
const bundle = await readFile(join(HERE, '..', 'client.js'), 'utf8')
const definition = (() => {
  let captured = null
  const loader = {
    load(entry) {
      captured = entry
    }
  }
  // The bundle is an IIFE that hands its factory to the host's loader.
  const host = { __ModuleLoader__: loader, window: undefined, self: undefined }
  const run = new Function('window', 'self', '__ModuleLoader__', bundle)
  run(host, host, loader)
  return captured
})()

check('the bundle registers itself with the loader', definition !== null && typeof definition.factory === 'function')

/**
 * Render the panel with a stub React and seeded state.
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
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value })
  }
  const exports = definition.factory((name) => {
    if (name === 'react') return stub
    throw new Error(`unexpected external: ${name}`)
  })
  return exports.NaiPanel({ t: (key) => `t:${key}` })
}

/**
 * Collect every string in an element tree.
 * @param node - the tree.
 * @returns the strings.
 */
const flatten = (node, out = []) => {
  if (node === null || node === undefined || typeof node === 'boolean') return out
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

/**
 * Collect every string attribute in an element tree.
 * @param node - the tree.
 * @returns the attribute values.
 */
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

const firstArtist = (artists.artists ?? [])[0]
let tree = null
let crash = null
try {
  tree = renderPanel({ 0: status, 1: config, 9: artists.artists ?? [] })
} catch (error) {
  crash = error
}

console.log('\n[2] the panel renders the live payload')
check('rendering the live payload throws nothing', crash === null, crash === null ? '' : `${crash.message} @ ${(crash.stack ?? '').split('\n')[1]?.trim()}`)
const text = flatten(tree).join(' | ')
const props = flattenProps(tree).join(' | ')

check('the concurrency header shows the live pool breadth', text.includes(`t:concurrency ${status.keySummary.concurrency}`), '')
check('every live key is listed by label', (keys.keys ?? []).every((key) => text.includes(key.label)), (keys.keys ?? []).map((k) => k.label).join(','))
check('every live key shows its fingerprint', (keys.keys ?? []).every((key) => text.includes(key.fingerprint)), '')
check('the live artist total is shown', text.includes(String(status.artistCount)), String(status.artistCount))
check('the live artist list is rendered', firstArtist !== undefined && text.includes(firstArtist.name), firstArtist?.name ?? '')
check('the artist id is rendered too', firstArtist !== undefined && text.includes(`#${firstArtist.id} ${firstArtist.name}`), '')
check('a thumbnail points at the byte-range route', firstArtist !== undefined && props.includes(`/artist-image?id=${firstArtist.id}`), '')

// The remembered artist string has to be *visible* on open, not merely stored:
// the grid is 96 tiles tall, so the card is what actually shows the selection.
/** Occurrences of a substring. */
const countOf = (haystack, needle) => haystack.split(needle).length - 1
if (Number(status.artistId) >= 0 && status.artistName) {
  check(
    'the remembered artist is shown as a card naming it',
    text.includes(`t:artistCurrent：${status.artistName}`),
    `artistId=${status.artistId} name=${status.artistName}`
  )
  check(
    'the card carries the selection its own thumbnail',
    countOf(props, `/artist-image?id=${status.artistId}`) >= 2,
    `${countOf(props, `/artist-image?id=${status.artistId}`)} references for id ${status.artistId}`
  )
} else {
  check('nothing is selected, so no card is rendered', !text.includes('t:artistCurrent：'), `artistId=${status.artistId}`)
}
check('the auto-render toggle reflects the stored setting', status.autoGenerate === true ? text.includes('t:autoOn') : text.includes('t:autoOff'), `autoGenerate=${status.autoGenerate}`)
check('the output directory from the live config is shown', text.includes(String(status.outputDir)), String(status.outputDir))

// ---------------------------------------------------------- thumbnails --
console.log('\n[3] a live reference image really is served')
const imageResponse = await fetch(`${BASE}/artist-image?id=${firstArtist.id}`)
const bytes = Buffer.from(await imageResponse.arrayBuffer())
check('the thumbnail route answers 200', imageResponse.status === 200, String(imageResponse.status))
check('it reports an image content type', String(imageResponse.headers.get('content-type')).startsWith('image/'), String(imageResponse.headers.get('content-type')))
check('it returns real PNG bytes', bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47, bytes.subarray(0, 4).toString('hex'))
check('it is a full-size reference image', bytes.length > 100_000, `${bytes.length} bytes`)

console.log(`\n${failures === 0 ? 'live panel check passed' : `${failures} FAILED`}`)
if (failures > 0) process.exitCode = 1
