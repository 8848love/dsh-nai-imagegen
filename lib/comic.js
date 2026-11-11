/**
 * dsh-nai-imagegen — the `nai5-comic` page format.
 *
 * A SillyTavern completion preset (「NAI5分格漫画」) drives a model to output one
 * `<image>` per comic page, containing **nothing but JSON**:
 *
 *   <image>
 *   {
 *     "format": "nai5-comic",
 *     "position_mode": "manual",
 *     "page": {
 *       "base": "SFW, 2girls, comic, 複数コマの漫画ページ, 4-koma, layout…",
 *       "non_character": "optional page-level environment and narration"
 *     },
 *     "panels": [
 *       {
 *         "id": "P1",
 *         "description": "panel composition and environment",
 *         "non_character": "optional in-panel text, ending in `Text:`",
 *         "characters": [
 *           { "character_id": "C1", "positive": "girl, long hair… Text:原文",
 *             "negative": "the other character's exclusive features",
 *             "center": { "x": 0.3, "y": 0.5 } }
 *         ]
 *       }
 *     ]
 *   }
 *   </image>
 *
 * The shape lines up with NovelAI's own V4/V5 character feature, which is what
 * makes it work:
 *
 *   - `page.base` plus every `panels[].description` is the **scene**, and becomes
 *     the base caption. It is also where the panel vocabulary lives
 *     (`comic`, `複数コマの漫画ページ`, the layout), which is what actually asks the
 *     model for a paneled page rather than one picture.
 *   - each `characters[]` entry is **one appearance slot**: its `positive` becomes
 *     a character caption, its `negative` becomes that caption's negative (so the
 *     mutual-exclusion rule is scoped to that character rather than to the page),
 *     and its `center` becomes that caption's `centers`.
 *   - `position_mode: "manual"` means the preset supplied coordinates; `auto`
 *     means it deliberately did not, and inventing points would override it.
 *
 * `center` arrives already normalised to the final canvas (0–1), which is exactly
 * what the API wants, so unlike the 5×5 cell markers of the 插画 format these are
 * passed through rather than mapped.
 *
 * Zero external dependencies.
 */
import { looksLikeImageBlock, stripReasoning } from './format.js'

/** Marker that identifies the format without trusting the field alone. */
const FORMAT_NAME = 'nai5-comic'
/** How many character slots are forwarded. A long page can name many. */
export const MAX_COMIC_SLOTS = 24

/**
 * Whether text carries a `nai5-comic` page.
 *
 * Two signals, either sufficient: the explicit `format` marker, or the structural
 * pair of a `page` object and a `panels` array. A model that forgets the marker
 * still produces a comic page, and refusing it over a missing string would be
 * needless.
 *
 * @param text - any transcript text.
 * @returns true when this looks like a comic page.
 */
export function looksLikeComicPage(text) {
  const value = String(text ?? '')
  if (!value.includes('{')) return false
  if (value.includes(`"${FORMAT_NAME}"`) || value.includes(`'${FORMAT_NAME}'`)) return true
  return /"panels"\s*:/.test(value) && /"page"\s*:/.test(value)
}

/**
 * Pull the outermost JSON object out of a blob of text.
 *
 * Hand-written JSON from a language model arrives wrapped in prose, in a
 * `<image>` tag, or inside a fenced block, so the object is located by brace
 * depth with string state respected rather than by trusting the first and last
 * brace.
 *
 * @param text - the text to search.
 * @returns the parsed object, or null.
 */
function extractJson(text) {
  const value = String(text ?? '')
  for (let start = value.indexOf('{'); start >= 0; start = value.indexOf('{', start + 1)) {
    let depth = 0
    let inString = false
    let escaped = false
    for (let at = start; at < value.length; at += 1) {
      const character = value[at]
      if (inString) {
        if (escaped) escaped = false
        else if (character === '\\') escaped = true
        else if (character === '"') inString = false
        continue
      }
      if (character === '"') {
        inString = true
        continue
      }
      if (character === '{') depth += 1
      else if (character === '}') {
        depth -= 1
        if (depth === 0) {
          try {
            return JSON.parse(value.slice(start, at + 1))
          } catch {
            break
          }
        }
      }
    }
  }
  return null
}

/**
 * Clean one field body into prompt text.
 *
 * Only whitespace is normalised. Everything else — the `Text:` trailer, the
 * original-language sentence, Japanese panel vocabulary — is preserved, because
 * the preset's own contract says `Text:` keeps the source sentence verbatim.
 *
 * @param value - the raw field.
 * @returns the cleaned text.
 */
