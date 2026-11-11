/**
 * dsh-nai-imagegen — artist-string archive.
 *
 * The archive this reads is a 217 MB JSON array: 960 records, each carrying a
 * name, a sequence number, a positive and a negative prompt, and a
 * `referenceImage` data URL holding a base64 PNG. Roughly 226 KB per record,
 * almost all of it image.
 *
 * Two consequences shape everything below:
 *
 *   1. It must never be held in memory whole. `JSON.parse` on a 222M-character
 *      string costs about a gigabyte, which is not something a plugin inside the
 *      harness should do to its host.
 *   2. The images must not be duplicated onto disk either. 960 decodes would be
 *      ~150 MB of copies of data that already exists.
 *
 * So this module streams the file at the **byte** level, carving out one record
 * at a time by brace depth, parsing only that ~226 KB record, keeping the four
 * short fields, and recording the *byte range* of the base64 payload. Images are
 * then read back from the original file on demand.
 *
 * Scanning bytes rather than characters is deliberate and correct here: every
 * structural character this cares about is ASCII, and every UTF-8 continuation
 * byte is >= 0x80, so multibyte text cannot be mistaken for structure — and byte
 * offsets are exactly what `fs.read` wants afterwards.
 *
 * Zero external dependencies.
 */
import { open, readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/** Read window; large enough that records rarely straddle more than two. */
const CHUNK_BYTES = 8 * 1024 * 1024
/** The data-URL prefix a reference image always carries. */
const DATA_URL_PREFIX = 'data:image/'
/** Marks the start of the base64 payload inside a data URL. */
const BASE64_MARKER = ';base64,'

/**
 * Where ids for the user's own entries begin.
 *
 * The archive hands out dense positions (0, 1, 2 …), so a user id has to live
 * somewhere else entirely or `entries[id]` — positional lookup, which several
 * callers used to do — would silently resolve a user entry to an archive entry.
 * Everything user-made is therefore 1000 and up, and every lookup goes through
 * `find` by id rather than by array position.
 */
export const USER_ID_BASE = 1000
/** A user entry's name ceiling. */
export const MAX_ARTIST_NAME_CHARS = 120
/** Ceiling on one uploaded reference image; the panel says the same number. */
export const MAX_ARTIST_IMAGE_BYTES = 8 * 1024 * 1024
/** Sorts user entries after every archive entry. */
const USER_SEQUENCE_BASE = 1e9
/** Sniffed mime types, in the order they are tried, with the file extension each gets. */
const IMAGE_TYPES = [
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif']
]

/** Structural ASCII bytes. */
const OPEN_BRACE = 0x7b
const CLOSE_BRACE = 0x7d
const OPEN_BRACKET = 0x5b
const CLOSE_BRACKET = 0x5d
const QUOTE = 0x22
const BACKSLASH = 0x5c

/**
 * Carve the top-level array of records out of an archive, one at a time.
 *
 * Each record's raw text is handed to `onRecord` together with its byte offset
 * in the file, which is what lets the caller turn a match inside the text into
 * an absolute file position.
 *
 * @param options - source path and the per-record callback.
 * @returns how many records were seen.
 */
export async function scanArchive({ sourceFile, onRecord, chunkBytes = CHUNK_BYTES }) {
  const handle = await open(sourceFile, 'r')
  try {
    const buffer = Buffer.alloc(chunkBytes)
    let carry = Buffer.alloc(0)
    let carryOffset = 0
    let depth = 0
    let inString = false
    let escaped = false
    let recordStart = -1
    let count = 0
    let position = 0

    for (;;) {
      const read = await handle.read(buffer, 0, chunkBytes, position)
      if (read.bytesRead === 0) break
      const fresh = buffer.subarray(0, read.bytesRead)
      const combined = carry.length > 0 ? Buffer.concat([carry, fresh]) : fresh
      const base = carry.length > 0 ? carryOffset : position

      if (carry.length > 0) {
        // A carry always begins exactly at a record's opening brace, so the scan
        // restarts from "inside the array". Resetting is what makes this
        // correct: without it the carried text is counted into `depth` a second
        // time, depth runs away, `depth === 2` stops matching, and every record
        // after the first chunk boundary is silently dropped. That is exactly
        // how an earlier version indexed 6 of 960 records.
        depth = 1
        inString = false
        escaped = false
        recordStart = -1
      }

      for (let i = 0; i < combined.length; i += 1) {
        const byte = combined[i]
        if (inString) {
          if (escaped) escaped = false
          else if (byte === BACKSLASH) escaped = true
          else if (byte === QUOTE) inString = false
          continue
        }
        if (byte === QUOTE) {
          inString = true
          continue
        }
        if (byte === OPEN_BRACE || byte === OPEN_BRACKET) {
          depth += 1
          if (byte === OPEN_BRACE && depth === 2) recordStart = base + i
          continue
        }
        if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
          if (byte === CLOSE_BRACE && depth === 2 && recordStart >= 0) {
            const start = recordStart - base
            if (start >= 0) {
              onRecord(combined.subarray(start, i + 1).toString('utf8'), recordStart)
              count += 1
            }
            recordStart = -1
          }
          depth -= 1
        }
      }

      // Carry the in-flight record into the next window; when nothing is in
      // flight there is nothing to carry.
      //
      // The copy matters: `combined` is a view into `buffer`, and `buffer` is
      // reused by the next `handle.read`, so a borrowed view would be silently
      // overwritten — which is how an earlier version lost every record past the
      // first chunk boundary.
      const keepFrom = recordStart >= 0 ? recordStart - base : combined.length
      const keep = Math.max(0, keepFrom)
      carry = Buffer.from(combined.subarray(keep))
      carryOffset = base + keep
      position += read.bytesRead
    }
    return count
  } finally {
    await handle.close()
  }
}

