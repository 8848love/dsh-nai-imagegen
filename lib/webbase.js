/**
 * The base URL a rendered PNG can be fetched from — so an inline image survives
 * a conversation switch.
 *
 * Why this exists: the browser half draws a Markdown image by resolving its URL
 * through a *path vocabulary* that is rebuilt every time a transcript mounts.
 * A local path that resolved fine when the render happened resolves to nothing
 * once the conversation is replayed, so the picture disappears until something
 * re-registers that path. An absolute `http(s)` URL is taken verbatim by the
 * renderer and needs no vocabulary at all.
 *
 * So the host half hands out `<base>/nai-imagegen/api/file?name=<file>` when it
 * can work out a base, and the plain path when it cannot. It never guesses: a
 * wrong base would render a broken image where a path at least still works.
 */

/** Strip trailing slashes; keep only a real http(s) origin, else `''`. */
export function normalizeWebBase(value) {
  const text = String(value ?? '').trim().replace(/\/+$/, '')
  return /^https?:\/\/[^\s/]+/i.test(text) ? text : ''
}

/**
 * Turn a request's `Host` header into an origin, or give up.
 *
 * The loopback server the panel talks to is the very origin that will fetch the
 * image, so its own `Host` is the most reliable base there is. Anything that is
 * not a plain host (or host:port, or a bracketed IPv6 literal) is refused rather
 * than concatenated — a malformed header must not become an image URL.
 */
export function hostBase(host) {
  const text = String(host ?? '').trim()
  if (/^\[[0-9a-fA-F:]+\](:\d+)?$/.test(text)) return `http://${text}`
  if (/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:\d+)?$/.test(text)) return `http://${text}`
  return ''
}

/**
 * The base in force, most deliberate source first:
 *
 *   1. `config.webBase` — the user pinned one, so honour it
 *   2. `DSH_WEB_URL`    — what the harness exports for the GUI
 *   3. the `Host` of the last request the panel made
 *   4. `''`             — caller falls back to local paths
 */
export function linkBase({ configured = '', env = {}, seenHost = '' } = {}) {
  return normalizeWebBase(configured) || normalizeWebBase(env.DSH_WEB_URL) || hostBase(seenHost)
}

/** Where the browser fetches one rendered PNG, by file name. */
export function fileUrl(base, name) {
  const root = normalizeWebBase(base)
  const file = String(name ?? '').trim().replace(/^.*[\\/]/, '')
  if (root === '' || file === '') return ''
  return `${root}/nai-imagegen/api/file?name=${encodeURIComponent(file)}`
}

/**
 * The Markdown target for one rendered file: an absolute URL when a base is
 * known, the path itself otherwise.
 */
export function imageLink(base, filePath) {
  const url = fileUrl(base, filePath)
  return url === '' ? String(filePath ?? '') : url
}
