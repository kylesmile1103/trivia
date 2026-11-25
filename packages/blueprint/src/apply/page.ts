// Page ops: createPage, deletePage, setPageMeta (LLD-01 section 4).
import { newId } from '../ids.js'
import { BLUEPRINT_VERSION, SCHEMA_URL } from '../types/common.js'
import { pageDocPath, type OpOf } from '../types/ops.js'
import type { CustomPage, PageDoc } from '../types/page.js'
import { editPage, refuse, type Draft } from './draft.js'

export function createPage(draft: Draft, op: OpOf<'createPage'>): void {
  if (op.doc !== pageDocPath(op.name)) refuse('invalid_op', `A page named ${op.name} lives in ${pageDocPath(op.name)}, not ${op.doc}`)
  if (draft.has(op.doc)) refuse('conflict', `${op.doc} already exists`, { name: op.name })
  const envelope = { $schema: SCHEMA_URL.page, blueprintVersion: BLUEPRINT_VERSION as 1, name: op.name, route: op.route }
  const id = newId('pg', draft.options.ids)
  draft.created[op.name] = id
  if (op.kind !== 'custom') {
    if (op.resource === undefined) refuse('invalid_op', `A ${op.kind} page needs a resource`)
    if (op.rootType !== undefined) refuse('invalid_op', `A ${op.kind} page has no nodes, so no rootType`)
    draft.put(op.doc, { ...envelope, id, kind: op.kind, resource: op.resource, public: op.public ?? false, options: op.options ?? {} })
    return
  }
  if (op.options !== undefined) refuse('invalid_op', 'A custom page has no options: they belong to list, create, edit and show pages')
  // A custom page always has its root, so every later node has a parent to go in.
  const root = newId('n', draft.options.ids)
  draft.created[`${op.name}/page`] = root
  const page: CustomPage = {
    ...envelope, id, kind: 'custom', public: op.public ?? false, root,
    nodes: { [root]: { type: op.rootType ?? 'div', name: 'page', parent: null, slot: null, order: 'a0' } },
    props: {}, bindings: {}, styles: {}, control: {}, state: {}, queries: {}, actions: {},
  }
  if (op.resource !== undefined) page.resource = op.resource
  draft.put(op.doc, page)
}

export function deletePage(draft: Draft, op: OpOf<'deletePage'>): void {
  if (!draft.has(op.doc)) refuse('invalid_op', `${op.doc} does not exist`)
  // A document from a newer version is never written, and deleting it is a write (FR-BP-06).
  if (draft.base.docs[op.doc]?.diagnostics.some((d) => d.code === 'unsupported_version')) {
    refuse('invalid_op', `${op.doc} was written by a newer version; it is left as it is`)
  }
  draft.remove(op.doc)
}

export function setPageMeta(draft: Draft, op: OpOf<'setPageMeta'>): void {
  const page: PageDoc = editPage(draft, op.doc)
  if (page.kind === 'custom') {
    if (op.kind !== undefined) refuse('invalid_op', `${op.doc} is a custom page; its kind cannot change`)
    if (op.options !== undefined) refuse('invalid_op', 'A custom page has no options')
    if (op.resource === null) delete page.resource
    else if (op.resource !== undefined) page.resource = op.resource
  } else {
    if (op.resource === null) refuse('invalid_op', `A ${page.kind} page needs a resource`)
    if (op.resource !== undefined) page.resource = op.resource
    if (op.kind !== undefined) page.kind = op.kind
    if (op.options !== undefined) page.options = op.options
  }
  if (op.route !== undefined) page.route = op.route
  if (op.public !== undefined) page.public = op.public
  if (op.name !== undefined && op.name !== page.name) {
    // The file is named after the page, so a new name moves the document.
    const target = pageDocPath(op.name)
    if (draft.has(target)) refuse('conflict', `${target} already exists`, { name: op.name })
    page.name = op.name
    draft.remove(op.doc)
    draft.put(target, page)
  }
}
