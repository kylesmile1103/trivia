// The engine HTTP API (docs/api.md), served by the user's dev server at /@trivia/api; the
// designer reaches it through its same-origin proxy. The routes only parse requests: what
// they do is EngineService (./service.ts), which the MCP endpoint shares.

import type { IncomingMessage, ServerResponse } from 'node:http'

import { LOCK_FILE } from '@trivia/blueprint-compiler'

import { registerBlueprintRoutes } from '../blueprint/index.js'
import { ApiError } from '../engine.js'
import { parseColumnChanges, parseFieldChanges, parsePreviewRequest } from '../refine/index.js'
import type { ErrorCode, Health, HistoryState } from '../types.js'
import { type CallerRules, checkCaller, isLoopback } from './guard.js'
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
  file_not_found: 404,
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
/** A canvas PNG, base64: a tall page at its full width runs to several MB. */
const MAX_SCREENSHOT_BYTES = 24 * 1024 * 1024

export interface ApiOptions extends CallerRules {
  service: EngineService
  /** Unexpected failures are logged here as well as returned as `internal`. */
  logger?: { error(message: string): void }
}

export type Middleware = (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => void

type Method = 'GET' | 'POST'
/** `signal` aborts when the caller hangs up before the answer is sent. */
export type Route = Partial<Record<Method, (url: URL, body: Json, signal: AbortSignal) => unknown>>

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
    ['/routes', { GET: () => service.routes() }],
    ['/refine/pages', { GET: () => service.refine.pages() }],
    [
      '/refine/page',
      {
        GET: (url) => {
          const file = url.searchParams.get('file')
          if (!file) throw new ApiError('invalid_op', 'missing ?file=<project-relative path>')
          return service.refine.page(file)
        },
      },
    ],
    [
      '/refine/columns/plan',
      {
        POST: (_url, body) => {
          const { file, component } = body
          if (typeof file !== 'string' || (component !== undefined && typeof component !== 'string')) {
            throw new ApiError('invalid_op', 'body must be { file: string, component?: string, changes: [...] }')
          }
          return service.refine.planColumns(file, component, parseColumnChanges(body['changes']))
        },
      },
    ],
    ['/refine/drift', { GET: () => service.refine.drift() }],
    ['/refine/resources', { GET: () => service.refine.resources() }],
    // The inferencer (docs/product.md, slice 6): a page from the contract to preview, then eject.
    ['/refine/preview', { POST: (_url, body) => service.refine.preview(parsePreviewRequest(body)) }],
    ['/refine/eject', { POST: (_url, body) => service.refine.planEject(parsePreviewRequest(body)) }],
    [
      '/refine/pages/plan',
      {
        POST: (_url, body) => {
          const { resource, pages } = body
          const kinds = ['list', 'create', 'edit', 'show']
          if (typeof resource !== 'string' || (pages !== undefined && !(Array.isArray(pages) && pages.every((p) => typeof p === 'string' && kinds.includes(p))))) {
            throw new ApiError('invalid_op', 'body must be { resource: string, pages?: ("list" | "create" | "edit" | "show")[] }')
          }
          return service.refine.planPages(resource, pages as Array<'list' | 'create' | 'edit' | 'show'> | undefined)
        },
      },
    ],
    [
      '/refine/fields/plan',
      {
        POST: (_url, body) => {
          const { file, component } = body
          if (typeof file !== 'string' || (component !== undefined && typeof component !== 'string')) {
            throw new ApiError('invalid_op', 'body must be { file: string, component?: string, changes: [...] }')
          }
          return service.refine.planFields(file, component, parseFieldChanges(body['changes']))
        },
      },
    ],
    ['/history', { GET: (): HistoryState => service.history() }],
    ['/manifest', { GET: () => service.manifest() }],
    [
      '/sync',
      {
        POST: (_url, body) => {
          const { input, zod, force } = body
          if ((input !== undefined && typeof input !== 'string') || (zod !== undefined && typeof zod !== 'boolean') || (force !== undefined && typeof force !== 'boolean')) {
            throw new ApiError('invalid_op', 'body must be { input?: string, zod?: boolean, force?: boolean }')
          }
          return service.syncContract({ ...(input !== undefined ? { input } : {}), ...(zod !== undefined ? { zod } : {}), ...(force !== undefined ? { force } : {}) })
        },
      },
    ],
    ['/screenshot/next', { GET: (_url, _body, signal) => service.nextScreenshot(undefined, signal) }],
    [
      '/screenshot',
      {
        POST: (_url, body) => {
          const { id, png, width, height, error } = body
          if (typeof id !== 'string') throw new ApiError('invalid_op', 'body must be { id, png, width, height } or { id, error }')
          if (typeof error === 'string') service.fulfillScreenshot(id, { error })
          else if (typeof png === 'string' && typeof width === 'number' && typeof height === 'number') {
            service.fulfillScreenshot(id, { png: png.replace(/^data:image\/png;base64,/, ''), width, height })
          } else throw new ApiError('invalid_op', 'body must be { id, png, width, height } or { id, error }')
          return null
        },
      },
    ],
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

  registerBlueprintRoutes(routes, service)

  const dispatch = async (req: IncomingMessage, url: URL, signal: AbortSignal): Promise<unknown> => {
    const name = url.pathname.slice(API_BASE.length)
    if ((name === '/blueprint' || name.startsWith('/blueprint/')) && !isLoopback(req.socket.remoteAddress)) {
      throw new ApiError('forbidden', 'The blueprint API only answers loopback clients on this machine.')
    }
    checkCaller(req, options)
    const route = routes.get(name)
    if (!route) throw new ApiError('invalid_op', `unknown endpoint ${url.pathname} (see docs/api.md)`)
    const method = req.method === 'GET' || req.method === 'POST' ? req.method : null
    const handle = method === null ? undefined : route[method]
    if (!handle) {
      const allowed = Object.keys(route).join(' or ')
      throw new ApiError('invalid_op', `${url.pathname} takes ${allowed}, not ${req.method ?? 'an unknown method'}`)
    }
    if (method === 'GET') return handle(url, {}, signal)
    if (!isJsonContentType(req.headers['content-type'])) {
      throw new ApiError('invalid_op', `${url.pathname} requires content-type: application/json`)
    }
    const body = await readBody(req, name === '/screenshot' ? MAX_SCREENSHOT_BYTES : MAX_BODY_BYTES)
    if ((name === '/apply' || name === '/batch') && !isLoopback(req.socket.remoteAddress)) {
      const ops = Array.isArray(body.ops) ? body.ops : [body.op]
      if (ops.some((op) => isObject(op) && typeof op.file === 'string' && op.file.split('/').at(-1) === LOCK_FILE)) {
        throw new ApiError('forbidden', 'Blueprint eject requires a loopback caller.')
      }
    }
    return handle(url, body, signal)
  }

  const respond = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const hangUp = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) hangUp.abort()
    })
    try {
      send(res, 200, { ok: true, data: await dispatch(req, url, hangUp.signal) })
    } catch (error) {
      let failure: ApiError
      if (error instanceof ApiError) {
        failure = error
      } else {
        const detail = error instanceof Error ? error.message : String(error)
        options.logger?.error(`[trivia] ${req.method} ${url.pathname} failed: ${error instanceof Error ? (error.stack ?? detail) : detail}`)
        failure = new ApiError('internal', `unexpected failure: ${detail}`)
      }
      send(res, STATUS[failure.code] ?? 500, { ok: false, error: { code: failure.code, message: failure.message, ...(failure.details && { details: failure.details }) } })
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

async function readBody(req: IncomingMessage, max: number): Promise<Json> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    // Past the cap, keep draining (without buffering) so the error response can still be sent.
    if (size <= max) chunks.push(chunk)
  }
  if (size > max) throw new ApiError('invalid_op', `request body exceeds ${max} bytes`)
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
