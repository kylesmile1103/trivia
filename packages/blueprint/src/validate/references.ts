// Layer 2, references (LLD-01 section 5): parents exist, one root, no cycles; every child
// sits in a slot; a prop is static or bound, not both; action keys and steps name what exists;
// nav names pages; routes are unique. Runs only on documents that passed the schema. Pure,
// never throws, and deterministic: documents in path order, entries in key order.
import { compareBytes } from '../serialize.js'
import type { Blueprint } from '../store.js'
import { toPointer, type Diagnostic, type Severity } from '../types/diagnostics.js'
import { APP_DOC, pageDocPath, type OpOf } from '../types/ops.js'
import { NODE_MAPS, type CustomPage, type PageDoc } from '../types/page.js'

type Report = (code: string, path: ReadonlyArray<PropertyKey>, message: string, severity?: Severity, hint?: Diagnostic['hint']) => void

const byKey = <T>(record: Record<string, T>): Array<[string, T]> =>
  Object.entries(record).sort(([a], [b]) => compareBytes(a, b))

/** The nodes on a parent cycle (not those that merely hang below one). */
function cycleMembers(page: CustomPage): Set<string> {
  const members = new Set<string>()
  const settled = new Set<string>()
  for (const [start] of byKey(page.nodes)) {
    const path: string[] = []
    const onPath = new Map<string, number>()
    let current: string | null = start
    while (current !== null && page.nodes[current] && !settled.has(current)) {
      const seen = onPath.get(current)
      if (seen !== undefined) {
        for (const id of path.slice(seen)) members.add(id)
        break
      }
      onPath.set(current, path.length)
      path.push(current)
      current = page.nodes[current]?.parent ?? null
    }
    for (const id of path) settled.add(id)
  }
  return members
}

function checkCustomPage(page: CustomPage, report: Report, doc: string, rev: string): void {
  const nodes = page.nodes
  const rootOk = Object.hasOwn(nodes, page.root)
  if (!rootOk) report('dangling_reference', ['root'], `The root ${page.root} is not a node of the page`)
  else {
    const root = nodes[page.root]
    if (root?.parent !== null) report('invalid_root', ['nodes', page.root, 'parent'], 'The root has no parent')
    if (root?.slot !== null) report('invalid_root', ['nodes', page.root, 'slot'], 'The root sits in no slot')
  }

  const cycle = cycleMembers(page)
  for (const [id, node] of byKey(nodes)) {
    if (node.parent === null) {
      if (rootOk && id !== page.root) report('invalid_root', ['nodes', id, 'parent'], `${node.name} has no parent but is not the root ${page.root}`)
      continue
    }
    if (!Object.hasOwn(nodes, node.parent)) report('dangling_reference', ['nodes', id, 'parent'], `The parent ${node.parent} of ${node.name} does not exist`)
    else if (cycle.has(id)) report('parent_cycle', ['nodes', id, 'parent'], `${node.name} is its own ancestor`)
    if (node.slot === null) report('missing_slot', ['nodes', id, 'slot'], `${node.name} has a parent, so it needs a slot`)
  }

  // Siblings in one slot that share a key have no defined order between them.
  const seenOrder = new Map<string, string>()
  for (const [id, node] of byKey(nodes)) {
    if (node.parent === null) continue
    const key = `${node.parent}\u0000${node.slot}\u0000${node.order}`
    const first = seenOrder.get(key)
    if (first === undefined) seenOrder.set(key, id)
    else {
      report('duplicate_order', ['nodes', id, 'order'], `${node.name} has the same order key "${node.order}" as ${nodes[first]?.name}`, 'warning', {
        text: `Move one of them with moveNode (before, after or index) to give it a key of its own`,
      })
    }
  }

  // Nodes, state and queries share one namespace: emitted code names them all.
  const names = new Map<string, string>()
  const claim = (name: string, path: PropertyKey[], what: string) => {
    const owner = names.get(name)
    if (owner === undefined) names.set(name, what)
    else report('duplicate_name', path, `The name "${name}" is already used by ${owner}`)
  }
  for (const [id, node] of byKey(nodes)) claim(node.name, ['nodes', id, 'name'], `node ${id}`)
  for (const [name] of byKey(page.state)) claim(name, ['state', name], `state ${name}`)
  for (const [name] of byKey(page.queries)) claim(name, ['queries', name], `query ${name}`)

  for (const map of NODE_MAPS) {
    for (const id of Object.keys(page[map]).sort(compareBytes)) {
      if (!Object.hasOwn(nodes, id)) report('dangling_reference', [map, id], `${map} has an entry for ${id}, which is not a node`)
    }
  }
  for (const [id, bound] of byKey(page.bindings)) {
    for (const [prop] of byKey(bound)) {
      if (Object.hasOwn(page.props[id] ?? {}, prop)) {
        const type = nodes[id]?.type
        // Removing the static value keeps the binding, the more specific of the two.
        const hint: Diagnostic['hint'] = {
          text: `Or keep the static value instead: setBinding with prop "${prop}" and expr null`,
          ...(type === undefined ? {} : { ops: [{ op: 'setProp', doc, baseRev: rev, node: id, expectedType: type, prop, value: null }] }),
        }
        report('duplicate_prop', ['bindings', id, prop], `"${prop}" of ${nodes[id]?.name ?? id} is both static (props) and bound (bindings)`, 'error', hint)
      }
    }
  }

  for (const [key, steps] of byKey(page.actions)) {
    const id = key.slice(0, key.indexOf('.'))
    if (!Object.hasOwn(nodes, id)) report('dangling_reference', ['actions', key], `The action ${key} names ${id}, which is not a node`)
    steps.forEach((step, i) => {
      if (step.do === 'setState' && !Object.hasOwn(page.state, step.name)) {
        report('dangling_reference', ['actions', key, i, 'name'], `No state named "${step.name}"`)
      }
      if (step.do === 'refetch' && !Object.hasOwn(page.queries, step.query)) {
        report('dangling_reference', ['actions', key, i, 'query'], `No query named "${step.query}"`)
      }
    })
  }
}

