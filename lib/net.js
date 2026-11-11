/**
 * dsh-nai-imagegen — HTTP transport with built-in proxy support.
 *
 * Why this exists instead of plain `fetch`:
 *
 * Node's `fetch` (undici) does **not** read the Windows system proxy, and the
 * `NODE_USE_ENV_PROXY` / `HTTPS_PROXY` pair that would make it read one is only
 * consulted at process start. Measured on Node 24.21 against a machine whose
 * system proxy is enabled:
 *
 *   | attempt                                    | result          |
 *   |--------------------------------------------|-----------------|
 *   | direct connect                             | unreachable     |
 *   | `HTTPS_PROXY` only                         | `fetch failed`  |
 *   | `HTTPS_PROXY` + `NODE_USE_ENV_PROXY=1`     | works           |
 *   | `process.env.HTTPS_PROXY` set at runtime   | no effect       |
 *
 * A plugin cannot restart the host it runs in, so depending on launch-time
 * environment variables would break the feature for exactly the users who need
 * a proxy most. This module tunnels through the proxy itself using only Node
 * built-ins: a `CONNECT` handshake over a raw socket, TLS layered on top for
 * `https:`, and Node's own `http`/`https` request machinery above that — so
 * headers, status codes, chunked bodies and timeouts stay standard code rather
 * than a hand-rolled parser.
 *
 * Both protocols are supported on purpose. NovelAI is `https:`, but tunnelling
 * `http:` as well is what lets the test suite verify the handshake end to end
 * against a stub proxy without minting a certificate.
 *
 * Zero external dependencies, like the rest of the package.
 */
import { request as httpRequestPlain, Agent as HttpAgent } from 'node:http'
import { request as httpsRequestPlain, Agent as HttpsAgent } from 'node:https'
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'

/** Ceiling on one response body; a 4-variant render is a few MB at most. */
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024
/** Ceiling on the proxy's CONNECT response header. */
const MAX_PROXY_HEADER_BYTES = 16 * 1024
/** Ceiling on a CONNECT header the proxy itself may send back after ours. */
const CONNECT_TIMEOUT_MS = 15000

/**
 * Open `socket -> proxy -> CONNECT -> [TLS] -> origin`.
 *
 * @param options - proxy URL, target host/port, whether to wrap in TLS, and the
 *   server name to validate the certificate against.
 * @returns a promise of a socket that already speaks to the origin.
 */
function tunnel(options) {
  const { proxy, targetHost, targetPort, useTls, servername } = options
  const parsed = new URL(proxy)
  const proxyPort = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80)

  return new Promise((resolve, reject) => {
    let settled = false
    let socket

    /**
     * Report a failure exactly once and tear the socket down.
     * @param error - the failure.
     */
    const fail = (error) => {
      if (settled) return
      settled = true
      socket?.destroy()
      reject(error)
    }

    try {
      socket = netConnect({ host: parsed.hostname, port: proxyPort })
    } catch (error) {
      fail(error)
      return
    }

    socket.setTimeout(CONNECT_TIMEOUT_MS, () => fail(new Error(`proxy CONNECT timed out after ${CONNECT_TIMEOUT_MS}ms`)))
    socket.once('error', fail)

    socket.once('connect', () => {
      const lines = [`CONNECT ${targetHost}:${targetPort} HTTP/1.1`, `Host: ${targetHost}:${targetPort}`]
      if (parsed.username || parsed.password) {
        const raw = `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`
        lines.push(`Proxy-Authorization: Basic ${Buffer.from(raw).toString('base64')}`)
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    })

    let buffered = Buffer.alloc(0)
    /**
     * Accumulate until the CONNECT response header is complete.
     * @param chunk - bytes from the proxy.
     */
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk])
      const end = buffered.indexOf('\r\n\r\n')
      if (end < 0) {
        if (buffered.length > MAX_PROXY_HEADER_BYTES) fail(new Error('proxy sent an oversized CONNECT response'))
        return
      }
      socket.removeListener('data', onData)
      socket.removeListener('error', fail)
      socket.setTimeout(0)
      if (settled) return

      const head = buffered.subarray(0, end).toString('latin1')
      const status = Number(/^HTTP\/1\.[01]\s+(\d{3})/.exec(head)?.[1] ?? 0)
      if (status !== 200) {
        fail(new Error(`proxy refused CONNECT (${head.split('\r\n')[0] || 'empty response'})`))
        return
      }
      // Anything the proxy sent after the header already belongs to the tunnel;
      // push it back so the layer above sees a clean stream.
      const rest = buffered.subarray(end + 4)
      if (rest.length > 0) socket.unshift(rest)

      settled = true
      if (!useTls) {
        resolve(socket)
        return
      }
      const tlsSocket = tlsConnect({ socket, servername: servername ?? targetHost })
      tlsSocket.once('secureConnect', () => resolve(tlsSocket))
      tlsSocket.once('error', fail)
    }
    socket.on('data', onData)
  })
}

