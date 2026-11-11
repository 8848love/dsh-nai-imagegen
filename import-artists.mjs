/**
 * dsh-nai-imagegen — build the artist index from an archive.
 *
 * A one-off (and re-runnable) utility rather than something the plugin does at
 * startup: the source archive is 217 MB, and re-scanning it every boot would be
 * absurd. The plugin reads the index; this writes it.
 *
 * The archive itself stays the single source of truth for the images. Nothing is
 * copied: the index records each reference image's byte range inside the source
 * file, and the plugin reads those ranges on demand.
 *
 * Usage:
 *   node import-artists.mjs <archive.json> [index.json]
 *
 * Defaults to `$DSH_HOME/nai-imagegen/artists/index.json`.
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildIndex } from './lib/artists.js'

const ROW_ID = 'nai-imagegen'
const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')

const source = process.argv[2]
if (!source) {
  console.error('usage: node import-artists.mjs <archive.json> [index.json]')
  process.exit(2)
}
const indexPath = resolve(process.argv[3] ?? join(HOME, ROW_ID, 'artists', 'index.json'))

console.log(`source : ${resolve(source)}`)
console.log(`index  : ${indexPath}`)
const started = Date.now()
const summary = await buildIndex({ sourceFile: resolve(source), indexPath })
const seconds = ((Date.now() - started) / 1000).toFixed(1)

console.log(`\nindexed ${summary.count} artists in ${seconds}s`)
console.log(`  with a reference image : ${summary.withImages}`)
console.log(`  without one            : ${summary.count - summary.withImages}`)
console.log(`  kept their old id      : ${summary.preserved}`)
console.log(`  new, numbered after    : ${summary.added}`)
if (summary.skipped.length > 0) {
  console.log(`  skipped                : ${summary.skipped.length}`)
  for (const row of summary.skipped.slice(0, 5)) console.log(`    @${row.offset}  ${row.reason}`)
}
const heapMb = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0)
console.log(`  heap in use at the end : ${heapMb} MB`)
