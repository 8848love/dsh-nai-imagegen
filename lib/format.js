/**
 * dsh-nai-imagegen — the `<image>` block format.
 *
 * A SillyTavern world book (「文生图」) instructs the model to emit image prompts
 * in a structured block, not as a bare tag list:
 *
 *   <image>
 *   <image_think>
 *   ...the ①~⑦ reasoning...
 *   </image_think>
 *   image###size:832x1216;
 *   Scene:SFW,after fellatio,{1girl},solo.
 *   Middle ground:a gyaru girl leaning back against a graffiti-covered wall...
 *   cowboy shot,front three-quarter view,low-angle,dramatic shadow;
 *   Char1:girl,2::Fujiwara Chika (Kaguya-sama wa Kokurasetai)::,long hair,...sweat|centers:C3;
 *   Char1 UC:feet,shoes,socks,from behind,looking at viewer;
 *   Scene UC:nude,completely nude,nipples,camera;###
 *   </image>
 *
 * Handing that text to NovelAI unchanged renders the labels. So this module
 * separates the four things it actually contains:
 *
 *   1. **Noise to drop** — the `<image>` wrapper, the `image###…;` size header,
 *      the field labels, the `;` separators, and the whole `<image_think>` block,
 *      which is the model reasoning out loud and must never reach the API.
 *   2. **A size request** — `size:832x1216` becomes the render's width and height.
 *   3. **Positive fields** — `Scene:` and `CharN:` in the order written.
 *   4. **Negative fields** — `CharN UC:` and `Scene UC:`, which belong in the
 *      prompt's negative, not in the positive.
 *
 * Field bodies are **multi-line**: the scene above runs over three lines before
 * its terminating `;`. Splitting on newlines would therefore truncate every
 * prompt, so fields are carved out by their labels instead.
 *
 * `|centers:C3` is captured separately rather than dropped. `C3` is NovelAI's own
 * character-position grid (A1 top-left, E5 bottom-right, C3 centre), so the
 * marker is a real positioning request that belongs in the payload, not in the
 * prompt text.
 *
 * Zero external dependencies.
 */

/** Field labels, longest-first so `Scene UC` is not read as `Scene`. */
const FIELD_LABELS = ['Scene UC', 'Scene', 'Char UC', 'Char']

/** Matches a field label at a field boundary. */
const FIELD_PATTERN = /(?:^|[;\n])\s*(Scene\s+UC|Scene|Char\s*\d+\s+UC|Char\s*\d+\s*UC|Char\s*\d+|Char)\s*:\s*/g

/** Anything NovelAI would render as literal text if left in. */
const THINK_PATTERN = /<image_think\b[^>]*>[\s\S]*?<\/image_think\s*>/gi
/** An unterminated `<image_think>` — take everything to the end. */
const THINK_OPEN_PATTERN = /<image_think\b[^>]*>[\s\S]*$/i
/** The `image###…###` envelope. */
const ENVELOPE_PATTERN = /image\s*#{2,}\s*([\s\S]*?)\s*#{2,}/i
/** The wrapper tags. */
const WRAPPER_PATTERN = /<\/?image\b[^>]*>/gi
/** A size directive, e.g. `size:832x1216`. */
const SIZE_PATTERN = /size\s*:\s*(\d{2,5})\s*[x×*]\s*(\d{2,5})/i
/** An unresolved size placeholder, e.g. `{{getvar::尺寸竖图}}`. */
const SIZE_PLACEHOLDER_PATTERN = /\{\{\s*getvar\s*::\s*尺寸([^}]*)\}\}/i
/** A character-position marker, e.g. `|centers:C3` or `|centers:auto`. */
const CENTERS_PATTERN = /\|\s*centers\s*:\s*([^;|]+)/gi
/** An unresolved SillyTavern variable, e.g. `{{getvar::尺寸竖图}}`. */
const PLACEHOLDER_PATTERN = /\{\{\s*(?:get|set)var\s*::[^}]*\}\}/gi

/**
 * Resolve an unresolved size placeholder from the orientation word in its name.
 *
 * The book names its size variables after the shape they mean — `尺寸竖图`
 * (portrait), `尺寸方图` (square), `尺寸横图` (landscape) — so even a template that
 * was never filled in still says which way the image should face. Rather than
 * hard-code the book's pixel choices, this orients whatever size the caller
 * configured, which keeps the user's own default in charge.
 *
 * @param name - the placeholder's name fragment.
 * @param baseWidth - the configured width.
 * @param baseHeight - the configured height.
 * @returns the oriented size, or `null` when the name says nothing about shape.
 */