/**
 * Locate the byte range of a record's base64 image payload.
 *
 * @param recordText - the record's raw JSON text.
 * @param recordOffset - the record's absolute offset in the file.
 * @returns the payload range, or `null` when the record has no image.
 */
export function locateImage(recordText, recordOffset) {
  const marker = recordText.indexOf(DATA_URL_PREFIX)
  if (marker < 0) return null
  const payload = recordText.indexOf(BASE64_MARKER, marker)
  if (payload < 0) return null
  const start = payload + BASE64_MARKER.length
  const end = recordText.indexOf('"', start)
  if (end < 0 || end <= start) return null
  // `recordText` came from a UTF-8 decode, so character indices can drift from
  // byte offsets for records containing multibyte text. Realign by measuring the
  // prefix that precedes the payload. Base64 is ASCII, so its character count
  // equals its byte count.
  const prefixBytes = Buffer.byteLength(recordText.slice(0, start), 'utf8')
  const mime = /^data:(image\/[a-z+]+);/i.exec(recordText.slice(marker, start))?.[1] ?? 'image/png'
  return {
    start: recordOffset + prefixBytes,
    length: end - start,
    mime
  }
}

/**
 * The keys an entry can be recognised by, most specific first.
 *
 * An image-carrying record is identified by the byte range of its reference
 * image: the range is unique per record, and an append never moves a byte of
 * what is already in the file, so it survives re-indexing intact. A record with
 * no image has no range and falls back to its name.
 *
 * @param entry - an index entry, or one freshly scanned.
 * @returns the lookup keys, first one wins.
 */
function keysOf(entry) {
  const keys = []
  const image = entry?.image
  if (image !== null && image !== undefined && Number.isFinite(image.start)) {
    keys.push(`range:${image.start}:${image.length}`)
  }
  keys.push(`name:${entry?.name ?? ''}`)
  return keys
}

