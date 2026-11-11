/**
 * Scratch probe for the `<image>` block parser, run against the real examples
 * embedded in the world book rather than hand-written ones.
 *
 * Usage: node tests/format-probe.mjs [path-to-worldbook.json]
 */
import { readFile } from 'node:fs/promises'
import { parseImageBlock, looksLikeImageBlock, maybeParseImageBlock } from '../lib/format.js'

const SOURCE = process.argv[2] ?? '<模板文件>'

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

let doc
try {
  doc = JSON.parse(await readFile(SOURCE, 'utf8'))
} catch (error) {
  // The world book is the user's file, not part of the package, so a machine
  // without it skips rather than fails.
  console.log(`skipped: cannot read ${SOURCE} (${error.code ?? error.message})`)
  process.exit(0)
}
const entries = Object.values(doc.entries)
// Every `<image>…</image>` block the book actually contains.
const blocks = []
for (const entry of entries) {
  const content = String(entry.content ?? '')
  const matches = content.match(/<image>[\s\S]*?<\/image>/gi) ?? []
  for (const block of matches) blocks.push({ entry: entry.comment, block })
}

console.log(`source: ${SOURCE}`)
console.log(`found ${blocks.length} real <image> blocks in ${entries.length} entries\n`)

check('the book really does contain blocks to test against', blocks.length >= 5, String(blocks.length))

console.log('\n[1] every real block parses')
const parsed = []
for (const { entry, block } of blocks) {
  const result = parseImageBlock(block, { width: 832, height: 1216 })
  parsed.push({ entry, block, result })
}
check('every block parsed successfully', parsed.every((row) => row.result.ok), parsed.filter((row) => !row.result.ok).map((row) => row.result.reason).join('; '))

