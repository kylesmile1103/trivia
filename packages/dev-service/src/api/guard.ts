// Who may call the engine API and the MCP endpoint (docs/api.md "Envelope"): both rewrite
// source files, so they answer only this machine.

import type { IncomingMessage } from 'node:http'
import net from 'node:net'

import { ApiError } from '../engine.js'

// Loopback clients, a Host header that names this machine, and pages served from localhost.
const LOOPBACK = new net.BlockList()
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4') // also matches IPv4-mapped IPv6 (::ffff:127.0.0.1)
LOOPBACK.addAddress('::1', 'ipv6')
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])
/** `name[:port]` or `[ipv6][:port]`, lowercased. */
const HOST_HEADER = /^(?:\[([0-9a-f:.]+)\]|([a-z0-9._-]+))(?::\d{1,5})?$/

export interface CallerRules {
  /**
   * Also answer clients on other machines. Dangerous: anyone who can reach the server can then
   * rewrite source files. Default false: loopback clients only.
   */
  allowRemote?: boolean
  /**
   * Vite's resolved `server.allowedHosts`: Host names accepted besides `localhost` and IP
   * literals (`true`: any). Default: none.
   */
  allowedHosts?: readonly string[] | true
}

/**
 * Refuse callers that are not on this machine. Three independent checks, each closing a
 * different hole:
 * - the client address: a non-browser client on the network (`vite --host`) sends no Origin;
 * - the Host header: a DNS-rebinding page reaches 127.0.0.1 under its own name, and its
 *   same-origin GETs carry no Origin. Vite has its own check, but skips it under
 *   `server.https`, so the API does not rely on it;
 * - the Origin header: a page on another site that calls the API cross-origin.
 */
export function checkCaller(req: IncomingMessage, { allowRemote = false, allowedHosts = [] }: CallerRules): void {
  const address = req.socket.remoteAddress
  if (!allowRemote && !isLoopback(address)) {
    throw new ApiError(
      'forbidden',
      `refusing a request from ${address ?? 'an unknown address'}: the engine API rewrites source files, so it only ` +
        'answers loopback clients on this machine. astLocator({ allowRemote: true }) serves every client that can reach ' +
        'this server, which lets any of them edit your code',
    )
  }
  const authority = req.headers.host ?? req.headers[':authority'] // HTTP/2 sends :authority
  const host = typeof authority === 'string' ? authority : undefined
  if (!isAllowedHost(host, allowedHosts)) {
    throw new ApiError(
      'forbidden',
      `refusing a request for host ${host || '(none)'}: the engine API only answers localhost, *.localhost, IP ` +
        'addresses and server.allowedHosts (a guard against DNS rebinding)',
    )
  }
  const origin = req.headers.origin
  if (origin !== undefined && !isLocalOrigin(origin)) {
    throw new ApiError('forbidden', `refusing a request from origin ${origin}: the engine API only serves localhost pages`)
  }
}

/** 127.0.0.0/8 or ::1, also IPv4-mapped. Unknown (a Unix socket, a closed connection) is not. */
export function isLoopback(address: string | undefined): boolean {
  if (address === undefined) return false
  const family = net.isIP(address)
  return family !== 0 && LOOPBACK.check(address, family === 4 ? 'ipv4' : 'ipv6')
}

/**
 * Vite's rules: `localhost` and `*.localhost` (reserved names that resolve to loopback), any
 * IP literal (rebinding needs a name), `server.allowedHosts`. Vite 8.3.3 has them in
 * `isHostAllowedInternal` (`vite/dist/node/chunks/node.js:16970-16982`, from
 * host-validation-middleware 0.1.4).
 */
function isAllowedHost(host: string | undefined, allowedHosts: readonly string[] | true): boolean {
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
