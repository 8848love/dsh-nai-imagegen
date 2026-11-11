/**
 * Scratch probe for the artist archive scanner, kept out of the main suite so it
 * can be iterated on without re-running everything. Its assertions are folded
 * into `tests/verify.mjs` once settled.
 *
 * Usage: node tests/artists-probe.mjs
 */
import { writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync, crc32 } from 'node:zlib'
import { scanArchive, buildIndex, loadIndex, readArtistImage, searchArtists } from '../lib/artists.js'

/**
 * Build one PNG chunk.
 * @param type - the chunk type.
 * @param data - the payload.
 * @returns the encoded chunk.
 */
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td) >>> 0)
  return Buffer.concat([len, td, crc])
}

/**
 * Build a small valid PNG whose content depends on the seed.
 * @param seed - fill byte.
 * @returns the encoded PNG.
 */
const makePng = (seed) => {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(8, 0)
  ihdr.writeUInt32BE(8, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc(8 * (1 + 8 * 4), seed)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const pngA = makePng(0x11)
const pngB = makePng(0x77)
// Record 2 deliberately carries braces, a bracket and an escaped quote inside a
// string: a scanner that ignores string state would end the record early.
const tricky = 'a {brace} and a ] bracket and a \\"quote\\" here'
const records = [
  { name: '24新画风', sequence: 93, positivePrompt: '1.35::Editorial::, anime', negativePrompt: 'bad hands', chamipositivePrompt: '', chaminegativePrompt: '', referenceImage: `data:image/png;base64,${pngA.toString('base64')}` },
  { name: '古风「引号」', sequence: 12, positivePrompt: tricky, negativePrompt: '', chamipositivePrompt: '', chaminegativePrompt: '', referenceImage: `data:image/png;base64,${pngB.toString('base64')}` },
  { name: '无图条目', sequence: 5, positivePrompt: 'nothing here', negativePrompt: '', chamipositivePrompt: '', chaminegativePrompt: '', referenceImage: '' }
]

const dir = await mkdtemp(join(tmpdir(), 'artists-'))
const source = join(dir, 'archive.json')
await writeFile(source, JSON.stringify(records, null, 1), 'utf8')

// Sweep the read window. Tiny chunks force records to straddle many boundaries,
// which is where the first version of this scanner broke: it re-scanned the
// carried bytes while `depth` already reflected them, so depth ran away and
// every record after the first boundary was dropped.
console.log('--- chunk-size sweep ---')
for (const chunkBytes of [1, 2, 3, 7, 16, 37, 64, 255, 1024, 8 * 1024 * 1024]) {
  const indexPath = join(dir, `index-${chunkBytes}.json`)
  let seen = 0
  await scanArchive({ sourceFile: source, chunkBytes, onRecord: () => { seen += 1 } })
  const summary = await buildIndex({ sourceFile: source, indexPath, chunkBytes })
  const loaded = await loadIndex(indexPath)
  const first = loaded.entries.find((entry) => entry.name.startsWith('24'))
  const second = loaded.entries.find((entry) => entry.name.startsWith('古风'))
  const imageA = await readArtistImage({ sourceFile: source, image: first.image })
  const imageB = await readArtistImage({ sourceFile: source, image: second.image })
  const ok =
    seen === 3 &&
    summary.count === 3 &&
    summary.withImages === 2 &&
    summary.skipped.length === 0 &&
    second.positivePrompt === tricky &&
    imageA.equals(pngA) &&
    imageB.equals(pngB)
  console.log(`  chunk=${String(chunkBytes).padStart(8)}  records=${seen}  indexed=${summary.count}  images=${summary.withImages}  ${ok ? 'OK' : 'FAIL'}`)
}

console.log('--- details at chunk=16 ---')
const small = join(dir, 'index-small.json')
await buildIndex({ sourceFile: source, indexPath: small, chunkBytes: 16 })
const loaded = await loadIndex(small)
console.log(`names                : ${loaded.entries.map((entry) => entry.name).join(' | ')}`)
console.log(`ordered by sequence  : ${loaded.entries.map((entry) => entry.sequence).join(',')}`)
console.log(`search「无图」        : ${searchArtists(loaded, '无图').length}`)
console.log(`search「画风」        : ${searchArtists(loaded, '画风').length}`)
console.log(`no-image entry       : ${await readArtistImage({ sourceFile: source, image: null }) === null}`)

await rm(dir, { recursive: true, force: true })

