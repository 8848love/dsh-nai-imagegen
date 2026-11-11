/**
 * dsh-nai-imagegen — the prompt→files index.
 *
 * A transcript is rebuilt from scratch every time a conversation is opened, so the pictures a
 * reply rendered live only in the DOM that reply was built from: switch away, switch back, and
 * the block is bare again even though the files are still on disk. The gallery cannot stand in
 * for this, because a gallery row knows its file name and nothing about the prompt that made it.
 *
 * So the render itself writes one line here: prompt digest in, file names out. The client asks
 * once, in one batch, for every block it can see, and fills the pictures back in. Nothing is
 * generated, so nothing is spent.
 */
import { mkdir, open, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { RENDERS_FILE } from './config.js'

/** Prompts remembered before the oldest is dropped. */
const MAX_ENTRIES = 400
/** Files kept per prompt: one render's worth, with room for a larger batch. */
const MAX_FILES = 12
/** Longest prompt echoed back, in characters. */
const MAX_PROMPT_CHARS = 4000
/** Longest digest accepted as a key. */
const MAX_KEY_CHARS = 64

/** Fields of a render's file row worth remembering. */
const FILE_FIELDS = ['file', 'model', 'size', 'seed']

/**
 * Keep only the parts of a file row that a restored block needs.
 * @param row - one entry of a render's `files`.
 * @returns a trimmed row, or null when it names no file.
 */
function trimFile(row) {
  if (row === null || typeof row !== 'object') return null
  const name = typeof row.name === 'string' ? row.name : ''
  if (name === '') return null
  const out = { name }
  for (const field of FILE_FIELDS) {
    if (row[field] !== undefined) out[field] = row[field]
  }
  return out
}

/**
 * Reject anything that is not a plausible prompt digest.
 * @param key - a candidate key.
 * @returns the key, or null.
 */
function safeKey(key) {
  if (typeof key !== 'string') return null
  if (key === '' || key.length > MAX_KEY_CHARS) return null
  return key
}

/** Writes are serialised: two renders finishing together must not interleave a read and a write. */
let writing = Promise.resolve()

/**
 * Read the whole index.
 * @returns an object of key → `{ prompt, at, files }`; empty when the file is absent or damaged.
 */
async function readIndex() {
  let text = ''
  try {
    text = await readFile(RENDERS_FILE, 'utf8')
  } catch {
    return {}
  }
  let data = null
  try {
    data = JSON.parse(text)
  } catch {
    // A half-written file is not worth failing a render over: start the index again.
    return {}
  }
  const entries = data?.entries
  if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) return {}
  return entries
}

/**
 * The files a set of prompts produced.
 * @param keys - prompt digests to look up.
 * @returns an object of key → files, holding only the keys that have any.
 */
export async function lookupRenders(keys) {
  const wanted = (Array.isArray(keys) ? keys : []).map(safeKey).filter((key) => key !== null)
  const found = {}
  if (wanted.length === 0) return found
  const entries = await readIndex()
  for (const key of wanted) {
    const files = entries[key]?.files
    if (Array.isArray(files) && files.length > 0) found[key] = files
  }
  return found
}

/** Shortest block text worth matching by its words instead of its digest, in characters. */
const MIN_NEEDLE = 40

/**
 * Strip the transport off a prompt, keeping only the words worth comparing.
 *
 * The block in the transcript carries the `<image>` wrapper the reply was written in; the prompt
 * the host was handed does not. Neither does it lose the newlines. Two texts that name the same
 * picture therefore differ in punctuation and spacing, which is exactly what a digest refuses to
 * forgive — so the fallback compares these instead.
 *
 * @param text - a prompt or a block's text.
 * @returns the comparable form: wrapper gone, one space between words, lower case.
 */
