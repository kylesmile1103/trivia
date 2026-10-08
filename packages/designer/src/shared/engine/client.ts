// Client for the engine API served by vite-plugin-ast-locator (docs/api.md). Same origin:
// the designer's dev server proxies /@trivia/api to the user's Vite server.

import type {
  ApiErrorPayload,
  ApplyResult,
  ComponentSchema,
  Envelope,
  Health,
  HistoryResult,
  HistoryState,
  ManifestState,
  NodeDetails,
  Op,
  SelectionState,
} from './types'

const BASE = '/@trivia/api'

export class ApiError extends Error {
  readonly code: ApiErrorPayload['code']
  readonly status: number

  constructor(payload: ApiErrorPayload, status: number) {
    super(payload.message)
    this.name = 'ApiError'
    this.code = payload.code
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(BASE + path, init)
  } catch (cause) {
    throw new ApiError({ code: 'io_error', message: `engine unreachable: ${String(cause)}` }, 0)
  }
  let body: Envelope<T>
  try {
    body = (await res.json()) as Envelope<T>
  } catch {
    throw new ApiError(
      { code: 'internal', message: `engine returned non-JSON (HTTP ${res.status}); is vite-plugin-ast-locator installed in the app?` },
      res.status,
    )
  }
  if (!body.ok) throw new ApiError(body.error, res.status)
  return body.data
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export const engine = {
  health: () => request<Health>('/health'),
  components: () => request<ComponentSchema[]>('/components'),
  inspect: (locator: string) => request<NodeDetails>(`/inspect?locator=${encodeURIComponent(locator)}`),
  apply: (op: Op, label?: string) => post<ApplyResult>('/apply', { op, label }),
  batch: (ops: Op[], label?: string) => post<ApplyResult>('/batch', { ops, label }),
  undo: () => post<HistoryResult>('/undo', {}),
  redo: () => post<HistoryResult>('/redo', {}),
  history: () => request<HistoryState>('/history'),
  selection: () => request<SelectionState>('/selection'),
  manifest: () => request<ManifestState>('/manifest'),
  nextScreenshot: () => request<{ id: string | null }>('/screenshot/next'),
  postScreenshot: (answer: { id: string; png: string; width: number; height: number } | { id: string; error: string }) =>
    post<null>('/screenshot', answer),
  select: (selection: { locator: string; name: string } | null) => post<SelectionState>('/selection', selection ?? { locator: null }),
}
