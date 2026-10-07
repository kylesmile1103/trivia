// The engine HTTP API (docs/api.md), served by the user's dev server at /@trivia/api; the
// designer reaches it through its same-origin proxy. Requests that change files run through
// one queue, so two edits never interleave their read-modify-write of a file.

import type { IncomingMessage, ServerResponse } from 'node:http'
import net from 'node:net'

import { ApiError, type EngineBinding, type GuardedWrite, type OpsResult, unwrap } from './engine.js'
import { History } from './history.js'
import { SerialQueue } from './queue.js'
import type { ApplyResult, ErrorCode, Health, HistoryResult, HistoryState } from './types.js'

export const API_BASE = '/@trivia/api'

/** docs/api.md: an error's HTTP status follows from its code. */
const STATUS: Record<ErrorCode, number> = {
  invalid_locator: 400,
  invalid_op: 400,
  invalid_snippet: 400,
  parse_error: 400,
  forbidden: 403,
  node_not_found: 404,
  stale_locator: 409,
  conflict: 409,
  unsupported: 422,
  unresolved_component: 422,
  invalid_result: 422,
  path_outside_root: 422,
  io_error: 500,
  internal: 500,
}

// The API writes to disk, so it answers only this machine (docs/api.md "Envelope"): loopback
// clients, a Host header that names this machine, and pages served from localhost.
const LOOPBACK = new net.BlockList()
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4') // also matches IPv4-mapped IPv6 (::ffff:127.0.0.1)
LOOPBACK.addAddress('::1', 'ipv6')
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])
/** `name[:port]` or `[ipv6][:port]`, lowercased. */
const HOST_HEADER = /^(?:\[([0-9a-f:.]+)\]|([a-z0-9._-]+))(?::\d{1,5})?$/
const MAX_BODY_BYTES = 5 * 1024 * 1024

