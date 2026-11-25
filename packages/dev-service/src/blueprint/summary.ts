import { createHash } from 'node:crypto'

import { APP_DOC, validate, type AppDoc, type ApplyResult, type Blueprint, type Diagnostic, type PageKind } from '@trivia/blueprint'
import { z } from 'zod'

import { ApiError } from '../engine.js'
import { type BlueprintWorkspace, readBytes } from './store.js'

export interface BlueprintPageSummary {
  name: string
  path: string
  rev: string
  route: string
  kind: PageKind
  status: 'draft' | 'ejected' | 'edited'
  file?: string
  errors: number
  warnings: number
}

export interface BlueprintSummary {
  dir: string
  exists: boolean
  app: { rev: string; name: string; targets: AppDoc['targets'] } | null
  model: { rev: string; entities: string[] } | null
  pages: BlueprintPageSummary[]
  diagnostics: Diagnostic[]
  next: string
}

export interface PatchResult extends ApplyResult {
  entry: string | null
  summary: BlueprintSummary
}

const LOCK = 'blueprint.lock.json'
const lockSchema = z.object({
  lockVersion: z.literal(1),
  pages: z.record(z.string(), z.object({ file: z.string(), hash: z.string().regex(/^sha256:[a-f0-9]{64}$/) })),
})

function readLock(workspace: BlueprintWorkspace, diagnostics: Diagnostic[]): z.infer<typeof lockSchema>['pages'] {
  const text = workspace.readDocumentText(LOCK)
  if (text === null) return {}
  try {
    return lockSchema.parse(JSON.parse(text)).pages
  } catch {
    diagnostics.push({ code: 'invalid_lock', severity: 'warning', doc: LOCK, pointer: '', message: 'Invalid blueprint lock, expected lockVersion 1 and page file hashes' })
    return {}
  }
}

function fileHash(root: string, file: string): string | null {
  try {
    const bytes = readBytes(root, file)
    return bytes === null ? null : 'sha256:' + createHash('sha256').update(bytes).digest('hex')
  } catch (error) {
    // An unsafe or unreadable lock target cannot qualify as an unchanged ejected page.
    if (error instanceof ApiError) return null
    throw error
  }
}

export async function readSummary(workspace: BlueprintWorkspace): Promise<BlueprintSummary> {
  const blueprint = await workspace.read()
  return summarize(workspace, blueprint, validate(blueprint, workspace.context()))
}

export function summarize(workspace: BlueprintWorkspace, blueprint: Blueprint, findings: readonly Diagnostic[]): BlueprintSummary {
  const diagnostics = [...findings]
  const locks = readLock(workspace, diagnostics)
  const counts = new Map<string, { errors: number; warnings: number }>()
  for (const finding of diagnostics) {
    const count = counts.get(finding.doc) ?? { errors: 0, warnings: 0 }
    if (finding.severity === 'error') count.errors++
    else count.warnings++
    counts.set(finding.doc, count)
  }

  const pages: BlueprintPageSummary[] = []
  for (const entry of Object.values(blueprint.docs)) {
    if (entry.kind !== 'page' || !entry.doc) continue
    const { name, route, kind } = entry.doc
    const lock = Object.hasOwn(locks, name) ? locks[name] : undefined
    const status = lock ? (fileHash(workspace.root, lock.file) === lock.hash ? 'ejected' : 'edited') : 'draft'
    pages.push({
      name, path: entry.path, rev: entry.rev, route, kind, status, ...(lock && { file: lock.file }),
      ...(counts.get(entry.path) ?? { errors: 0, warnings: 0 }),
    })
  }
  const app = blueprint.docs[APP_DOC]
  const errors = diagnostics.filter(({ severity }) => severity === 'error').length
  const next = errors > 0
    ? 'Review the diagnostics and patch the affected documents using their current revisions.'
    : pages.length === 0
      ? 'Start with createPage (baseRev: null). Use setApp to set the app name and targets.'
      : 'Read a page document before editing it, or use createPage to add another.'
  return {
    dir: workspace.dir, exists: blueprint.exists,
    app: app?.kind === 'app' && app.doc ? { rev: app.rev, name: app.doc.name, targets: app.doc.targets } : null,
    model: null,
    pages, diagnostics, next,
  }
}
