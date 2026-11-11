/**
 * dsh-nai-imagegen — attachment-library index.
 *
 * The five 附体 libraries are SillyTavern world books: one minified JSON line per
 * entry, 2 071 entries and roughly 1.17M characters of payload in total. That is
 * far too much to sit in a model context, so this module keeps a per-entry JSONL
 * projection on disk (`<库名>.jsonl`) and answers keyword queries against it.
 *
 * The projection is what `nai_index` builds and what `nai_lookup` reads. Both are
 * pure file IO; nothing here touches the network.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Library name fragments recognised when rebuilding, longest match first. */
const SOURCE_PATTERNS = [
  { needle: '常规模板', library: '常规模板5.25' },
  { needle: '标签库', library: '标签库9.5' },
  { needle: '扩展库', library: '扩展库5.4' },
  { needle: '同人库', library: '同人库8.5' },
  { needle: 'SEX模板', library: 'SEX模板9.2' },
  { needle: 'S模板', library: 'SEX模板9.2' }
]

/** The character roster library, used by `nai_resolve`. */
export const ROSTER_LIBRARY = '同人库8.5'

/**
 * Which JSONL projections exist in a directory.
 * @param libraryDir - directory holding `<库名>.jsonl`.
 * @returns one row per library, sorted by name.
 */
export async function listLibraries(libraryDir) {
  let names = []
  try {
    names = await readdir(libraryDir)
  } catch {
    return []
  }
  const rows = []
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    const library = name.slice(0, -'.jsonl'.length)
    let entries = 0
    try {
      const text = await readFile(join(libraryDir, name), 'utf8')
      for (const line of text.split('\n')) if (line.trim()) entries += 1
    } catch {
      continue
    }
    rows.push({ library, entries })
  }
  return rows.sort((a, b) => a.library.localeCompare(b.library, 'zh'))
}

/**
 * Read one projection into memory.
 * @param libraryDir - directory holding `<库名>.jsonl`.
 * @param library - library name without the extension.
 * @returns the parsed entries; an empty array when the file is absent.
 */
async function readLibrary(libraryDir, library) {
  try {
    const text = await readFile(join(libraryDir, `${library}.jsonl`), 'utf8')
    const entries = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        entries.push(JSON.parse(line))
      } catch {
        // A single damaged line must not lose the whole library.
      }
    }
    return entries
  } catch {
    return []
  }
}

/**
 * Rank one entry against a query.
 *
 * Title and key hits are what a caller means almost every time, so they
 * dominate; a body hit is a weaker signal but still useful for finding which
 * entry owns a tag.
 *
 * @param entry - one projection row.
 * @param needle - the lowercased query.
 * @returns a score, or `-1` for no match at all.
 */
function score(entry, needle) {
  const title = String(entry.title ?? '').toLowerCase()
  const keys = String(entry.keys ?? '').toLowerCase()
  const body = String(entry.content ?? '').toLowerCase()
  if (title === needle) return 1000
  if (title.includes(needle)) return 500 - Math.min(200, title.length)
  if (keys.includes(needle)) return 300
  if (body.includes(needle)) return 100
  return -1
}

/**
 * Search one or all libraries.
 *
 * @param query - the search text. Treat a bare `.` as "everything" so a caller
 *   can page a whole library.
 * @param options - library directory, optional single-library restriction,
 *   result count, and how much of each body to return. `maxChars: 0` is the
 *   preview mode: headers only, no bodies.
 * @returns ranked hits with a truncated body and the full body length.
 */
export async function lookup(query, options = {}) {
  const { libraryDir, library, limit = 8, full = false, maxChars = 600 } = options
  const preview = maxChars === 0
  const needle = String(query ?? '').trim().toLowerCase()
  if (!needle) return { hits: [], libraries: [] }
  const everything = needle === '.'

  const available = await listLibraries(libraryDir)
  const wanted = library ? available.filter((row) => row.library === library) : available
  if (wanted.length === 0) return { hits: [], libraries: available }

  const scored = []
  for (const row of wanted) {
    for (const entry of await readLibrary(libraryDir, row.library)) {
      const rank = everything ? 1 : score(entry, needle)
      if (rank < 0) continue
      scored.push({ rank, entry, library: row.library })
    }
  }
  scored.sort((a, b) => b.rank - a.rank || (a.entry.uid ?? 0) - (b.entry.uid ?? 0))

  const hits = scored.slice(0, Math.max(1, limit)).map(({ entry, library: name }) => {
    const body = String(entry.content ?? '')
    const content = preview
      ? '（预览模式：只给标题与触发键，不取正文）'
      : full || body.length <= maxChars
        ? body
        : `${body.slice(0, maxChars)}\n…[截断，全文 ${body.length} 字符；加 maxChars 取更长，或 full=true 取全]`
    return {
      library: name,
      uid: entry.uid ?? null,
      title: entry.title ?? '',
      keys: entry.keys ?? '',
      chars: body.length,
      content
    }
  })
  return { hits, total: scored.length, libraries: available }
}

/**
 * Resolve a character name to its library entry plus a first-glance tag line.
 *
 * The roster library stores each character as `- 名字:英文tag串`, optionally
 * followed by multi-line blocks (`主要服饰`, `拓展资料区`, …). Returning the raw
 * entry verbatim matters: an earlier attempt at this project hallucinated a
 * Blue Archive tag for a Gakuen Idolmaster character, and the library was right
 * all along.
 *
 * @param name - a Chinese name, romanisation, or official tag fragment.
 * @param options - library directory and result count.
 * @returns ranked roster hits.
 */