export interface ApiOptions {
  /** Absolute project root; every file in the API is relative to it. */
  root: string
  uiDir: string
  importBase: string
  version: string
  engine: EngineBinding
  /** Undo entries kept (docs/api.md: 100). */
  historyLimit?: number
  /** Unexpected failures are logged here as well as returned as `internal`. */
  logger?: { error(message: string): void }
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

export type Middleware = (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => void

type Json = Record<string, unknown>

interface Route {
  method: 'GET' | 'POST'
  handle(url: URL, body: Json): unknown
}

export function createApiMiddleware(options: ApiOptions): Middleware {
  const { root, uiDir, importBase, version, engine } = options
  const history = new History(options.historyLimit ?? 100)
  const queue = new SerialQueue()

  /** Apply ops as one transaction (the engine writes all files or none) and record it. */
  const transact = (ops: Json[], label: string): ApplyResult => {
    const result = unwrap<OpsResult>(engine.applyOps(root, JSON.stringify(ops)))
    if (result.changes.length > 0) history.record({ label, changes: result.changes })
    return { file: result.file, changed: result.changed, locator: result.locator, history: history.state() }
  }

  /** Undo writes each `before` back where the file still holds `after`; redo mirrors it. */
  const travel = (direction: 'undo' | 'redo'): HistoryResult => {
    const entry = direction === 'undo' ? history.nextUndo : history.nextRedo
    if (!entry) return { files: [], history: history.state() }
    const writes: GuardedWrite[] =
      direction === 'undo'
        ? entry.changes.toReversed().map((c) => ({ file: c.file, expected: c.after, content: c.before }))
        : entry.changes.map((c) => ({ file: c.file, expected: c.before, content: c.after }))
    try {
      unwrap<null>(engine.restoreFiles(root, JSON.stringify(writes)))
    } catch (error) {
      if (error instanceof ApiError) throw new ApiError(error.code, `${direction} "${entry.label}" failed: ${error.message}`)
      throw error
    }
    if (direction === 'undo') history.undone()
    else history.redone()
    return { files: entry.changes.map((c) => c.file), history: history.state() }
  }

  const routes = new Map<string, Route>([
    ['/health', { method: 'GET', handle: (): Health => ({ root, uiDir, importBase, version }) }],
    ['/components', { method: 'GET', handle: () => unwrap<unknown[]>(engine.components(root, uiDir, importBase)) }],
    [
      '/inspect',
      {
        method: 'GET',
        handle: (url) => {
          const locator = url.searchParams.get('locator')
          if (!locator) throw new ApiError('invalid_locator', 'missing ?locator=<file>#<component>#<i.j.k>')
          return unwrap<unknown>(engine.inspect(root, locator))
        },
      },
    ],
    ['/history', { method: 'GET', handle: (): HistoryState => history.state() }],
    [
      '/apply',
      {
        method: 'POST',
        handle: (_url, body) => {
          const op = body['op']
          if (!isObject(op)) throw new ApiError('invalid_op', 'body must be { op: Op, label?: string }')
          const label = labelOf(body, describe(op))
          return queue.run(() => transact([op], label))
        },
      },
    ],
    [
      '/batch',
      {
        method: 'POST',
        handle: (_url, body) => {
          const ops = body['ops']
          if (!Array.isArray(ops) || ops.length === 0 || !ops.every(isObject)) {
            throw new ApiError('invalid_op', 'body must be { ops: Op[] (non-empty), label?: string }')
          }
          const label = labelOf(body, `${ops.length} edits`)
          return queue.run(() => transact(ops, label))
        },
      },
    ],
    ['/undo', { method: 'POST', handle: () => queue.run(() => travel('undo')) }],
    ['/redo', { method: 'POST', handle: () => queue.run(() => travel('redo')) }],
  ])

  const dispatch = async (req: IncomingMessage, url: URL): Promise<unknown> => {
    checkCaller(req, options.allowRemote ?? false, options.allowedHosts ?? [])
    const name = url.pathname.slice(API_BASE.length)
    const route = routes.get(name)
    if (!route) throw new ApiError('invalid_op', `unknown endpoint ${url.pathname} (see docs/api.md)`)
    if (req.method !== route.method) {
      throw new ApiError('invalid_op', `${url.pathname} takes ${route.method}, not ${req.method ?? 'an unknown method'}`)
    }
    if (route.method === 'GET') return route.handle(url, {})
    if (!isJsonContentType(req.headers['content-type'])) {
      throw new ApiError('invalid_op', `${url.pathname} requires content-type: application/json`)
    }
    return route.handle(url, await readBody(req))
  }

  const respond = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    try {
      send(res, 200, { ok: true, data: await dispatch(req, url) })
    } catch (error) {
      let failure: ApiError
      if (error instanceof ApiError) {
        failure = error
      } else {
        const detail = error instanceof Error ? error.message : String(error)
        options.logger?.error(`[trivia] ${req.method} ${url.pathname} failed: ${error instanceof Error ? (error.stack ?? detail) : detail}`)
        failure = new ApiError('internal', `unexpected failure: ${detail}`)
      }
      send(res, STATUS[failure.code] ?? 500, { ok: false, error: { code: failure.code, message: failure.message } })
    }
  }

  return (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (!url.pathname.startsWith(`${API_BASE}/`)) {
      next()
      return
    }
    void respond(req, res, url)
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
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
function checkCaller(req: IncomingMessage, allowRemote: boolean, allowedHosts: readonly string[] | true): void {
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
function isLoopback(address: string | undefined): boolean {
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

function isJsonContentType(header: string | undefined): boolean {
  return header?.split(';')[0]?.trim().toLowerCase() === 'application/json'
}

async function readBody(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    // Past the cap, keep draining (without buffering) so the error response can still be sent.
    if (size <= MAX_BODY_BYTES) chunks.push(chunk)
  }
  if (size > MAX_BODY_BYTES) throw new ApiError('invalid_op', `request body exceeds ${MAX_BODY_BYTES} bytes`)
  let value: unknown
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (error) {
    throw new ApiError('invalid_op', `request body is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isObject(value)) throw new ApiError('invalid_op', 'request body must be a JSON object ({} for undo/redo)')
  return value
}

function labelOf(body: Json, fallback: string): string {
  const label = body['label']
  if (label === undefined || label === null) return fallback
  if (typeof label !== 'string') throw new ApiError('invalid_op', '`label` must be a string')
  return label.trim() || fallback
}

/** A default history label when the caller sends none. */
function describe(op: Json): string {
  const name = typeof op['expectedName'] === 'string' ? `<${op['expectedName']}>` : 'element'
  const prop = typeof op['prop'] === 'string' ? op['prop'] : 'prop'
  switch (op['op']) {
    case 'updateProp':
      return op['value'] === null ? `Remove ${prop}` : `Set ${prop}`
    case 'insert':
    case 'insertChild':
      return 'Insert element'
    case 'remove':
      return `Remove ${name}`
    case 'move':
    case 'moveNode':
      return `Move ${name}`
    case 'bindQuery':
      return `Bind ${name} to ${typeof op['optionsFn'] === 'string' ? op['optionsFn'] : 'a query'}`
    default:
      return 'Edit'
  }
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