console.log('\n[2] no format scaffolding reaches the prompt')
/** Everything that would be rendered as literal text if it leaked through. */
const NOISE = [
  ['an <image> tag', /<\/?image\b/i],
  ['an <image_think> block', /image_think/i],
  ['the image### header', /image\s*#{2,}/i],
  ['a field label', /(?:^|[\s,])(?:Scene|Char\d*)(?:\s+UC)?\s*:/],
  ['the ### terminator', /#{2,}/],
  ['a trailing semicolon', /;\s*$/],
  ['a centers marker', /\|\s*centers/i],
  ['an unresolved getvar', /\{\{\s*get(?:var)?\s*::/i],
  ['a size directive', /size\s*:\s*\d+\s*[x×]/i]
]
for (const [name, pattern] of NOISE) {
  const offenders = parsed.filter((row) => row.result.ok && pattern.test(row.result.prompt))
  check(`no ${name} in any prompt`, offenders.length === 0, offenders.map((row) => row.entry).join(', '))
  const negativeOffenders = parsed.filter((row) => row.result.ok && pattern.test(row.result.negativePrompt))
  check(`no ${name} in any negative`, negativeOffenders.length === 0, negativeOffenders.map((row) => row.entry).join(', '))
}

console.log('\n[3] the content that matters survives')
// `[NAI V5] 格式` is the format specification itself rather than a filled-in
// example: its block still carries the book's own placeholders, so it is the one
// block that legitimately has almost no prompt text.
const isTemplate = (entry) => /格式$/.test(entry)
for (const row of parsed) {
  if (!row.result.ok) continue
  if (isTemplate(row.entry)) {
    check(`「${row.entry}」 is treated as the spec, not an example`, row.result.prompt.length < 40, `${row.result.prompt.length} chars`)
    check(
      'the spec block is flagged as still holding placeholders',
      row.result.notes.some((note) => /占位符/.test(note)),
      row.result.notes.join('; ')
    )
    continue
  }
  check(
    `「${row.entry}」 keeps real prompt text`,
    /[a-z_]{3}/.test(row.result.prompt) && row.result.prompt.length > 40,
    `${row.result.prompt.length} chars`
  )
}
check(
  'every size is a legal NovelAI axis',
  parsed.every((row) => row.result.width % 64 === 0 && row.result.height % 64 === 0),
  parsed.map((row) => `${row.result.width}x${row.result.height}`).join(',')
)
/** The orientation word the block's own placeholder asked for, if any. */
const askedOrientation = (block) => /尺寸([^}]*)\}\}/.exec(block)?.[1] ?? ''
check(
  'the orientation named in the placeholders is respected',
  parsed.every((row) => {
    const name = askedOrientation(row.block)
    if (/方/.test(name)) return row.result.width === row.result.height
    if (/横/.test(name)) return row.result.width > row.result.height
    if (/竖/.test(name)) return row.result.height > row.result.width
    return true
  }),
  parsed.map((row) => `${askedOrientation(row.block) || '-'}=${row.result.width}x${row.result.height}`).join(' ')
)
check(
  'an unresolved placeholder is reported rather than swallowed',
  parsed
    .filter((row) => row.result.sizeSource === 'orientation')
    .every((row) => row.result.notes.some((note) => /orientation/.test(note))),
  ''
)
check(
  'a literal size directive wins outright',
  parsed
    .filter((row) => /size\s*:\s*\d+\s*[x×]\s*\d+/i.test(row.block))
    .every((row) => row.result.sizeSource === 'block'),
  parsed.map((row) => `${row.result.width}x${row.result.height}:${row.result.sizeSource}`).join(' ')
)
check(
  'negatives are separated from the positive',
  parsed.every((row) => row.result.negativePrompt.length > 0),
  parsed.map((row) => row.result.negativePrompt.length).join(',')
)
check(
  'the character-position markers are captured, not dropped',
  parsed.some((row) => row.result.characters.some((character) => (character.centers ?? []).length > 0)),
  parsed.flatMap((row) => row.result.characters.map((c) => `${c.label}=${JSON.stringify(c.centers)}`)).join(' ')
)

console.log('\n[3b] each character keeps its own negative')
// `Char1 UC:brown hair,headset` exists to stop *that* character growing the other
// one's features. Pooling the UCs into one global negative would suppress brown
// hair and headsets everywhere — including on the character that legitimately has
// them, which is backwards. So the pairing is asserted rather than assumed.
{
  const multi = parsed.filter((row) => row.result.characters.length >= 2)
  check('the book has blocks with more than one character', multi.length > 0, String(multi.length))
  check(
    'every parsed character carries a negative field',
    multi.every((row) => row.result.characters.every((character) => typeof character.negative === 'string'))
  )
  const withNegatives = multi.filter((row) => row.result.characters.every((character) => character.negative !== ''))
  check('the real blocks give each character a non-empty UC', withNegatives.length > 0, `${withNegatives.length} of ${multi.length}`)
  const paired = withNegatives[0]
  if (paired !== undefined) {
    const firstTokens = paired.result.characters.map((character) => character.negative.split(',')[0].trim()).filter((t) => t !== '')
    check(
      'the scene-only negative excludes the per-character UCs',
      !firstTokens.some((token) => paired.result.sceneNegative.includes(token)),
      `scene: ${paired.result.sceneNegative.slice(0, 80)}`
    )
    check(
      'the scene-only positive excludes the character captions',
      !paired.result.characters.some((character) => paired.result.sceneCaption.includes(character.text.slice(0, 24))),
      `scene: ${paired.result.sceneCaption.slice(0, 80)}`
    )
    check(
      'the joined negative still holds every UC, for models without the split',
      firstTokens.every((token) => paired.result.negativePrompt.includes(token)),
      `tokens: ${firstTokens.join(' / ')}`
    )
  }
}

console.log('\n[4] a real block, before and after')
{
  const sample = parsed.find((row) => row.result.ok && row.result.characters.some((c) => c.centers === 'C3')) ?? parsed.find((row) => row.result.ok)
  console.log(`  --- raw (first 300 chars of「${sample.entry}」) ---`)
  console.log(`  ${sample.block.replace(/\s+/g, ' ').slice(0, 300)}`)
  console.log('  --- parsed ---')
  console.log(`  size      : ${sample.result.width}x${sample.result.height}`)
  console.log(`  prompt    : ${sample.result.prompt.slice(0, 220)}`)
  console.log(`  negative  : ${sample.result.negativePrompt.slice(0, 160)}`)
  console.log(`  length    : +${sample.result.prompt.length} / -${sample.result.negativePrompt.length}`)
  console.log(`  chars     : ${sample.result.characters.map((c) => `${c.label}[centers=${c.centers}]`).join(' ')}`)
  console.log(`  notes     : ${sample.result.notes.join('; ') || '(none)'}`)
}

console.log('\n[5] tolerance')
check('a block with no <image_think> still parses', parseImageBlock('image###size:1024x1024;\nScene:1girl, solo, smile;\nScene UC:bad anatomy;###').ok)
check(
  'a block with no envelope still parses',
  parseImageBlock('<image>\nScene:1girl, solo, smile;\nScene UC:bad anatomy;\n</image>').ok
)
check('a plain prompt is not mistaken for a block', !looksLikeImageBlock('1girl, solo, looking at viewer'))
check('a plain prompt parses to null', maybeParseImageBlock('1girl, solo, looking at viewer') === null)
check('a bare tag list inside <image> still parses', parseImageBlock('<image>1girl, solo, smile</image>').ok)
check('an empty string is refused', !parseImageBlock('').ok)
check('a wrapper with only text inside is taken as a bare prompt', parseImageBlock('<image>just some words</image>').prompt === 'just some words')
check('an empty wrapper is refused', !parseImageBlock('<image>   </image>').ok)
check(
  'a missing size falls back to the caller',
  parseImageBlock('<image>Scene:1girl</image>', { width: 640, height: 960 }).width === 640
)
{
  const fallback = parseImageBlock('<image>Scene:1girl</image>', { width: 640, height: 960 })
  check('the fallback is noted rather than silent', fallback.notes.some((note) => /no size directive/.test(note)), fallback.notes.join(';'))
}
check(
  'an unterminated think section is stripped too',
  !/image_think/i.test(parseImageBlock('<image>\n<image_think>thinking...\nimage###size:832x1216;\nScene:1girl, solo;###').prompt)
)

console.log(`\n${failures === 0 ? 'format parser checks passed' : `${failures} FAILED`}`)
if (failures > 0) process.exitCode = 1