/**
 * Build an agent class that hands Node a tunnelled socket.
 * @param Base - `node:http`.Agent or `node:https`.Agent.
 * @param useTls - whether to layer TLS over the tunnel.
 * @returns the agent class.
 */
function makeTunnelAgent(Base, useTls) {
  return class TunnelAgent extends Base {
    /**
     * @param proxyUrl - the proxy to tunnel through.
     */
    constructor(proxyUrl) {
      super({ keepAlive: false })
      this.proxyUrl = proxyUrl
    }

    /**
     * Node's single extension point for custom transports.
     * @param options - Node's connection options for the origin.
     * @param callback - `(error, socket)`.
     * @returns nothing.
     */
    createConnection(options, callback) {
      tunnel({
        proxy: this.proxyUrl,
        targetHost: options.host,
        targetPort: options.port ?? (useTls ? 443 : 80),
        useTls,
        servername: options.servername ?? options.host
      }).then(
        (socket) => callback(null, socket),
        (error) => callback(error)
      )
    }
  }
}

const HttpsTunnelAgent = makeTunnelAgent(HttpsAgent, true)
const HttpTunnelAgent = makeTunnelAgent(HttpAgent, false)

/** Agents are cached per proxy URL; one agent per request would leak sockets. */
const agentCache = new Map()
/**
 * Resolve (and memoize) the agents for a proxy.
 * @param proxyUrl - the proxy URL.
 * @returns both protocol agents.
 */
function agentsFor(proxyUrl) {
  let pair = agentCache.get(proxyUrl)
  if (pair === undefined) {
    pair = { https: new HttpsTunnelAgent(proxyUrl), http: new HttpTunnelAgent(proxyUrl) }
    agentCache.set(proxyUrl, pair)
  }
  return pair
}

/**
 * Decide which proxy to use.
 *
 * Accepted forms mirror how the value reads in the panel:
 *   - `''` / `auto` — use the detected system proxy when there is one
 *   - `off` / `none` / `direct` — never proxy
 *   - anything else — used verbatim as the proxy URL
 *
 * @param value - the configured value.
 * @param detected - a system proxy detected by the caller, if any.
 * @returns the proxy URL to use, or `null` for a direct connection.
 */
export function resolveProxy(value, detected = null) {
  const raw = String(value ?? '').trim()
  const lower = raw.toLowerCase()
  if (lower === 'off' || lower === 'none' || lower === 'direct') return null
  if (raw === '' || lower === 'auto') return detected ?? null
  return raw
}

/**
 * Perform one HTTP(S) request and collect the whole body.
 *
 * `Accept-Encoding: identity` is sent unless the caller overrides it: nothing
 * here transparently decompresses, and the NovelAI endpoints answer with a zip,
 * so asking for no content coding keeps the bytes unambiguous.
 *
 * @param options - url, method, headers, body, proxy, timeout and abort signal.
 * @returns `{ status, headers, body }`.
 */
export function httpRequest(options) {
  const {
    url,
    method = 'GET',
    headers = {},
    body = null,
    proxy = null,
    timeoutMs = 120000,
    signal = null,
    maxBytes = MAX_RESPONSE_BYTES
  } = options

  return new Promise((resolve, reject) => {
    let settled = false
    /**
     * Reject exactly once.
     * @param error - the failure.
     */
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }

    const target = new URL(url)
    const secure = target.protocol !== 'http:'
    const send = secure ? httpsRequestPlain : httpRequestPlain
    const agent = proxy === null ? undefined : (secure ? agentsFor(proxy).https : agentsFor(proxy).http)

    const request = send(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (secure ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method,
        headers: { 'Accept-Encoding': 'identity', ...headers },
        agent
      },
      (response) => {
        const chunks = []
        let size = 0
        response.on('data', (chunk) => {
          size += chunk.length
          if (size > maxBytes) {
            response.destroy()
            fail(new Error(`response exceeded ${maxBytes} bytes`))
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          if (settled) return
          settled = true
          resolve({ status: Number(response.statusCode ?? 0), headers: response.headers, body: Buffer.concat(chunks) })
        })
        response.on('error', fail)
      }
    )

    request.setTimeout(timeoutMs, () => request.destroy(new Error(`request timed out after ${timeoutMs}ms`)))
    request.on('error', fail)

    if (signal !== null && signal !== undefined) {
      if (signal.aborted) {
        request.destroy(new Error('aborted'))
        return
      }
      signal.addEventListener('abort', () => request.destroy(new Error('aborted')), { once: true })
    }

    if (body !== null) request.write(body)
    request.end()
  })
}
