import type { ActionStep, BlueprintNode, ContractOptions, ContractPage, CustomPage, PageDoc, Query } from './types/page.js'

const contractElements = { list: 'ListPage', create: 'CreatePage', edit: 'EditPage', show: 'ShowPage' } as const

function bytewise(left: string, right: string): number {
  // The schema restricts sortable keys to ASCII.
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function sortedEntries<T>(record: Record<string, T>): [string, T][] {
  return Object.entries(record).sort(([left], [right]) => bytewise(left, right))
}

function stringAttribute(name: string, value: string): string {
  return /["\\\r\n]/.test(value) ? `${name}={${JSON.stringify(value)}}` : `${name}="${value}"`
}

function printStep(step: ActionStep): string {
  switch (step.do) {
    case 'setState': return `setState ${step.name} = ${step.value}`
    case 'navigate': return `navigate ${step.to}`
    case 'mutate': {
      const args = []
      if (step.id !== undefined) args.push(`id: ${step.id}`)
      if (step.input !== undefined) args.push(`input: ${step.input}`)
      return `mutate ${step.resource}.${step.operation}(${args.join(', ')})`
    }
    case 'refetch': return `refetch ${step.query}`
    case 'toast': return `toast ${step.message}${step.variant === undefined ? '' : ` (${step.variant})`}`
    case 'call': return `call ${step.handler}()`
  }
}

function printQuery(name: string, query: Query): string {
  let line = `  ${name} = ${query.kind} ${query.resource}`
  if (query.kind === 'custom') line += `.${query.operation}`
  const params = sortedEntries(query.params).map(([key, expression]) => `${key}: ${expression}`)
  if (params.length > 0) line += ` { ${params.join(', ')} }`
  if (query.enabled !== undefined) line += ` if ${query.enabled}`
  return line
}

function appendSection(comment: string[], heading: string, entries: string[]): void {
  if (entries.length === 0) return
  comment.push(`${heading}:`)
  for (const entry of entries) {
    // Keep each entry on its own line and inside the comment.
    comment.push(entry.replaceAll('\r', '\\r').replaceAll('\n', '\\n').replaceAll('*/', '*\\/'))
  }
}

function printPageActions(actions: ContractOptions['rowActions']): string[] {
  const lines: string[] = []
  for (const action of actions ?? []) {
    const confirm = action.confirm === undefined ? '' : ` (confirm: ${JSON.stringify(action.confirm)})`
    lines.push(`  ${action.name} ${JSON.stringify(action.label)}${confirm}`)
    for (const step of action.steps) lines.push(`    ${printStep(step)}`)
  }
  return lines
}

function appendContract(page: ContractPage, lines: string[], comment: string[]): void {
  const attributes = [stringAttribute('resource', page.resource)]
  for (const option of ['fields', 'hideFields', 'filters'] as const) {
    const fields = page.options[option]
    if (fields !== undefined) attributes.push(`${option}={[${fields.map((field) => JSON.stringify(field)).join(', ')}]}`)
  }
  if (page.options.title !== undefined) attributes.push(stringAttribute('title', page.options.title))
  if (page.public) attributes.push('public')
  lines.push(`<${contractElements[page.kind]} ${attributes.join(' ')} />`)
  appendSection(comment, 'rowActions', printPageActions(page.options.rowActions))
  appendSection(comment, 'headerActions', printPageActions(page.options.headerActions))
}

type NodeEntry = [string, BlueprintNode]
type TreeItem = { entry: NodeEntry; indent: string } | string

function compareSlots(left: string, right: string): number {
  if (left === right) return 0
  if (left === 'children') return -1
  if (right === 'children') return 1
  return bytewise(left, right)
}

function appendTree(page: CustomPage, lines: string[], eventsByNode: Map<string, string[]>): Set<string> {
  const visited = new Set<string>()
  const root = page.nodes[page.root]
  if (root === undefined) return visited

  const childrenByParent = new Map<string, NodeEntry[]>()
  for (const entry of Object.entries(page.nodes)) {
    const parent = entry[1].parent
    if (parent === null) continue
    const siblings = childrenByParent.get(parent)
    if (siblings === undefined) childrenByParent.set(parent, [entry])
    else siblings.push(entry)
  }
  const pending: TreeItem[] = [{ entry: [page.root, root], indent: '' }]

  function appendNode(id: string, node: BlueprintNode, indentation: string): void {
    visited.add(id)
    const control = page.control[id]
    const attributes = [stringAttribute('name', node.name)]
    let closeControl: string | undefined
    let indent = indentation
    if (control && 'each' in control) {
      const filter = control.when === undefined ? '' : `.filter((${control.as}) => ${control.when})`
      lines.push(`${indentation}{${control.each}${filter}.map((${control.as}) => (`)
      closeControl = '))}'
      attributes.push(`key={${control.key}}`)
    } else if (control) {
      lines.push(`${indentation}{${control.when} && (`)
      closeControl = ')}'
    }
    if (closeControl !== undefined) indent += '  '

    const style = page.styles[id]
    if (style !== undefined) attributes.push(stringAttribute('className', style.className))

    const props = new Map<string, string>()
    let text = ''
    for (const [name, value] of Object.entries(page.props[id] ?? {})) {
      if (name === 'children' && typeof value === 'string') text = value
      else props.set(name, typeof value === 'string' ? stringAttribute(name, value) : `${name}={${JSON.stringify(value)}}`)
    }
    for (const [name, expression] of Object.entries(page.bindings[id] ?? {})) {
      if (name === 'children') {
        props.delete(name)
        text = `{${expression}}`
      } else {
        props.set(name, `${name}={${expression}}`)
      }
    }
    for (const [, attribute] of [...props].sort(([left], [right]) => bytewise(left, right))) {
      attributes.push(attribute)
    }
    for (const event of eventsByNode.get(id) ?? []) attributes.push(event)

    const slots = new Map<string, NodeEntry[]>()
    for (const child of childrenByParent.get(id) ?? []) {
      if (visited.has(child[0])) continue
      const slot = child[1].slot ?? 'children'
      const siblings = slots.get(slot)
      if (siblings === undefined) slots.set(slot, [child])
      else siblings.push(child)
    }

    const opening = `${indent}<${node.type} ${attributes.join(' ')}`
    if (closeControl !== undefined) pending.push(`${indentation}${closeControl}`)
    if (slots.size === 0) {
      lines.push(text === '' ? `${opening} />` : `${opening}>${text}</${node.type}>`)
      return
    }

    lines.push(`${opening}>`)
    const childIndent = `${indent}  `
    if (text !== '') lines.push(`${childIndent}${text}`)
    // Queue the last lines first so deep trees do not use the call stack.
    pending.push(`${indent}</${node.type}>`)
    for (const [slot, children] of [...slots].sort(([left], [right]) => compareSlots(right, left))) {
      const wrapped = slot !== 'children'
      const slotIndent = wrapped ? `${childIndent}  ` : childIndent
      if (wrapped) pending.push(`${childIndent}</slot:${slot}>`)
      children.sort(([leftId, left], [rightId, right]) => bytewise(right.order, left.order) || bytewise(rightId, leftId))
      for (const entry of children) pending.push({ entry, indent: slotIndent })
      if (wrapped) pending.push(`${childIndent}<slot:${slot}>`)
    }
  }

  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    if (typeof item === 'string') lines.push(item)
    else appendNode(...item.entry, item.indent)
  }
  return visited
}

function appendCustom(page: CustomPage, lines: string[], comment: string[]): void {
  const eventsByNode = new Map<string, string[]>()
  const actionLines: string[] = []
  for (const [key, steps] of sortedEntries(page.actions)) {
    const dot = key.indexOf('.')
    const id = key.slice(0, dot)
    const event = key.slice(dot + 1)
    const attribute = `${event}={/* ${steps.length} ${steps.length === 1 ? 'step' : 'steps'} */}`
    const events = eventsByNode.get(id)
    if (events === undefined) eventsByNode.set(id, [attribute])
    else events.push(attribute)
    actionLines.push(`  ${page.nodes[id]?.name ?? id}.${event}:`)
    for (const step of steps) actionLines.push(`    ${printStep(step)}`)
  }
  const visited = appendTree(page, lines, eventsByNode)

  appendSection(comment, 'state', sortedEntries(page.state).map(([name, state]) =>
    `  ${name}: ${state.type} = ${JSON.stringify(state.initial)}`))
  appendSection(comment, 'queries', sortedEntries(page.queries).map(([name, query]) => printQuery(name, query)))
  appendSection(comment, 'actions', actionLines)
  appendSection(comment, 'unattached', sortedEntries(page.nodes)
    .filter(([id]) => !visited.has(id))
    .map(([, node]) => `  ${node.name} (${node.type})`))
}

/** Projects a page as read-only pseudo-TSX. */
export function project(page: PageDoc): string {
  const resource = page.resource === undefined ? '' : ` · ${page.resource}`
  const lines = [`// ${page.name} (${page.kind}) ${page.route}${resource}`]
  const comment: string[] = []
  if (page.kind === 'custom') appendCustom(page, lines, comment)
  else appendContract(page, lines, comment)

  if (comment.length === 0) return `${lines.join('\n')}\n`
  return `${lines.join('\n')}\n\n/*\n${comment.join('\n')}\n*/\n`
}