/**
 * Whether an index on disk was built from the archive now being indexed.
 *
 * It has to be the same archive, not merely an index: re-pointing the plugin at a
 * different archive and re-indexing must not staple that archive's records onto
 * the old archive's numbers.
 *
 * @param previous - the index currently on disk, if any.
 * @param sourceFile - the archive being indexed.
 * @returns true when the previous index may be trusted for ids.
 */
export function sameArchive(previous, sourceFile) {
  return (
    previous !== null &&
    previous !== undefined &&
    Array.isArray(previous.entries) &&
    previous.entries.length > 0 &&
    typeof previous.sourceFile === 'string' &&
    resolve(previous.sourceFile) === resolve(sourceFile)
  )
}

/**
 * Give the entries the ids the index on disk already handed out.
 *
 * An id is how the config remembers which artist string the user is on:
 * `artistId` in the sidebar, one per mode in the floating window, and the
 * favourites list — all of them numbers into the index. Renumbering is
 * therefore not bookkeeping. An id that moves silently repoints the user at a
 * different artist string, and nothing on either side of the wire can tell that
 * the text under the selection changed. Re-indexing follows an append, so it
 * must not renumber.
 *
 * Anything the previous index has never seen is numbered after its highest id.
 *
 * @param entries - freshly scanned entries, already sorted.
 * @param previous - the index currently on disk, if any.
 * @param sourceFile - the archive being indexed.
 * @returns the entries, each with an `id`.
 */
export function assignIds(entries, previous, sourceFile) {
  if (!sameArchive(previous, sourceFile)) {
    return entries.map((entry, position) => ({ ...entry, id: position }))
  }

  const buckets = new Map()
  for (const old of previous.entries) {
    if (!Number.isFinite(old?.id)) continue
    for (const key of keysOf(old)) {
      const list = buckets.get(key)
      if (list === undefined) buckets.set(key, [old])
      else list.push(old)
    }
  }

  const claimed = new Set()
  const kept = new Map()
  entries.forEach((entry, position) => {
    for (const key of keysOf(entry)) {
      // `find` over the bucket rather than shifting it: two records may share a
      // name, and the second one still has to find an id of its own.
      const hit = (buckets.get(key) ?? []).find((old) => !claimed.has(old.id))
      if (hit === undefined) continue
      claimed.add(hit.id)
      kept.set(position, hit)
      return
    }
  })

  let next =
    previous.entries.reduce((high, old) => (Number.isFinite(old?.id) && old.id > high ? old.id : high), -1) + 1
  return entries.map((entry, position) => {
    const old = kept.get(position)
    // A record the index already knows keeps its id *and* its place in the list. The place
    // comes from the previous sequence rather than the archive's, because the archive's
    // numbers repeat across batches: two records can carry the same one, and a sort on a
    // duplicate is decided by nothing at all — which is what let a re-index shuffle the list
    // even while every id still resolved.
    if (old !== undefined) return { ...entry, id: old.id, sequence: old.sequence }
    const id = next
    next += 1
    return { ...entry, id }
  })
}

/**
 * Build the artist index from an archive.
 *
 * @param options - source file and where to write the index.
 * @returns a summary of what was indexed.
 */