export async function resolveCharacter(name, options = {}) {
  const { libraryDir, limit = 5 } = options
  const needle = String(name ?? '').trim().toLowerCase()
  const available = await listLibraries(libraryDir)
  if (!needle) return { library: ROSTER_LIBRARY, libraries: available, hits: [] }
  const entries = await readLibrary(libraryDir, ROSTER_LIBRARY)
  const scored = []
  for (const entry of entries) {
    const title = String(entry.title ?? '')
    const keys = String(entry.keys ?? '')
    const body = String(entry.content ?? '')
    const lower = `${title} ${keys} ${body}`.toLowerCase()
    if (!lower.includes(needle)) continue
    let rank = 10
    if (keys.toLowerCase().includes(needle)) rank = 100
    if (title.toLowerCase().includes(needle)) rank = 200
    scored.push({ rank, entry })
  }
  scored.sort((a, b) => b.rank - a.rank || (a.entry.uid ?? 0) - (b.entry.uid ?? 0))
  // The roster names characters the way the game does (`光`, `希美`), while a user
  // often has their own shorthand for the same character. A plain miss reads like
  // a broken index, so offer the near hits: entries sharing any character with the
  // query, most overlap first.
  let note = ''
  if (scored.length === 0) {
    const wanted = [...new Set([...needle].filter((character) => /[\u4e00-\u9fff\w]/.test(character)))]
    const near = entries
      .map((entry) => {
        const text = `${entry.title ?? ''} ${entry.keys ?? ''}`.toLowerCase()
        const overlap = wanted.filter((character) => text.includes(character)).length
        return { entry, overlap }
      })
      .filter((row) => row.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap || (a.entry.uid ?? 0) - (b.entry.uid ?? 0))
      .slice(0, 3)
    if (near.length > 0) {
      note = `名册里的相近条目：${near.map((row) => `${row.entry.title ?? ''}${row.entry.keys ? ` ⟨${row.entry.keys}⟩` : ''}`).join('　')}`
    }
  }
  return {
    library: ROSTER_LIBRARY,
    /** The indexed libraries, so a miss can say what *was* searched instead of
     *  claiming the whole index directory is empty. */
    libraries: available,
    note,
    total: scored.length,
    // Shaped exactly like `lookup`'s hits. The header the digest builds reads
    // `library` and `chars`, and a roster hit that omitted them printed
    // "【undefined #154】… (undefined 字符)".
    hits: scored.slice(0, Math.max(1, limit)).map(({ entry }) => {
      const content = String(entry.content ?? '')
      return {
        library: ROSTER_LIBRARY,
        uid: entry.uid ?? null,
        title: entry.title ?? '',
        keys: entry.keys ?? '',
        chars: content.length,
        content
      }
    })
  }
}

/**
 * Pick the canonical library name for one source world-book file.
 * @param fileName - the file's basename.
 * @returns the library name, or `null` when the file is not an attachment book.
 */
function libraryOf(fileName) {
  if (!fileName.includes('附体')) return null
  for (const pattern of SOURCE_PATTERNS) {
    if (fileName.includes(pattern.needle)) return pattern.library
  }
  return null
}

/**
 * Rebuild every JSONL projection from the original world-book JSONs.
 *
 * When several files map to the same library the largest entry set wins, which
 * is what makes this safe to run against a directory holding many historical
 * releases side by side — the normal state of a Downloads folder here.
 *
 * @param options - source directory and target directory.
 * @returns one row per library written.
 */
export async function rebuildIndex(options = {}) {
  const { sourceDir, libraryDir } = options
  await mkdir(libraryDir, { recursive: true })

  const names = await readdir(sourceDir).catch(() => [])
  const best = new Map()
  const skipped = []

  for (const name of names) {
    if (!name.toLowerCase().endsWith('.json')) continue
    const library = libraryOf(name)
    if (library === null) continue
    let parsed
    try {
      parsed = JSON.parse(await readFile(join(sourceDir, name), 'utf8'))
    } catch (error) {
      skipped.push({ file: name, reason: `unreadable: ${error?.message ?? error}` })
      continue
    }
    const entries = parsed?.entries
    if (entries === null || typeof entries !== 'object') {
      skipped.push({ file: name, reason: 'no entries object' })
      continue
    }
    const rows = Object.values(entries)
      .filter((entry) => entry !== null && typeof entry === 'object')
      .sort((a, b) => (Number(a.uid) || 0) - (Number(b.uid) || 0))
    const previous = best.get(library)
    if (previous === undefined || rows.length > previous.rows.length) {
      best.set(library, { file: name, rows })
    }
  }

  const written = []
  for (const [library, { file, rows }] of best) {
    const lines = rows.map((entry) =>
      JSON.stringify({
        lib: library,
        uid: Number(entry.uid) || 0,
        title: String(entry.comment ?? ''),
        keys: Array.isArray(entry.key) ? entry.key.join(',') : String(entry.key ?? ''),
        content: String(entry.content ?? '')
      })
    )
    await writeFile(join(libraryDir, `${library}.jsonl`), `${lines.join('\n')}\n`, 'utf8')
    written.push({ library, source: file, entries: rows.length })
  }
  return { written, skipped }
}
