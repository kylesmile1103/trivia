// Client for the engine API served by vite-plugin-ast-locator (docs/api.md). Same origin:
// the designer's dev server proxies /@trivia/api to the user's Vite server.

import type {
  ApiErrorPayload,
  AppRoute,
  ApplyResult,
  BlueprintBackendRequest,
  BlueprintBackendResult,
  BlueprintComponents,
  BlueprintDocument,
  BlueprintEjectPlan,
  BlueprintOp,
  BlueprintPatchResult,
  BlueprintPreview,
  BlueprintSummary,
  ColumnChange,
  ColumnPlan,
  ContractDrift,
  FieldChange,
  ComponentSchema,
  Envelope,
  Health,
  HistoryResult,
  HistoryState,
  ManifestState,
  PageKind,
  NodeDetails,
  Op,
  RefinePage,
  ResourcePages,
  SelectionState,
} from './types'

const BASE = '/@trivia/api'

export class ApiError extends Error {
  readonly code: ApiErrorPayload['code']
  readonly status: number
  readonly details?: Record<string, unknown>

  constructor(payload: ApiErrorPayload, status: number) {
    super(payload.message)
    this.name = 'ApiError'
    this.code = payload.code
    this.status = status
    this.details = payload.details
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

const blueprint = {
  summary: () => request<BlueprintSummary>('/blueprint'),
  doc: (path: string, projection = false) =>
    request<BlueprintDocument>(`/blueprint/doc?path=${encodeURIComponent(path)}${projection ? '&projection=1' : ''}`),
  components: () => request<BlueprintComponents>('/blueprint/components'),
  patch: (ops: BlueprintOp[], label: string) => post<BlueprintPatchResult>('/blueprint/patch', { ops, label }),
  preview: (page: string) => post<BlueprintPreview>('/blueprint/preview', { page }),
  plan: (pages?: string[]) => post<BlueprintEjectPlan>('/blueprint/plan', { pages }),
  ejected: (pages: string[], entry: string) => post<{ lockRev: string }>('/blueprint/ejected', { pages, entry }),
  backend: (body: BlueprintBackendRequest) => post<BlueprintBackendResult>('/blueprint/backend', body),
}

export const engine = {
  blueprint,
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
  routes: () => request<AppRoute[]>('/routes'),
  refinePages: () => request<RefinePage[]>('/refine/pages'),
  refinePage: (file: string) => request<RefinePage[]>(`/refine/page?file=${encodeURIComponent(file)}`),
  planColumns: (file: string, component: string, changes: ColumnChange[]) =>
    post<ColumnPlan>('/refine/columns/plan', { file, component, changes }),
  planFields: (file: string, component: string, changes: FieldChange[]) =>
    post<ColumnPlan>('/refine/fields/plan', { file, component, changes }),
  contractDrift: () => request<ContractDrift>('/refine/drift'),
  refineResources: () => request<ResourcePages[]>('/refine/resources'),
  planPages: (resource: string, pages?: PageKind[]) => post<ColumnPlan>('/refine/pages/plan', { resource, ...(pages ? { pages } : {}) }),
  sync: () => post<{ files: number; contractChanged: boolean; git: string }>('/sync', {}),
}
