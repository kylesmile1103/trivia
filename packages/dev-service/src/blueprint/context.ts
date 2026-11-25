import {
  exposedScope, expressionCheck, manifestCheck, toPointer,
  type DeferredComponents, type Diagnostic, type LayerCheck, type ManifestResolution, type PageDoc, type ResolvedManifests, type ValidationContext,
} from '@trivia/blueprint'
import { checkDataTable, checkForm, nextBoundaryCheck } from '@trivia/blueprint-compiler'
import type { ManifestResource, TriviaManifest } from '@trivia/contract-sync'

import type { EngineBinding } from '../engine.js'
import { bodyFields } from '../refine/form.js'

const pageOperation = { list: 'list', show: 'get', create: 'create', edit: 'update' } as const

function contractCheck(manifest: TriviaManifest | null, manifests: ResolvedManifests): LayerCheck {
  const resources = new Map(manifest?.resources.map((resource) => [resource.name, resource]))
  const knownResources = [...resources.keys()].sort().join(', ')
  return (blueprint) => {
    const diagnostics: Diagnostic[] = []
    for (const { path: doc, kind, doc: page } of Object.values(blueprint.docs)) {
      if (kind !== 'page' || !page) continue
      const report = (code: string, at: PropertyKey[], message: string, hint?: string) => {
        diagnostics.push({ code, severity: 'error', doc, pointer: toPointer(at), message, ...(hint && { hint: { text: hint } }) })
      }
      const resourceOf = (name: string, at: PropertyKey[]): ManifestResource | undefined => {
        const resource = resources.get(name)
        if (!resource) report('unknown_resource', at, `Unknown resource "${name}"`,
          knownResources ? `Known resources: ${knownResources}.` : 'No resources are available in trivia.manifest.json. Run contract-sync to import a contract.')
        return resource
      }
      const checkOperation = (resource: ManifestResource, operation: string, at: PropertyKey[], kind: 'crud' | 'custom' | 'mutation') => {
        const crud = Object.entries(resource.operations).some(([name, op]) => op !== null && (
          kind === 'crud' ? name === operation : kind === 'mutation' && op.method !== 'GET' &&
            [name, op.operationId, op.sdkFn].includes(operation)
        ))
        const custom = kind !== 'crud' && resource.customOperations.some((op) =>
          (kind !== 'mutation' || op.method !== 'GET') && [op.operationId, op.sdkFn].includes(operation))
        if (!crud && !custom) report('unsupported_operation', at, `${resource.name} has no supported ${operation} operation`)
      }
      const resource = page.resource === undefined ? undefined : resourceOf(page.resource, ['resource'])
      if (page.kind !== 'custom') {
        if (resource) {
          const operation = pageOperation[page.kind]
          checkOperation(resource, operation, ['kind'], 'crud')
          const fields = operation === 'create' || operation === 'update'
            ? bodyFields(resource, operation) : resource.entity?.fields
          for (const name of ['fields', 'hideFields', 'filters'] as const) {
            for (const [index, field] of (page.options[name] ?? []).entries()) {
              if (!fields?.some((candidate) => candidate.name === field)) {
                report('unknown_field', ['options', name, index], `Unknown ${resource.name} field "${field}"`)
              }
            }
          }
        }
      } else {
        for (const [id, node] of Object.entries(page.nodes)) {
          const composite = manifests[node.type]?.composite
          if (composite === 'DataTable') diagnostics.push(...checkDataTable(page, id, manifest).diagnostics)
          if (composite === 'Form') diagnostics.push(...checkForm(page, id, manifest).diagnostics)
        }
        for (const [name, query] of Object.entries(page.queries)) {
          const source = resourceOf(query.resource, ['queries', name, 'resource'])
          if (source) checkOperation(source, query.kind === 'custom' ? query.operation : query.kind === 'one' ? 'get' : 'list',
            ['queries', name, query.kind === 'custom' ? 'operation' : 'kind'], query.kind === 'custom' ? 'custom' : 'crud')
        }
      }
      for (const { step, at } of actions(page)) {
        if (step.do !== 'mutate') continue
        const source = resourceOf(step.resource, [...at, 'resource'])
        if (source) checkOperation(source, step.operation, [...at, 'operation'], 'mutation')
      }
    }
    return diagnostics
  }
}

function actions(page: PageDoc) {
  if (page.kind === 'custom') {
    return Object.entries(page.actions).flatMap(([event, steps]) =>
      steps.map((step, index) => ({ step, at: ['actions', event, index] })))
  }
  return (['rowActions', 'headerActions'] as const).flatMap((key) =>
    (page.options[key] ?? []).flatMap(({ steps }, action) =>
      steps.map((step, index) => ({ step, at: ['options', key, action, 'steps', index] }))))
}

export function validationContext(
  { manifests, diagnostics }: ManifestResolution,
  contract: TriviaManifest | null,
  engine: EngineBinding,
  deferred?: DeferredComponents,
): ValidationContext {
  const checkManifests = manifestCheck(manifests, deferred)
  return {
    manifests: (blueprint) => [...diagnostics, ...checkManifests(blueprint)],
    contract: contractCheck(contract, manifests),
    expressions: expressionCheck(engine.analyzeExpressions, (page) => exposedScope(page, manifests)),
    next: nextBoundaryCheck({ engine, manifests, contract }),
  }
}
