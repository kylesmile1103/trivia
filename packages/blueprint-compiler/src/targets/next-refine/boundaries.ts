import { compareBytes } from '../../print/style.js'

export interface BoundaryNode {
  id: string
  parent: string | null
  client?: boolean
  dependencies?: readonly string[]
  values?: readonly { pointer: string; serializable: boolean }[]
}

interface Crossing {
  boundary: string
  node: string
  pointer: string
}

export interface BoundaryPlan {
  roots: string[]
  crossings: Crossing[]
  invalid: Crossing[]
}

/** Group the client nodes, locate each group's root and drop roots covered by another group. */
export function planBoundaries(nodes: readonly BoundaryNode[]): BoundaryPlan {
  const parents = new Map(nodes.map(({ id, parent }) => [id, parent]))
  const ancestorPath = (id: string) => {
    const path = []
    for (let at: string | null | undefined = id; at != null; at = parents.get(at)) path.push(at)
    return path
  }
  const client = nodes.filter(({ client }) => client)
  const groups = new Map(client.map(({ id }) => [id, id]))
  const groupOf = (id: string): string => {
    let root = id
    while (groups.get(root) !== root) root = groups.get(root)!
    while (id !== root) {
      const next = groups.get(id)!
      groups.set(id, root)
      id = next
    }
    return root
  }
  const members = new Map<string, string>()
  for (const node of client) {
    for (const dependency of node.dependencies ?? []) {
      const first = members.get(dependency)
      if (first === undefined) members.set(dependency, node.id)
      else groups.set(groupOf(node.id), groupOf(first))
    }
  }
  const ancestors = new Map<string, string>()
  for (const { id } of client) {
    const group = groupOf(id)
    const prior = ancestors.get(group)
    const path = new Set(ancestorPath(id))
    ancestors.set(group, prior === undefined ? id : ancestorPath(prior).find((ancestor) => path.has(ancestor))!)
  }
  const candidates = new Set(ancestors.values())
  const roots = [...candidates].filter((root) => ancestorPath(root).slice(1).every((ancestor) => !candidates.has(ancestor)))
    .sort(compareBytes)
  const rootSet = new Set(roots)
  const crossings: Crossing[] = []
  const invalid: Crossing[] = []
  for (const { id, values } of nodes) {
    if (!values?.length) continue
    const boundary = ancestorPath(id).find((ancestor) => rootSet.has(ancestor))
    if (boundary === undefined) continue
    for (const { pointer, serializable } of values) {
      (serializable ? crossings : invalid).push({ boundary, node: id, pointer })
    }
  }
  return { roots, crossings, invalid }
}