export function normalizePrompt(text) {
  if (typeof text !== 'string') return ''
  return text
    .replace(/<image\b[^>]*>/gi, ' ')
    .replace(/<\/image\s*>/gi, ' ')
    .replace(/[\s\u3000]+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * The files a set of block texts produced, for blocks whose digest the index does not know.
 *
 * A picture rendered before this index existed was keyed by the host from the prompt that made
 * it, not by the page from the block that asked for it, and those two texts are not identical:
 * the request carried the configured artist string and style prefix in front of what the reply
 * wrote. The digest misses; the words do not. A stored prompt that contains the block's text, or
 * is contained by it, is the render that block is standing over.
 *
 * @param texts - an object of digest → block text.
 * @returns an object of digest → files, holding only the digests that matched.
 */
export async function lookupByText(texts) {
  const found = {}
  if (texts === null || typeof texts !== 'object' || Array.isArray(texts)) return found
  const wanted = []
  for (const [key, text] of Object.entries(texts)) {
    const safe = safeKey(key)
    const needle = normalizePrompt(text)
    // Short texts are not evidence: "1girl, solo" is half the renders ever made.
    if (safe === null || needle.length < MIN_NEEDLE) continue
    wanted.push({ key: safe, needle })
  }
  if (wanted.length === 0) return found
  const entries = await readIndex()
  const prepared = []
  for (const [key, entry] of Object.entries(entries)) {
    const text = normalizePrompt(entry?.prompt)
    if (text.length < MIN_NEEDLE) continue
    prepared.push({ key, text, at: entry?.at ?? 0 })
  }
  if (prepared.length === 0) return found
  for (const { key, needle } of wanted) {
    let best = null
    for (const row of prepared) {
      const holds = row.text.includes(needle) || needle.includes(row.text)
      if (!holds) continue
      // The closest match is the one that overlaps the most words; the newer render breaks a tie,
      // because the same prompt rendered twice should hand back the picture made most recently.
      const score = Math.min(row.text.length, needle.length)
      if (best === null || score > best.score || (score === best.score && row.at > best.at)) {
        best = { row, score }
      }
    }
    const files = best === null ? null : entries[best.row.key]?.files
    if (Array.isArray(files) && files.length > 0) found[key] = files
  }
  return found
}

/**
 * The files a batch of blocks asked for: by digest first, by words for whatever the digest missed.
 *
 * @param keys - prompt digests to look up.
 * @param texts - an object of digest → block text, the fallback for digests this index never saw.
 * @returns an object of key → files, holding only the keys that have any.
 */
export async function lookupRendersFor(keys, texts) {
  const found = await lookupRenders(keys)
  const missing = {}
  if (texts !== null && typeof texts === 'object' && !Array.isArray(texts)) {
    for (const [key, text] of Object.entries(texts)) {
      if (found[key] === undefined) missing[key] = text
    }
  }
  if (Object.keys(missing).length === 0) return found
  const guessed = await lookupByText(missing)
  return { ...guessed, ...found }
}

/**
 * Remember what one prompt produced.
 *
 * @param key - the prompt digest the client keys its own cache by.
 * @param prompt - the prompt text, kept for a human reading the file.
 * @param files - the render's file rows.
 * @returns true when the index was written.
 */
export async function rememberRender(key, prompt, files) {
  const safe = safeKey(key)
  if (safe === null) return false
  const rows = (Array.isArray(files) ? files : [])
    .map(trimFile)
    .filter((row) => row !== null)
    .slice(0, MAX_FILES)
  if (rows.length === 0) return false
  const entry = {
    prompt: typeof prompt === 'string' ? prompt.slice(0, MAX_PROMPT_CHARS) : '',
    at: Date.now(),
    files: rows
  }

  const task = async () => {
    const entries = await readIndex()
    entries[safe] = entry
    const keys = Object.keys(entries)
    if (keys.length > MAX_ENTRIES) {
      // Oldest out first: the index is a convenience, not an archive of everything ever made.
      keys.sort((left, right) => (entries[left]?.at ?? 0) - (entries[right]?.at ?? 0))
      for (const stale of keys.slice(0, keys.length - MAX_ENTRIES)) delete entries[stale]
    }
    return writeIndex(entries)
  }

  const next = writing.then(task, task)
  writing = next.then(
    () => {},
    () => {}
  )
  return next
}

/**
 * Write the index through a temporary file, so a reader never sees a truncated document.
 * @param entries - the whole index.
 * @returns true.
 */
async function writeIndex(entries) {
  await mkdir(dirname(RENDERS_FILE), { recursive: true })
  const temp = `${RENDERS_FILE}.tmp`
  await writeFile(temp, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, 'utf8')
  await rename(temp, RENDERS_FILE)
  return true
}

/**
 * FNV-1a over the prompt, the same digest the client keys its own cache by.
 *
 * Both halves have to agree down to the last bit, because this digest is the join between a
 * block in the document and a file on disk; that is also why the client sends it rather than
 * letting the host guess.
 *
 * @param text - the prompt.
 * @returns a hexadecimal digest.
 */
export function promptKey(text) {
  const source = typeof text === 'string' ? text : ''
  let hash = 0x811c9dc5
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16)
}

/** Longest text chunk read out of a PNG, in bytes. */
const MAX_CHUNK_BYTES = 4 * 1024 * 1024
/** Chunks walked before giving up on a file, in case the text block never comes. */
const MAX_CHUNKS = 32

/**
 * Read the prompt NovelAI leaves inside a PNG.
 *
 * The bytes NovelAI returns carry a `tEXt` chunk keyed `Comment` holding the request as JSON,
 * prompt included. That is the only surviving record of which prompt made an older picture —
 * the gallery knows the file name and nothing else — so a transcript opened for the first time
 * can still be matched to the files it produced.
 *
 * @param file - absolute path of the PNG.
 * @returns the prompt, or null when the file has none.
 */
async function pngPrompt(file) {
  let handle = null
  try {
    handle = await open(file, 'r')
    const signature = Buffer.alloc(8)
    if ((await handle.read(signature, 0, 8, 0)).bytesRead < 8) return null
    if (signature.toString('latin1', 0, 8) !== '\x89PNG\r\n\x1a\n') return null
    let offset = 8
    for (let step = 0; step < MAX_CHUNKS; step += 1) {
      const head = Buffer.alloc(8)
      if ((await handle.read(head, 0, 8, offset)).bytesRead < 8) return null
      const length = head.readUInt32BE(0)
      const type = head.toString('latin1', 4, 8)
      if (length > MAX_CHUNK_BYTES) return null
      if (type === 'tEXt') {
        const body = Buffer.alloc(length)
        await handle.read(body, 0, length, offset + 8)
        const text = body.toString('utf8')
        const gap = text.indexOf('\u0000')
        if (gap < 0) return null
        if (text.slice(0, gap) !== 'Comment') {
          offset += 12 + length
          continue
        }
        const payload = text.slice(gap + 1)
        try {
          const request = JSON.parse(payload)
          return typeof request?.prompt === 'string' ? request.prompt : null
        } catch {
          return null
        }
      }
      if (type === 'IEND') return null
      offset += 12 + length
    }
    return null
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

/** How many PNGs one backfill pass will read. */
const MAX_BACKFILL = 1200

/**
 * Index the renders that were made before this index existed.
 *
 * Runs at most once per process, and only when a block asks for a prompt the index does not
 * know: the user opening an old conversation is exactly the moment the work is worth doing,
 * and nothing else should pay for it.
 *
 * @param outputDir - the directory freshly rendered files land in.
 * @returns how many prompts were added.
 */
export async function backfillRenders(outputDir) {
  let names = []
  try {
    const rows = await readdir(outputDir, { withFileTypes: true })
    names = rows
      .filter((row) => row.isFile() !== false && row.name.toLowerCase().endsWith('.png'))
      .map((row) => row.name)
      // Timestamped names sort chronologically, so newest-first is newest-first.
      .sort()
      .reverse()
      .slice(0, MAX_BACKFILL)
  } catch {
    return 0
  }
  if (names.length === 0) return 0

  const task = async () => {
    const entries = await readIndex()
    let added = 0
    for (const name of names) {
      if (added >= MAX_ENTRIES) break
      const prompt = await pngPrompt(join(outputDir, name))
      if (typeof prompt !== 'string' || prompt.trim() === '') continue
      const key = promptKey(prompt.trim())
      const known = entries[key]
      if (known !== undefined) {
        // A batch render writes several files for one prompt: they share the timestamp prefix.
        const sameBatch = (known.files?.[0]?.name ?? '').slice(0, 20) === name.slice(0, 20)
        const already = (known.files ?? []).some((row) => row.name === name)
        if (sameBatch && !already && (known.files?.length ?? 0) < MAX_FILES) {
          known.files.push({ name })
        }
        continue
      }
      let at = Date.now()
      try {
        at = (await stat(join(outputDir, name))).mtimeMs || at
      } catch {
        // A file that vanished mid-pass is skipped by name, not by time.
      }
      entries[key] = { prompt: prompt.slice(0, MAX_PROMPT_CHARS), at, files: [{ name }] }
      added += 1
    }
    if (added > 0) await writeIndex(entries)
    return added
  }

  const next = writing.then(task, task)
  writing = next.then(
    () => {},
    () => {}
  )
  return next
}
