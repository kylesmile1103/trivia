import { BLUEPRINT_VERSION, loadDocument, manifestsToJsonSchema, project } from '@trivia/blueprint'

import type { EngineService } from '../api/service.js'
import type { Route } from '../api/http.js'
import { ApiError } from '../engine.js'
import type { BlueprintWorkspace } from './store.js'
import { readSummary } from './summary.js'

export function readDoc(workspace: BlueprintWorkspace, path: string | null, projection: boolean) {
  if (!path) throw new ApiError('invalid_op', 'Pass the document path under the blueprint directory, for example pages/Customers.page.json')
  const text = workspace.readDocumentText(path)
  if (text === null) throw new ApiError('node_not_found', `Blueprint document ${path} does not exist`)
  const entry = loadDocument(path, text)
  if (entry.diagnostics.some(({ code }) => code === 'unsupported_version')) {
    const found = (entry.value as { blueprintVersion?: number })?.blueprintVersion
    throw new ApiError('unsupported', entry.diagnostics[0]!.message, { found, supported: BLUEPRINT_VERSION })
  }
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
}
