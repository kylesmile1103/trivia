// The engine HTTP API (docs/api.md), served by the user's dev server at /@trivia/api; the
// designer reaches it through its same-origin proxy. The routes only parse requests: what
// they do is EngineService (./service.ts), which the MCP endpoint shares.

import type { IncomingMessage, ServerResponse } from 'node:http'

import { ApiError } from '../engine.js'
import type { ErrorCode, Health, HistoryState } from '../types.js'
import { type CallerRules, checkCaller } from './guard.js'
import { type EngineService, type Json, isObject } from './service.js'

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

const MAX_BODY_BYTES = 5 * 1024 * 1024

export interface ApiOptions extends CallerRules {
  service: EngineService
  /** Unexpected failures are logged here as well as returned as `internal`. */
  logger?: { error(message: string): void }
}

export type Middleware = (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => void

type Method = 'GET' | 'POST'
type Route = Partial<Record<Method, (url: URL, body: Json) => unknown>>

export function createApiMiddleware(options: ApiOptions): Middleware {
  const { service } = options

  const routes = new Map<string, Route>([
    ['/health', { GET: (): Health => service.health() }],
    ['/components', { GET: () => service.components() }],
    [
      '/inspect',
      {
        GET: (url) => {
          const locator = url.searchParams.get('locator')
          if (!locator) throw new ApiError('invalid_locator', 'missing ?locator=<file>#<component>#<i.j.k>')
          return service.inspect(locator)
        },
      },
    ],
    [
      '/outline',
      {
        GET: (url) => {
          const file = url.searchParams.get('file')
          if (!file) throw new ApiError('invalid_op', 'missing ?file=<project-relative path>')
          return service.outline(file)
        },
      },
    ],
    ['/history', { GET: (): HistoryState => service.history() }],
    [
      '/selection',
      {
        GET: () => service.selection(),
        POST: (_url, body) => {
          const { locator, name } = body
          if (locator === null) return service.select(null)
          if (typeof locator !== 'string' || typeof name !== 'string' || name === '') {
            throw new ApiError('invalid_op', 'body must be { locator: string, name: string } or { locator: null }')
          }
          return service.select({ locator, name })
        },
      },
    ],
    [
      '/apply',
      {
        POST: (_url, body) => {
          const op = body['op']
          if (!isObject(op)) throw new ApiError('invalid_op', 'body must be { op: Op, label?: string }')
          return service.apply(op, labelOf(body))
        },
      },
    ],
    [
      '/batch',
      {
        POST: (_url, body) => {
          const ops = body['ops']
          if (!Array.isArray(ops) || ops.length === 0 || !ops.every(isObject)) {
            throw new ApiError('invalid_op', 'body must be { ops: Op[] (non-empty), label?: string }')
          }
          return service.batch(ops, labelOf(body))
        },
      },
    ],
    ['/undo', { POST: () => service.undo() }],
    ['/redo', { POST: () => service.redo() }],
  ])

  const dispatch = async (req: IncomingMessage, url: URL): Promise<unknown> => {
    checkCaller(req, options)
    const name = url.pathname.slice(API_BASE.length)
    const route = routes.get(name)
    if (!route) throw new ApiError('invalid_op', `unknown endpoint ${url.pathname} (see docs/api.md)`)
    const method = req.method === 'GET' || req.method === 'POST' ? req.method : null
    const handle = method === null ? undefined : route[method]
    if (!handle) {
      const allowed = Object.keys(route).join(' or ')
      throw new ApiError('invalid_op', `${url.pathname} takes ${allowed}, not ${req.method ?? 'an unknown method'}`)
    }
    if (method === 'GET') return handle(url, {})
    if (!isJsonContentType(req.headers['content-type'])) {
      throw new ApiError('invalid_op', `${url.pathname} requires content-type: application/json`)
    }
    return handle(url, await readBody(req))
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

/** The body's `label`, or undefined for the service's default. */
function labelOf(body: Json): string | undefined {
  const label = body['label']
  if (label === undefined || label === null) return undefined
  if (typeof label !== 'string') throw new ApiError('invalid_op', '`label` must be a string')
  return label.trim() || undefined
}
