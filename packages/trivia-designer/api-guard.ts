// The engine API (/@trivia/api, served by vite-plugin-ast-locator in the user's dev server)
// rewrites source files, so the plugin answers only this machine (docs/api.md, Envelope). This
// designer proxies it, and the proxy hides two of the plugin's three checks: it reaches the
// user's server from loopback whoever its client is, and `changeOrigin` rewrites Host to the
// target. So the designer makes the same checks itself before its proxy forwards anything.

import type { IncomingMessage, ServerResponse } from 'node:http'
import net from 'node:net'

import type { Plugin } from 'vite'

const API_BASE = '/@trivia/api'

const LOOPBACK = new net.BlockList()
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4') // also matches IPv4-mapped IPv6 (::ffff:127.0.0.1)
LOOPBACK.addAddress('::1', 'ipv6')
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])
/** `name[:port]` or `[ipv6][:port]`, lowercased. */
const HOST_HEADER = /^(?:\[([0-9a-f:.]+)\]|([a-z0-9._-]+))(?::\d{1,5})?$/

type AllowedHosts = readonly string[] | true
type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void

/**
 * Refuse /@trivia/api to callers not on this machine, with the plugin's 403 envelope. Its
 * middleware is registered directly in configureServer, so it runs before Vite's proxy
 * (vite 8.3.3 `dist/node/chunks/node.js`: plugin hooks at 25053, proxy at 25058; preview
 * server 35643 and 35645). WebSocket upgrades never reach a middleware: see `isApiUpgrade`.
 */
export function apiGuard(): Plugin {
  return {
    name: 'trivia:designer-api-guard',
    configureServer(server) {
      server.middlewares.use(guardMiddleware(server.config.server.allowedHosts))
    },
    configurePreviewServer(server) {
      server.middlewares.use(guardMiddleware(server.config.preview.allowedHosts))
    },
  }
}

/**
 * For the proxy's `bypass`: true for a WebSocket upgrade (no `res`) to the engine API. The
 * API has no WebSocket endpoint, and an upgrade skips every middleware, so the proxy would
 * otherwise tunnel it to the user's server from loopback; returning false answers 404.
 */
export function isApiUpgrade(req: IncomingMessage, res: ServerResponse | undefined): boolean {
  return res === undefined && isApiPath(req.url)
}

/** The middleware `apiGuard` registers; `allowedHosts` is the server's resolved option. */
export function guardMiddleware(allowedHosts: AllowedHosts): Middleware {
  return (req, res, next) => {
    if (!isApiPath(req.url)) {
      next()
      return
    }
    const refusal = refusalFor(req, allowedHosts)
    if (refusal === null) {
      next()
      return
    }
    res.statusCode = 403
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify({ ok: false, error: { code: 'forbidden', message: refusal } }))
  }
}

/**
 * Whether the plugin could serve `url` as the API once the proxy forwards it. The URL is
 * parsed twice on the way: the proxy (http-proxy-3) normalizes the path and forwards the
 * result, and the plugin parses that again. Both use WHATWG URL, which drops dot segments
 * (`%2e` too) and reads `\` as `/`; read relative to a host, a path that starts with `//` is
 * a host followed by a path. So `/x/..//evil/@trivia/api/apply` is forwarded as
 * `//evil/@trivia/api/apply`, which the plugin serves as the API. This follows every reading
 * (as a path, and as `//host/path`) three parses deep, one more than happens. Also true for
 * the bare base, which the plugin leaves to Vite: refusing that costs nothing.
 */
export function isApiPath(url: string | undefined): boolean {
  let pending = [url ?? '/']
  const seen = new Set(pending)
  for (let depth = 0; depth < 3; depth++) {
    const next: string[] = []
    for (const reading of pending) {
      for (const pathname of readings(reading)) {
        if (pathname === null) return true // unparseable: refuse rather than guess
        if (pathname === API_BASE || pathname.startsWith(`${API_BASE}/`)) return true
        if (!seen.has(pathname)) {
          seen.add(pathname)
          next.push(pathname)
        }
      }
    }
    pending = next
  }
  return false
}

/** `url`'s pathname read relative to a host (as the plugin does), and as a path on one (as the proxy does `//…`). */
function readings(url: string): (string | null)[] {
  const parse = (input: string, base?: string) => {
    try {
      return new URL(input, base).pathname
    } catch {
      return null
    }
  }
  const relative = parse(url, 'http://localhost')
  return url.startsWith('/') ? [relative, parse(`http://localhost${url}`)] : [relative]
}

/** Why the plugin's three checks refuse `req`, or null when they pass. */
function refusalFor(req: IncomingMessage, allowedHosts: AllowedHosts): string | null {
  const address = req.socket.remoteAddress
  if (!isLoopback(address)) {
    return (
      `refusing a request from ${address ?? 'an unknown address'}: the designer forwards the engine API, which ` +
      'rewrites source files, only for clients on this machine (the user\'s dev server cannot see who it forwards for)'
    )
  }
  const authority = req.headers.host ?? req.headers[':authority']
  const host = typeof authority === 'string' ? authority : undefined
  if (!isAllowedHost(host, allowedHosts)) {
    return (
      `refusing a request for host ${host || '(none)'}: the designer forwards the engine API only for localhost, ` +
      '*.localhost, IP addresses and server.allowedHosts (a guard against DNS rebinding)'
    )
  }
  const origin = req.headers.origin
  if (origin !== undefined && !isLocalOrigin(origin)) {
    return `refusing a request from origin ${origin}: the designer forwards the engine API only for localhost pages`
  }
  return null
}

/** 127.0.0.0/8 or ::1, also IPv4-mapped. Unknown (a closed connection) is not. */
function isLoopback(address: string | undefined): boolean {
  if (address === undefined) return false
  const family = net.isIP(address)
  return family !== 0 && LOOPBACK.check(address, family === 4 ? 'ipv4' : 'ipv6')
}

/** Vite's rules: `localhost`, `*.localhost`, any IP literal, `server.allowedHosts`. */
function isAllowedHost(host: string | undefined, allowedHosts: AllowedHosts): boolean {
  if (allowedHosts === true) return true
  const match = host === undefined ? null : HOST_HEADER.exec(host.trim().toLowerCase())
  if (!match) return false
  const [, ipv6, name = ''] = match
  if (ipv6 !== undefined) return net.isIPv6(ipv6)
  if (name === 'localhost' || name.endsWith('.localhost') || net.isIPv4(name)) return true
  return allowedHosts.some((entry) => {
    const allowed = entry.toLowerCase()
    return allowed === name || (allowed.startsWith('.') && (allowed.slice(1) === name || name.endsWith(allowed)))
  })
}

function isLocalOrigin(origin: string): boolean {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false // includes the opaque origin "null"
  }
  return (url.protocol === 'http:' || url.protocol === 'https:') && LOCAL_HOSTNAMES.has(url.hostname)
}