export function checkReferences(blueprint: Blueprint): Diagnostic[] {
  const out: Diagnostic[] = []
  const reporter = (doc: string): Report => (code, path, message, severity = 'error', hint) =>
    out.push({ code, severity, doc, pointer: toPointer(path), message, ...(hint ? { hint } : {}) })

  const pages: Array<[string, PageDoc, string]> = []
  for (const [file, entry] of byKey(blueprint.docs)) {
    if (entry.kind === 'page' && entry.doc) pages.push([file, entry.doc, entry.rev])
  }
  const hasPageFiles = Object.values(blueprint.docs).some((entry) => entry.kind === 'page')

  const app = blueprint.docs[APP_DOC]
  if (!app && hasPageFiles) {
    reporter(APP_DOC)('missing_document', [], `The blueprint has pages but no ${APP_DOC}`, 'warning', {
      text: 'Create it with setApp (baseRev null, a name and targets.web)',
    })
  }
  if (app?.kind === 'app' && app.doc) {
    const exists = (page: string) => Object.hasOwn(blueprint.docs, pageDocPath(page))
    // One fix for every entry that points nowhere, so the hints of two such entries agree.
    const fix: OpOf<'setNav'> = { op: 'setNav', doc: APP_DOC, baseRev: app.rev, nav: app.doc.nav.filter((entry) => exists(entry.page)) }
    app.doc.nav.forEach((entry, i) => {
      if (!exists(entry.page)) {
        reporter(APP_DOC)('dangling_reference', ['nav', i, 'page'], `The nav entry "${entry.label}" names the page ${entry.page}, which does not exist`, 'error', {
          ops: [fix],
        })
      }
    })
  }

  const routes = new Map<string, string>()
  for (const [file, page, rev] of pages) {
    const report = reporter(file)
    if (file !== pageDocPath(page.name)) report('file_name_mismatch', ['name'], `${file} holds a page named ${page.name}; it belongs in ${pageDocPath(page.name)}`)
    if (page.kind === 'custom') checkCustomPage(page, report, file, rev)
    const first = routes.get(page.route)
    if (first === undefined) routes.set(page.route, file)
    else report('duplicate_route', ['route'], `The route ${page.route} is already the route of ${first}`)
  }
  return out
}
