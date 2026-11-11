/**
 * lookup-cost-probe — what one `nai_lookup` call actually costs to read.
 *
 * The point of the exercise: the same query at maxChars 0 / 600 / 1800 / full,
 * measured in characters, so the cheap path has a number attached to it rather
 * than a claim. Prints one line per configuration.
 *
 * Usage: node tests/lookup-cost-probe.mjs
 */
import { lookup } from '../lib/library.js'
import { digest } from '../lib/util.js'

const libraryDir = process.env.NAI_LIBRARY_DIR || 'C:\\DSH\\绘图知识库\\05_检索索引'
const query = process.argv[2] || '火车便当'
const library = process.argv[3] || '外部画师'
const limit = Number(process.argv[4] || 8)

const configs = [
  { label: 'maxChars=0   预览（只给标题）', maxChars: 0 },
  { label: 'maxChars=600 预览+节选（新默认）', maxChars: 600 },
  { label: 'maxChars=1800（旧默认）', maxChars: 1800 },
  { label: 'full=true    全文', maxChars: 600, full: true }
]

console.log(`query=${query}  library=${library}  limit=${limit}\n`)
for (const { label, ...options } of configs) {
  const result = await lookup(query, { libraryDir, library, limit, ...options })
  const text = digest(result)
  const bodies = result.hits.reduce((sum, hit) => sum + hit.content.length, 0)
  console.log(
    `${label.padEnd(34)} 命中 ${String(result.total).padStart(4)} 条 · 返回 ${String(result.hits.length).padStart(2)} 条 · ` +
      `整体 ${String(text.length).padStart(6)} 字符 · 正文合计 ${String(bodies).padStart(6)} 字符`
  )
}