function orientByName(name, baseWidth, baseHeight) {
  const short = Math.min(baseWidth, baseHeight)
  const long = Math.max(baseWidth, baseHeight)
  if (/竖|长|portrait|tall/i.test(name)) return { width: short, height: long }
  if (/横|宽|wide|landscape/i.test(name)) return { width: long, height: short }
  if (/方|正方|square/i.test(name)) return { width: short, height: short }
  return null
}

/**
 * Whether text carries an `<image>` block or an `image###…###` envelope.
 *
 * Deliberately strict about where the tag sits. Matching the word anywhere would
 * claim an ordinary prompt that merely mentions `<image>` in passing — and since
 * an unreadable block is now refused rather than rendered, that would turn a
 * perfectly valid prompt into an error.
 *
 * @param text - any transcript text.
 * @returns true when the text is in this format.
 */
export function looksLikeImageBlock(text) {
  const value = String(text ?? '')
  // A tag in its own right opening a line — which is what the block looks like,
  // and which may share its line with the envelope as the world book's examples do.
  if (/^[ \t]*<image\b[^>]*>/im.test(value)) return true
  return /image\s*#{2,}/i.test(value)
}

/**
 * Remove the parts of a block that are structure rather than prompt.
 *
 * @param text - the raw block.
 * @returns the text with the reasoning and the envelope removed.
 */
export function stripReasoning(text) {
  return String(text ?? '')
    .replace(THINK_PATTERN, '\n')
    .replace(THINK_OPEN_PATTERN, '\n')
}

/**
 * Tidy one field body into something a prompt can hold.
 *
 * @param body - the raw field body.
 * @returns the cleaned text.
 */