function clean(value) {
  return String(value ?? '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+,/g, ',')
    .replace(/^[,\s]+|[,\s]+$/g, '')
    .trim()
}

/** Longest dialogue line worth asking the image model to letter. */
export const MAX_LETTERING = 16

/**
 * Turn the preset's `Text:` trailer into something the image model actually renders.
 *
 * The preset marks dialogue with `Text:原句`, but that marker is a **completion**
 * convention: it tells a text model where the source sentence goes. To NovelAI it
 * is two words of noise, and a page built this way came out with empty speech
 * bubbles — the dialogue simply never reached the renderer in a form it acts on.
 *
 * What does work is quoting. NovelAI Diffusion V5 renders text that appears in
 * **double quotes**, so the trailer is rewritten from `Text:「对不起」` to
 * `"对不起"` and the marker is dropped.
 *
 * Adherence collapses past a handful of characters, so the line is also reported
 * when it is long enough to be unlikely to letter cleanly — better to know than to
 * chase a rendering failure that was inevitable.
 *
 * @param value - the raw field body.
 * @returns `{ text, dialogue, note }` — the cleaned body, the quoted line, a warning.
 */
function letter(value) {
  const body = clean(value)
  const at = body.lastIndexOf('Text:')
  if (at < 0) return { text: body, dialogue: '', note: null }
  const spoken = body
    .slice(at + 'Text:'.length)
    .trim()
    // A whole field is often wrapped for weight — `1.5::speech bubble Text:「过来」::`
    // — which puts the wrapper's **closer** after the line. Left in, it was glued
    // into the quoted string, so the model was asked to letter `过来」::` rather than
    // `过来`, which is a direct cause of unreadable lettering.
    .replace(/::+\s*$/, '')
    .trim()
    // The preset wraps the line in 「」 or "" or '' ; the wrapper is punctuation,
    // not content, so it is stripped before the line gets its own quotes.
    .replace(/^[「『"'\u201c\u2018]+/, '')
    .replace(/[」』"'\u201d\u2019]+$/, '')
    .trim()
  // The same wrapper leaves its **opener** dangling on the head — a weight marker
  // that never closes. It is lifted off and re-applied to the quoted line, where the
  // emphasis was meant to be and where it actually helps. Both shapes are handled:
  // `1.5::rest` (the common one, since the closer sat after the line) and `rest 1.5::`.
  const rawHead = body.slice(0, at).replace(/[,;\s]+$/, '').trim()
  const leading = /^(\d+(?:\.\d+)?)::\s*/.exec(rawHead)
  const trailing = leading === null ? /(\d+(?:\.\d+)?)::\s*$/.exec(rawHead) : null
  const weight = leading !== null ? leading[1] : trailing === null ? null : trailing[1]
  const stem =
    leading !== null
      ? rawHead.slice(leading[0].length).replace(/[,;\s]+$/, '').trim()
      : trailing === null
        ? rawHead
        : rawHead.slice(0, trailing.index).replace(/[,;\s]+$/, '').trim()
  if (spoken === '') return { text: stem, dialogue: '', note: null }
  const note =
    spoken.length > MAX_LETTERING
      ? `有 ${spoken.length} 字的台词（「${spoken.slice(0, 10)}…」）——超过 ${MAX_LETTERING} 字后模型几乎不照字写，建议缩短或出图后自己贴字`
      : null
  const line = weight === null ? `"${spoken}"` : `${weight}::"${spoken}"::`
  return {
    text: [stem, line].filter((part) => part !== '').join(', '),
    dialogue: spoken,
    note
  }
}

/**
 * Validate a `center` point.
 *
 * @param value - a `{x, y}` object.
 * @returns the clamped point, or null when it is not usable.
 */
function toPoint(value) {
  if (value === null || typeof value !== 'object') return null
  const x = Number(value.x)
  const y = Number(value.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) }
}

/**
 * Parse a `nai5-comic` page into a render request.
 *
 * @param text - the raw page, with or without the `<image>` wrapper.
 * @param options - `{ width, height }` fallbacks; a comic page states no size.
 * @returns the parsed request, or `{ ok: false }` with a reason.
 */
export function parseComicPage(text, options = {}) {
  const raw = String(text ?? '')
  if (raw.trim() === '') return { ok: false, reason: 'empty input' }
  if (!looksLikeComicPage(raw)) {
    return { ok: false, reason: '既没有 "format":"nai5-comic"，也没有同时出现 "page" 与 "panels" 这两个键' }
  }

  const notes = []
  // `<thinking>` and `<comic_plan>` sit *outside* the page and are the model's
  // reasoning; only the `<image>` body is the page itself.
  const body = stripReasoning(raw)
  const page = extractJson(body)
  if (page === null) {
    return {
      ok: false,
      reason: '整段里找不到合法的 JSON 对象（常见原因：把说明文字写进了 <image>、JSON 被截断、或用了单引号 / 尾随逗号）'
    }
  }

  const declared = String(page.format ?? '')
  if (declared === '') {
    notes.push('没有 format 字段，是靠 page + panels 结构认出来的')
  } else if (declared !== FORMAT_NAME) {
    notes.push(`format 是「${declared}」而不是 ${FORMAT_NAME}，但仍按漫画页解析`)
  }

  const pageBody = page.page !== null && typeof page.page === 'object' ? page.page : {}
  // Every field goes through `letter`, which is what puts dialogue in the quotes
  // NovelAI V5 actually renders text from — see its doc comment.
  const base = letter(pageBody.base ?? page.base ?? '')
  const pageNonCharacter = letter(pageBody.non_character ?? '')
  const panels = Array.isArray(page.panels) ? page.panels : []
  if (panels.length === 0) {
    // A splash page legitimately has one panel and the model may flatten it.
    notes.push('没有 panels 数组（只有单格 splash 时才可接受），只按 page.base 出图')
  }
  for (const part of [base, pageNonCharacter]) {
    if (part.note !== null) notes.push(part.note)
  }

  const manual = String(page.position_mode ?? pageBody.position_mode ?? 'auto').toLowerCase() === 'manual'
  if (!manual && panels.some((panel) => (panel?.characters ?? []).some((entry) => toPoint(entry?.center) !== null))) {
    notes.push('position_mode 不是 manual，给出了 center 也不使用')
  }

  const sceneParts = [base.text, pageNonCharacter.text]
  const characters = []
  let dialogueCount = (base.dialogue === '' ? 0 : 1) + (pageNonCharacter.dialogue === '' ? 0 : 1)
  let slotCount = 0
  let dropped = 0
  for (const panel of panels) {
    if (panel === null || typeof panel !== 'object') continue
    const id = clean(panel.id ?? '') || `P${panels.indexOf(panel) + 1}`
    const description = letter(panel.description ?? '')
    const nonCharacter = letter(panel.non_character ?? '')
    if (description.text !== '') sceneParts.push(description.text)
    if (nonCharacter.text !== '') sceneParts.push(nonCharacter.text)
    for (const part of [description, nonCharacter]) {
      if (part.note !== null) notes.push(`${id}：${part.note}`)
      if (part.dialogue !== '') dialogueCount += 1
    }
    for (const entry of Array.isArray(panel.characters) ? panel.characters : []) {
      if (entry === null || typeof entry !== 'object') continue
      const spoken = letter(entry.positive ?? '')
      const positive = spoken.text
      if (positive === '') continue
      if (spoken.note !== null) notes.push(`${id}：${spoken.note}`)
      if (spoken.dialogue !== '') dialogueCount += 1
      if (slotCount >= MAX_COMIC_SLOTS) {
        dropped += 1
        continue
      }
      slotCount += 1
      const center = manual ? toPoint(entry.center) : null
      characters.push({
        label: `${id}·${clean(entry.character_id ?? '') || `C${slotCount}`}`,
        text: positive,
        negative: clean(entry.negative ?? ''),
        // An object, not a cell: these coordinates are already on the canvas.
        centers: center === null ? [] : [center]
      })
    }
  }
  if (dropped > 0) notes.push(`人物槽超过 ${MAX_COMIC_SLOTS} 个，丢弃了 ${dropped} 个`)

  const sceneCaption = sceneParts.filter((part) => part !== '').join(', ')
  const positives = [sceneCaption, ...characters.map((row) => row.text)].filter((part) => part !== '')
  if (positives.length === 0) {
    // Name the missing piece. "Nothing to draw" is useless to a writer trying to
    // fix its own output; "panels[].characters[].positive is empty" is an
    // instruction it can follow.
    const missing = []
    if (base.text === '') missing.push('page.base')
    if (panels.length === 0) missing.push('panels 数组')
    else if (characters.length === 0) missing.push('panels[].characters[].positive')
    return { ok: false, reason: `没有任何可画的内容——缺少 ${missing.join(' 与 ')}` }
  }

  // The page carries no global negative field: the preset puts every exclusion on
  // the character it belongs to, which is the whole point of the format. The
  // host's configured default negative is merged in later, as for any render.
  const seen = new Set()
  const negatives = []
  for (const row of characters) {
    if (row.negative === '' || seen.has(row.negative)) continue
    seen.add(row.negative)
    negatives.push(row.negative)
  }

  return {
    ok: true,
    format: FORMAT_NAME,
    prompt: positives.join(', '),
    negativePrompt: negatives.join(', '),
    /** Scene-only, for the base caption when characters are split out. */
    sceneCaption,
    /** Scene-only negatives; empty here, the default fills it in. */
    sceneNegative: '',
    width: Number(options.width) || 0,
    height: Number(options.height) || 0,
    characters,
    panelCount: panels.length,
    /** How many `Text:` lines became quoted lettering, for the readout. */
    dialogueCount,
    positionMode: manual ? 'manual' : 'auto',
    hasSize: false,
    sizeSource: 'configured',
    notes
  }
}

/**
 * Parse only when the text is a comic page, so a caller can accept it and the
 * 插画 formats side by side without guessing.
 *
 * @param text - the candidate.
 * @param options - size fallbacks.
 * @returns the parsed request, or null.
 */
export function maybeParseComicPage(text, options = {}) {
  if (!looksLikeComicPage(text)) return null
  const parsed = parseComicPage(text, options)
  return parsed.ok ? parsed : null
}

/**
 * Whether the text is any supported page, comic or illustration.
 *
 * Used by the host to raise an actionable error for a page that announces a
 * format but cannot be read, rather than sending the raw text as a prompt.
 *
 * @param text - the candidate.
 * @returns true when some page format is claimed.
 */
export function looksLikeAnyPage(text) {
  return looksLikeComicPage(text) || looksLikeImageBlock(text)
}
