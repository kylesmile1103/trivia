// The batch reducer (LLD-01 section 4, FR-BP-07). A batch is applied to a working copy and
// either every op applies or nothing is written. Pure: it computes the files to write and
// leaves writing them to the caller (the dev service, LLD-04). Never throws.
import { compareBytes, serialize } from '../serialize.js'
import { loadDocument, type Blueprint, type DocEntry } from '../store.js'
import { applyError, type ApplyError, type Diagnostic } from '../types/diagnostics.js'
import { blueprintOpSchema, type BlueprintOp, type OpName, type OpOf } from '../types/ops.js'
import { validateStructure } from '../validate/index.js'
import { setApp, setNav } from './app.js'
import { Draft, Refusal, type ApplyOptions } from './draft.js'
import { removeQuery, removeState, setActions, setQuery, setState } from './logic.js'
import { addNode, moveNode, removeNode, renameNode } from './nodes.js'
import { createPage, deletePage, setPageMeta } from './page.js'
import { setBinding, setControl, setProp, setStyle } from './values.js'

export type { ApplyOptions, ExpressionTools } from './draft.js'

export interface FileWrite {
  /** The path under the blueprint directory. */
  file: string
  /** The bytes the caller must still find there (null: the file must not exist). */
  before: string | null
  /** The bytes to write (null: delete the file). */
  after: string | null
}

export interface ApplyResult {
  changed: boolean
  /** Each written document's new rev; null for a deleted one. */
  revs: Record<string, string | null>
  /** `<Page>` and `<Page>/<node>` to the ids generated for them. */
  created: Record<string, string>
  diagnostics: Diagnostic[]
}

export type ApplyOutcome =
  | { ok: true; result: ApplyResult; blueprint: Blueprint; writes: FileWrite[] }
  | { ok: false; error: ApplyError }

type Handler<N extends OpName> = (draft: Draft, op: OpOf<N>) => void
const HANDLERS: { [N in OpName]: Handler<N> } = {
  setApp, setNav, createPage, deletePage, setPageMeta, addNode, removeNode, moveNode, renameNode,
  setProp, setBinding, setStyle, setControl, setState, removeState, setQuery, removeQuery, setActions,
}

function run(draft: Draft, op: BlueprintOp): void {
  ;(HANDLERS[op.op] as Handler<OpName>)(draft, op)
}

export function apply(blueprint: Blueprint, ops: readonly unknown[], options: ApplyOptions): ApplyOutcome {
  const parsed: BlueprintOp[] = []
  for (const [index, raw] of ops.entries()) {
    const result = blueprintOpSchema.safeParse(raw)
    if (!result.success) {
      const issues = result.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message }))
      return { ok: false, error: applyError('invalid_op', `Op ${index} is not a valid BlueprintOp`, { op: index, details: { issues } }) }
    }
    parsed.push(result.data)
  }

  // Every op names the rev its author read: the document's rev before the batch, or null for
  // a document that must not exist yet. All are checked before anything runs.
  const current = (doc: string) => blueprint.docs[doc]?.rev ?? null
  for (const [index, op] of parsed.entries()) {
    if (op.baseRev !== current(op.doc)) {
      const revs = Object.fromEntries(parsed.map((o) => [o.doc, current(o.doc)]))
      return {
        ok: false,
        error: applyError('conflict', `${op.doc} changed since it was read (or its existence did)`, {
          op: index, details: { doc: op.doc, expected: op.baseRev, actual: current(op.doc), revs },
        }),
      }
    }
  }

  const draft = new Draft(blueprint, options)
  for (const [index, op] of parsed.entries()) {
    try {
      run(draft, op)
    } catch (error) {
      if (error instanceof Refusal) return { ok: false, error: { ...error.error, op: index } }
      return { ok: false, error: applyError('invalid_op', `Op ${index} failed: ${(error as Error).message}`, { op: index }) }
    }
  }

  const writes: FileWrite[] = []
  const docs: Record<string, DocEntry> = { ...blueprint.docs }
  const revs: Record<string, string | null> = {}
  for (const [file, doc] of draft.changes()) {
    const before = blueprint.docs[file]?.text ?? null
    const after = doc === null ? null : serialize(doc)
    if (before === after) continue
    writes.push({ file, before, after })
    if (after === null) {
      delete docs[file]
      revs[file] = null
    } else {
      docs[file] = loadDocument(file, after)
      revs[file] = docs[file].rev
    }
  }
  const sorted = Object.fromEntries(Object.keys(docs).sort(compareBytes).map((file) => [file, docs[file] as DocEntry]))
  const next: Blueprint = { exists: blueprint.exists || writes.length > 0, docs: sorted }

  // The result must pass the schema and the references. Only errors the batch introduced
  // block it, so a broken file elsewhere does not freeze the rest of the blueprint.
  const key = (d: Diagnostic) => `${d.code}\u0000${d.doc}\u0000${d.pointer}`
  const known = new Set(validateStructure(blueprint).filter((d) => d.severity === 'error').map(key))
  const structure = validateStructure(next)
  const introduced = structure.filter((d) => d.severity === 'error' && !known.has(key(d)))
  if (introduced.length > 0) {
    return {
      ok: false,
      error: applyError('invalid_result', `The batch would leave ${introduced.length} error(s): ${introduced[0]?.message}`, {
        details: { diagnostics: introduced },
      }),
    }
  }
  return {
    ok: true,
    writes,
    blueprint: next,
    result: { changed: writes.length > 0, revs, created: draft.created, diagnostics: structure },
  }
}