function cleanBody(body) {
  return String(body ?? '')
    .replace(PLACEHOLDER_PATTERN, ' ')
    .replace(/[\r\n]+/g, ' ')
    // The terminator belongs to the format, not to the prompt.
    .replace(/[;\s]*#{2,}\s*$/, '')
    .replace(/[;\s]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+,/g, ',')
    .replace(/,\s*,/g, ',')
    .replace(/^[,\s]+|[,\s]+$/g, '')
    .trim()
}

/**
 * Pull `|centers:…` markers out of a body.
 *
 * @param body - the field body.
 * @returns the body without the markers, and the markers found.
 */
function takeCenters(body) {
  const centers = []
  const stripped = String(body ?? '').replace(CENTERS_PATTERN, (_match, value) => {
    const token = String(value).trim()
    if (token !== '') centers.push(token)
    return ' '
  })
  return { body: stripped, centers }
}

/**
 * Parse an `<image>` block into a render request.
 *
 * Tolerant by design: a hand-written or model-written block may be missing the
 * wrapper, the think section, the size header, or any given field, and a parse
 * that refuses the whole block over one absent label would be useless.
 *
 * @param text - the raw block.
 * @param options - `{ width, height }` fallbacks when the block states no size.
 * @returns the parsed request, or `{ ok: false }` with a reason.
 */
export function parseImageBlock(text, options = {}) {
  const raw = String(text ?? '')
  if (raw.trim() === '') return { ok: false, reason: 'empty input' }
  if (!looksLikeImageBlock(raw)) return { ok: false, reason: 'not an <image> block' }

  const notes = []
  const withoutReasoning = stripReasoning(raw)
  if (withoutReasoning !== raw) notes.push('dropped the <image_think> reasoning')

  // ---- size ---------------------------------------------------------------
  let width = Number(options.width) || 0
  let height = Number(options.height) || 0
  const sizeMatch = SIZE_PATTERN.exec(raw)
  let sizeSource = 'configured'
  if (sizeMatch !== null) {
    width = Number(sizeMatch[1])
    height = Number(sizeMatch[2])
    sizeSource = 'block'
  } else {
    const placeholder = SIZE_PLACEHOLDER_PATTERN.exec(raw)
    const oriented = placeholder === null ? null : orientByName(placeholder[1], width, height)
    if (oriented !== null) {
      width = oriented.width
      height = oriented.height
      sizeSource = 'orientation'
      notes.push(`size came from the orientation in {{getvar::尺寸${placeholder[1]}}}`)
    } else {
      notes.push('no size directive; using the configured size')
    }
  }

  // ---- fields -------------------------------------------------------------
  // Work on the body between `image###` and `###`, falling back to the whole text
  // so a block without the envelope still parses.
  const envelope = ENVELOPE_PATTERN.exec(withoutReasoning)
  const body = envelope !== null ? envelope[1] : withoutReasoning.replace(WRAPPER_PATTERN, '\n')

  const marks = []
  FIELD_PATTERN.lastIndex = 0
  for (;;) {
    const match = FIELD_PATTERN.exec(body)
    if (match === null) break
    marks.push({ label: match[1].replace(/\s+/g, ' ').trim(), start: match.index, end: match.index + match[0].length })
  }
  if (marks.length === 0) {
    // No labels at all. A bare tag list wrapped in `<image>` out of habit is still
    // a perfectly good prompt, so degrade to treating the body as the positive
    // rather than refusing the block outright.
    const bare = cleanBody(body.replace(WRAPPER_PATTERN, ' ').replace(SIZE_PATTERN, ' '))
    if (bare === '') return { ok: false, reason: 'no Scene or Char fields, and no prompt text either' }
    notes.push('no Scene/Char labels; the whole block was taken as the prompt')
    return {
      ok: true,
      prompt: bare,
      negativePrompt: '',
      width,
      height,
      characters: [],
      hasSize: sizeMatch !== null,
      sizeSource,
      notes
    }
  }

  const fields = marks.map((mark, index) => {
    const next = marks[index + 1]
    const sliceEnd = next === undefined ? body.length : next.start
    const rawBody = body.slice(mark.end, sliceEnd)
    const cleaned = cleanBody(rawBody)
    const withCenters = takeCenters(cleaned)
    // Any punctuation a label pattern consumed at the start is already gone.
    return { label: mark.label, text: cleanBody(withCenters.body), centers: withCenters.centers }
  })

  // ---- classify -----------------------------------------------------------
  // Each character's `CharN` and `CharN UC` are paired rather than pooled. That
  // pairing is what makes the format work: `Char1 UC:brown hair,ahoge,headset`
  // exists to stop *Mercy* growing D.Va's features, so treating it as a global
  // negative would suppress brown hair and headsets everywhere — including on
  // D.Va, which is exactly backwards.
  const scene = []
  const sceneNegative = []
  const ordered = new Map()
  const strays = []
  const strayNegatives = []
  for (const field of fields) {
    const isNegative = /UC$/i.test(field.label)
    const charMatch = /Char\s*(\d+)/i.exec(field.label)
    if (charMatch !== null) {
      const n = Number(charMatch[1])
      const row = ordered.get(n) ?? { label: `Char${n}`, index: n, text: '', negative: '', centers: [] }
      if (isNegative) {
        // The label stays `CharN`: it names the character, and the negative is
        // recorded beside it rather than renaming the pair to "CharN UC".
        row.negative = field.text
      } else {
        row.text = field.text
        row.centers = field.centers
      }
      ordered.set(n, row)
      continue
    }
    if (/^Scene\s+UC$/i.test(field.label)) {
      if (field.text !== '') sceneNegative.push(field.text)
      continue
    }
    if (/^Scene$/i.test(field.label)) {
      if (field.text !== '') scene.push(field.text)
      continue
    }
    if (field.text === '') continue
    if (isNegative) strayNegatives.push(field.text)
    else strays.push(field.text)
  }

  const characters = [...ordered.values()].sort((a, b) => a.index - b.index).filter((row) => row.text !== '')
  const positives = [...scene, ...characters.map((row) => row.text), ...strays]
  if (positives.length === 0) return { ok: false, reason: 'every positive field was empty' }

  // Scene first, then the characters in index order: NovelAI reads left to right,
  // and the format deliberately puts the scene before the characters.
  const prompt = positives.join(', ')
  // The book's own spec block parses cleanly but is nothing but placeholders, and
  // the library convention is that `[中文]` must be replaced before use. Saying so
  // is far more useful than rendering the phrase "通用提示词" and hoping.
  if (/\[[^\]]*[\u4e00-\u9fff][^\]]*\]/.test(prompt)) {
    notes.push('the prompt still holds [中文占位符]，这些需要先替换成实际内容')
  }

  // Every negative, scene-last as written. This is the global negative used when
  // the per-character split is not available.
  const allNegatives = [...characters.map((row) => row.negative).filter((text) => text !== ''), ...sceneNegative, ...strayNegatives]

  return {
    ok: true,
    prompt,
    negativePrompt: allNegatives.join(', '),
    /** The scene-only positive, for the base caption when characters are split out. */
    sceneCaption: scene.join(', '),
    /** The scene-only negative, for the base caption when characters are split out. */
    sceneNegative: sceneNegative.join(', '),
    width,
    height,
    characters,
    hasSize: sizeMatch !== null,
    sizeSource,
    notes
  }
}

/**
 * Parse only if the text is in this format, so a caller can accept either a
 * plain prompt or an `<image>` block without guessing wrong.
 *
 * @param text - the candidate.
 * @param options - size fallbacks.
 * @returns the parsed request, or `null` when the text is not a block.
 */
export function maybeParseImageBlock(text, options = {}) {
  if (!looksLikeImageBlock(text)) return null
  const parsed = parseImageBlock(text, options)
  return parsed.ok ? parsed : null
}
