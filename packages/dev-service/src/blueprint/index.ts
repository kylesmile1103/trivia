import { loadDocument, manifestsToJsonSchema, project } from '@trivia/blueprint'

import type { z } from 'zod'

import type { Route } from '../api/http.js'
import type { EngineService } from '../api/service.js'
import { ApiError } from '../engine.js'
import { backendInput } from './backend.js'
import { ejectedInput, planEject, planInput, recordEjected } from './plan.js'
import { previewInput, previewPage } from './preview.js'
import { checkDocumentVersion, type BlueprintWorkspace } from './store.js'
import { readSummary } from './summary.js'

export function readDoc(workspace: BlueprintWorkspace, path: string | null, projection: boolean) {
  if (!path) throw new ApiError('invalid_op', 'Pass the document path under the blueprint directory, for example pages/Customers.page.json')
  const text = workspace.readDocumentText(path)
  if (text === null) throw new ApiError('node_not_found', `Blueprint document ${path} does not exist`)
  const entry = loadDocument(path, text)
  checkDocumentVersion(entry)
  if (!entry.doc) throw new ApiError('invalid_result', `Could not read blueprint document ${path}`, { diagnostics: entry.diagnostics })
  return {
    path, rev: entry.rev, doc: entry.doc,
    ...(projection && entry.kind === 'page' && { projection: project(entry.doc) }),
  }
}

export function readComponents(workspace: BlueprintWorkspace) {
  const { index, schemas } = manifestsToJsonSchema(workspace.manifests().manifests)
  return { components: index, schemas }
}

export function registerBlueprintRoutes(routes: Map<string, Route>, service: EngineService): void {
  const workspace = service.blueprint
  routes.set('/blueprint', { GET: () => readSummary(workspace) })
  routes.set('/blueprint/doc', { GET: (url) => readDoc(workspace, url.searchParams.get('path'), url.searchParams.get('projection') === '1') })
  routes.set('/blueprint/components', { GET: () => readComponents(workspace) })
  routes.set('/blueprint/patch', { POST: (_url, { ops, label }) => {
    if (!Array.isArray(ops) || ops.length === 0 || typeof label !== 'string' || label.trim() === '') {
      throw new ApiError('invalid_op', 'Pass { ops: BlueprintOp[] (non-empty), label: string (non-blank) }')
    }
    return service.patchBlueprint(ops, label.trim())
  } })
  routes.set('/blueprint/preview', { POST: (_url, body) => previewPage(request(previewInput, body)) })
  routes.set('/blueprint/plan', { POST: (_url, body) => planEject(request(planInput, body)) })
  routes.set('/blueprint/ejected', { POST: (_url, body) => recordEjected(request(ejectedInput, body)) })
  routes.set('/blueprint/backend', { POST: (_url, body) => service.blueprintBackend(request(backendInput, body)) })
}

function request<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body)
  if (parsed.success) return parsed.data
  throw new ApiError('invalid_op', 'Invalid blueprint request', {
    issues: parsed.error.issues.map(({ path, message }) => ({ path, message })),
  })
}