export async function buildIndex({ sourceFile, indexPath, chunkBytes }) {
  const entries = []
  const skipped = []
  await scanArchive({
    sourceFile,
    chunkBytes,
    onRecord: (text, offset) => {
      let record
      try {
        record = JSON.parse(text)
      } catch (error) {
        skipped.push({ offset, reason: `unparseable record: ${error.message}` })
        return
      }
      const image = locateImage(text, offset)
      entries.push({
        id: entries.length,
        name: typeof record.name === 'string' ? record.name : `#${entries.length + 1}`,
        sequence: Number.isFinite(Number(record.sequence)) ? Number(record.sequence) : entries.length,
        positivePrompt: typeof record.positivePrompt === 'string' ? record.positivePrompt : '',
        negativePrompt: typeof record.negativePrompt === 'string' ? record.negativePrompt : '',
        chamiPositivePrompt: typeof record.chamipositivePrompt === 'string' ? record.chamipositivePrompt : '',
        chamiNegativePrompt: typeof record.chaminegativePrompt === 'string' ? record.chaminegativePrompt : '',
        image: image === null ? null : { start: image.start, length: image.length, mime: image.mime }
      })
    }
  })

  entries.sort((a, b) => a.sequence - b.sequence || a.id - b.id)
  const previous = await loadIndex(indexPath)
  const assigned = assignIds(entries, previous, sourceFile)
  const known = sameArchive(previous, sourceFile) ? new Set((previous?.entries ?? []).map((entry) => entry.id)) : new Set()
  const index = {
    version: 1,
    sourceFile,
    builtAt: new Date().toISOString(),
    // The provenance note is not derivable from the archive, so it is carried
    // forward rather than being silently dropped on every re-index.
    ...(typeof previous?.note === 'string' && previous.note !== '' ? { note: previous.note } : {}),
    // Written in id order, so a record's position in the file is its id. Every index before
    // this one had that shape, and a positional lookup is exactly the mistake the id scheme
    // exists to avoid — keeping the shape removes the chance of one being right by accident.
    entries: [...assigned].sort((a, b) => a.id - b.id)
  }
  await mkdir(dirname(indexPath), { recursive: true })
  const temp = `${indexPath}.tmp`
  await writeFile(temp, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  // Rename so a reader never observes a half-written index.
  await rename(temp, indexPath)
  return {
    count: index.entries.length,
    withImages: index.entries.filter((entry) => entry.image !== null).length,
    /** How many entries kept an id the previous index had already given them. */
    preserved: assigned.filter((entry) => known.has(entry.id)).length,
    /** How many are new, and were numbered after the highest existing id. */
    added: assigned.filter((entry) => !known.has(entry.id)).length,
    skipped
  }
}

/**
 * Read the index.
 * @param indexPath - the index path.
 * @returns the parsed index, or `null`.
 */
export async function loadIndex(indexPath) {
  try {
    const parsed = JSON.parse(await readFile(indexPath, 'utf8'))
    if (!Array.isArray(parsed?.entries)) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Search the index by name or prompt text.
 *
 * @param index - the loaded index.
 * @param query - the search text; empty returns everything in order.
 * @param limit - maximum results.
 * @returns matching entries without their prompt bodies, for list rendering.
 */
export function searchArtists(index, query, limit = 60) {
  const needle = String(query ?? '').trim().toLowerCase()
  const rows = []
  for (const entry of index?.entries ?? []) {
    if (needle !== '' && !`${entry.name} ${entry.positivePrompt}`.toLowerCase().includes(needle)) continue
    rows.push({
      id: entry.id,
      name: entry.name,
      sequence: entry.sequence,
      hasImage: entry.image !== null && entry.image !== undefined,
      promptChars: entry.positivePrompt.length,
      // Travels with the row so the grid can mark the entries the user made
      // themselves without a second lookup per tile.
      custom: entry.custom === true
    })
    if (rows.length >= limit) break
  }
  return rows
}

/**
 * Read one reference image out of the archive.
 *
 * @param options - the source file and the entry's image range.
 * @returns the decoded image, or `null` when the range is missing.
 */
export async function readArtistImage({ sourceFile, image }) {
  if (image === null || image === undefined) return null
  const handle = await open(sourceFile, 'r')
  try {
    const buffer = Buffer.alloc(image.length)
    await handle.read(buffer, 0, image.length, image.start)
    return Buffer.from(buffer.toString('ascii'), 'base64')
  } finally {
    await handle.close()
  }
}

/* -------------------------------------------------------------------------- */
/*                             the user's own entries                          */
/* -------------------------------------------------------------------------- */

/**
 * Why this exists at all.
 *
 * The archive is an import: an immutable 217 MB file this plugin only ever reads.
 * Anything the user makes therefore cannot live in it — writing back would be
 * lost on the next import and would mean rewriting a file we deliberately never
 * touch. So user entries live beside the index, in a small JSON file plus one
 * image file per entry, and the two lists are merged wherever entries are read.
 *
 * That also explains the id space (see `USER_ID_BASE`) and why uploaded images go
 * in a map of their own: an upload can be attached to an *archive* id as well,
 * which is how a reference image gets replaced without touching the archive.
 */

/** @param artistIndex - the archive index path. @returns the user library path beside it. */
export function userLibraryPath(artistIndex) {
  return join(dirname(artistIndex), 'user.json')
}

/** @param artistIndex - the archive index path. @returns the directory uploaded images go in. */
export function userImageDir(artistIndex) {
  return join(dirname(artistIndex), 'user')
}

/** @returns the extension an uploaded mime type is stored under. */
export function imageExtension(mime) {
  return IMAGE_TYPES.find(([type]) => type === mime)?.[1] ?? 'png'
}

/**
 * Identify an image by its own bytes.
 *
 * The declared mime type and the filename are both attacker-controlled as far as
 * this module is concerned, and the stored type is what every later `<img>` is
 * served with. So the bytes decide, and anything unrecognised is refused.
 *
 * @param buffer - the candidate bytes.
 * @returns the mime type, or `null`.
 */
export function sniffImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null
  const head = buffer.subarray(0, 4)
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png'
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (head.toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  if (head.toString('latin1') === 'GIF8') return 'image/gif'
  return null
}

/**
 * Read the user library.
 *
 * A missing or unreadable file is normal — it means nothing has been made yet —
 * and so is a hand-edited one, so every field is checked rather than trusted: a
 * malformed record is dropped instead of poisoning the list.
 *
 * @param userPath - the library path.
 * @returns the library, always with an array and a map.
 */
export async function loadUserLibrary(userPath) {
  const empty = { version: 1, entries: [], images: {} }
  let parsed
  try {
    parsed = JSON.parse(await readFile(userPath, 'utf8'))
  } catch {
    return empty
  }
  const entries = []
  for (const record of Array.isArray(parsed?.entries) ? parsed.entries : []) {
    const id = Number(record?.id)
    if (!Number.isInteger(id) || id < USER_ID_BASE) continue
    if (typeof record?.name !== 'string' || record.name.trim() === '') continue
    entries.push({
      id,
      name: record.name,
      sequence: Number.isFinite(Number(record.sequence)) ? Number(record.sequence) : USER_SEQUENCE_BASE + id,
      positivePrompt: typeof record.positivePrompt === 'string' ? record.positivePrompt : '',
      negativePrompt: typeof record.negativePrompt === 'string' ? record.negativePrompt : '',
      chamiPositivePrompt: typeof record.chamiPositivePrompt === 'string' ? record.chamiPositivePrompt : '',
      chamiNegativePrompt: typeof record.chamiNegativePrompt === 'string' ? record.chamiNegativePrompt : '',
      createdAt: typeof record.createdAt === 'string' ? record.createdAt : null
    })
  }
  entries.sort((a, b) => a.id - b.id)
  const images = {}
  for (const [key, value] of Object.entries(parsed?.images && typeof parsed.images === 'object' ? parsed.images : {})) {
    const id = Number(key)
    if (!Number.isInteger(id) || id < 0) continue
    if (typeof value?.file !== 'string' || value.file === '') continue
    if (value.file.includes('/') || value.file.includes('\\') || value.file.includes('..')) continue
    images[String(id)] = {
      file: value.file,
      mime: typeof value.mime === 'string' ? value.mime : 'image/png',
      bytes: Number.isFinite(Number(value.bytes)) ? Number(value.bytes) : 0,
      uploadedAt: typeof value.uploadedAt === 'string' ? value.uploadedAt : null
    }
  }
  return { version: 1, entries, images }
}

/**
 * Write the user library back.
 * @param userPath - the library path.
 * @param library - the library to store.
 */
export async function saveUserLibrary(userPath, library) {
  const clean = {
    version: 1,
    entries: (library?.entries ?? []).map((record) => ({ ...record })),
    images: { ...(library?.images ?? {}) }
  }
  await mkdir(dirname(userPath), { recursive: true })
  const temp = `${userPath}.tmp`
  await writeFile(temp, `${JSON.stringify(clean, null, 2)}\n`, 'utf8')
  // Rename so a reader never sees a half-written library, exactly as with the index.
  await rename(temp, userPath)
}

/**
 * The archive and the user library as one list of entries.
 *
 * An uploaded image shadows whatever the archive had for that id, which is the
 * only way to replace a reference image without writing to a file this plugin
 * does not own.
 *
 * @param index - the loaded archive index, or `null`.
 * @param library - the loaded user library.
 * @returns entries in one shape, archive entries first.
 */
export function mergeArtists(index, library) {
  const uploads = library?.images ?? {}
  const entries = []
  for (const entry of index?.entries ?? []) {
    const upload = uploads[String(entry.id)]
    entries.push({
      ...entry,
      custom: false,
      image: upload === undefined ? entry.image : { file: upload.file, mime: upload.mime, bytes: upload.bytes },
      imageSource: upload !== undefined ? 'upload' : entry.image === null || entry.image === undefined ? null : 'archive'
    })
  }
  for (const record of library?.entries ?? []) {
    const upload = uploads[String(record.id)]
    entries.push({
      ...record,
      custom: true,
      image: upload === undefined ? null : { file: upload.file, mime: upload.mime, bytes: upload.bytes },
      imageSource: upload === undefined ? null : 'upload'
    })
  }
  return entries
}

/**
 * The id a new user entry should take.
 *
 * Above every id in play — not just the user ones — so a fresh entry can never
 * shadow an archive entry, even if the archive is later re-imported with more
 * records than it had when the entry was made.
 *
 * @param entries - the merged entry list.
 * @returns the next free id.
 */
export function nextUserId(entries) {
  let highest = USER_ID_BASE - 1
  for (const entry of entries ?? []) {
    const id = Number(entry?.id)
    if (Number.isInteger(id) && id > highest) highest = id
  }
  return highest + 1
}

/**
 * Store one uploaded reference image.
 *
 * @param options - image directory, entry id, mime type and bytes.
 * @returns the stored image record.
 */
export async function writeUserImage({ dir, id, mime, bytes }) {
  await mkdir(dir, { recursive: true })
  const file = `${Number(id)}.${imageExtension(mime)}`
  // Whatever this id had before is dropped first: a replacement usually arrives
  // as a different format, and a leftover `.png` beside a new `.jpg` is a file
  // nothing will ever read again.
  await removeUserImages({ dir, id, keep: file })
  const temp = join(dir, `${file}.tmp`)
  await writeFile(temp, bytes)
  await rename(temp, join(dir, file))
  return { file, mime, bytes: bytes.length, uploadedAt: new Date().toISOString() }
}

/**
 * Forget every uploaded image for one id.
 * @param options - image directory, entry id, and the extension to keep.
 */
export async function removeUserImages({ dir, id, keep = '' }) {
  await Promise.all(
    IMAGE_TYPES.map(async ([, extension]) => {
      const name = `${Number(id)}.${extension}`
      if (name === keep) return
      try {
        await unlink(join(dir, name))
      } catch {
        // Absent is the normal case; nothing to do.
      }
    })
  )
}

/**
 * Read one uploaded reference image.
 * @param options - image directory and file name.
 * @returns the bytes, or `null` when the file is gone.
 */
export async function readUserImage({ dir, file }) {
  try {
    return await readFile(join(dir, file))
  } catch {
    return null
  }
}
