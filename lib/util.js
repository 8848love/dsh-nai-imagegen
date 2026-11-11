/**
 * dsh-nai-imagegen — pure helpers shared by the Host half and its tests.
 *
 * Kept free of DSH imports on purpose: `index.js` pulls in
 * `@deepseek-ai/dsh-tools`, which only resolves inside the DSH host, so anything
 * that must be unit-testable offline lives here instead.
 */
import { join, resolve, sep } from 'node:path'

/**
 * Render a digest of one library lookup result.
 *
 * The layout is deliberate: the header line carries everything needed to cite
 * the hit, and the body is reproduced verbatim because the libraries encode
 * their own conventions (`a/b/c` pick-one, `a,b,c` together, `[x]` placeholder).
 * Paraphrasing them here would lose that.
 *
 * @param result - a `lookup` or `resolveCharacter` result.
 * @returns the text the model sees.
 */
export function digest(result) {
  const hits = Array.isArray(result?.hits) ? result.hits : []
  if (hits.length === 0) {
    const known = (result?.libraries ?? []).map((row) => `${row.library}(${row.entries})`).join('、')
    if (!known) return '没有命中，且索引目录为空——先运行 nai_index 建索引。'
    // Naming what was actually searched matters: this used to report an empty
    // index directory for a roster miss, which sends the reader off to rebuild an
    // index that was fine.
    const scope = result?.library === undefined ? '已索引的库' : `「${result.library}」名册`
    return [
      `没有命中。${scope}：${known}`,
      result?.note ?? '',
      '换一种写法试试（英文官方 tag、罗马音、别名），或用 nai_lookup 做全文检索。'
    ]
      .filter((line) => line !== '')
      .join('\n')
  }
  const lines = hits.map((hit) => {
    // Derived when a source omits it, so a shape mismatch cannot print
    // "undefined 字符" in a header.
    const chars = hit.chars ?? String(hit.content ?? '').length
    const label = hit.library === undefined ? '' : `${hit.library} `
    const head = `【${label}#${hit.uid ?? '?'}】${hit.title ?? ''}${hit.keys ? `  ⟨${hit.keys}⟩` : ''}  (${chars} 字符)`
    return `${head}\n${hit.content ?? ''}`
  })
  const total = result?.total === undefined ? '' : `\n—— 共命中 ${result.total} 条，返回前 ${hits.length} 条 ——`
  return `${lines.join('\n\n')}${total}`
}

/**
 * Resolve a client-supplied file name inside a directory, refusing anything that
 * is not a plain file name.
 *
 * Three layers, deliberately loud rather than quietly tolerant:
 *
 *   1. separators are normalised and the name must equal its own basename, so
 *      `..\..\x.png` is rejected as a path rather than silently reinterpreted as
 *      `x.png` — a security boundary should say no, not guess;
 *   2. `.`, `..` and an empty name are rejected outright;
 *   3. the resolved path is re-checked against the root, which is belt and
 *      braces for anything a platform quirk could slip past step 1.
 *
 * @param dir - the directory the file must live in.
 * @param name - the requested name.
 * @returns the absolute path.
 */
export function safeJoin(dir, name) {
  const raw = String(name ?? '').replace(/\\/g, '/')
  const leaf = raw.split('/').pop() ?? ''
  if (!leaf || leaf === '.' || leaf === '..') throw new Error('invalid file name')
  if (raw !== leaf) throw new Error('file name must not contain a path')
  const full = resolve(join(dir, leaf))
  const root = resolve(dir)
  if (full !== root && !full.startsWith(root + sep)) throw new Error('path escapes the output directory')
  return full
}
