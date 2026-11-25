import { expect, it } from 'vitest'

import { loadBlueprint } from '../store.js'
import { SCHEMA_URL } from '../types/common.js'
import { checkManifests, exposedScope } from './check.js'
import { resolveManifests, type ResolvedManifest, type ResolvedManifests } from './resolve.js'

const doc = 'pages/Example.page.json'
const root = 'n_01JDK3M8A00000000000000001'
const child = 'n_01JDK3M8A00000000000000002'
const childNode = { type: 'Button', name: 'save', parent: root, slot: 'body', order: 'a0' }
const button: ResolvedManifest = {
  type: 'Button',
  source: { registry: 'shadcn', item: 'button', import: { name: 'Button', from: '~ui/button' } },
  installed: true,
  props: [
    { name: 'variant', kind: 'enum', options: ['brand'], optional: true, source: 'variant' },
    { name: 'disabled', kind: 'boolean', optional: true, source: 'intrinsic' },
  ],
  slots: [{ name: 'children', kind: 'text' }],
  events: [],
  exposes: [],
  client: false,
  template: {},
}
const card: ResolvedManifest = {
  ...button,
  type: 'Card',
  source: { registry: 'shadcn', item: 'card', import: { name: 'Card', from: '~ui/card' } },
  props: [],
  slots: [
    { name: 'body', kind: 'nodes', accepts: ['Button'] },
    { name: 'caption', kind: 'text' },
  ],
}
const manifests: ResolvedManifests = { Button: button, Card: card }

const page = (fields: Record<string, unknown> = {}, node = childNode) => loadBlueprint({
  [doc]: JSON.stringify({
    $schema: SCHEMA_URL.page, blueprintVersion: 1, id: 'pg_01JDK3M7Q2X8Y4Z6A1B3C5D7E9',
    kind: 'custom', name: 'Example', route: '/example', root,
    nodes: { [root]: { type: 'Card', name: 'page', parent: null, slot: null, order: 'a0' }, [child]: node },
    ...fields,
  }),
})

it('FR-MF-02: accepts analyzed props, text children, bindings and allowed slot content', () => {
  expect(checkManifests(page({
    props: { [child]: { variant: 'brand', children: 'Save' } },
    bindings: { [child]: { disabled: 'state.isBusy' } },
  }), manifests)).toEqual([])
})

it.each([
  ['unknown type', page({}, { ...childNode, type: 'Other' }), 'unknown_component', `/nodes/${child}/type`, 'Other'],
  ['static prop', page({ props: { [child]: { ghost: true } } }), 'unknown_prop', `/props/${child}/ghost`, 'ghost'],
  ['bound prop', page({ bindings: { [child]: { ghost: 'true' } } }), 'unknown_prop', `/bindings/${child}/ghost`, 'ghost'],
  ['enum option', page({ props: { [child]: { variant: 'outline' } } }), 'invalid_prop_value', `/props/${child}/variant`, 'brand'],
  ['kind', page({ props: { [child]: { disabled: 'yes' } } }), 'invalid_prop_value', `/props/${child}/disabled`, 'boolean'],
  ['text content', page({ props: { [child]: { children: 4 } } }), 'invalid_prop_value', `/props/${child}/children`, 'string'],
  ['unknown slot', page({}, { ...childNode, slot: 'footer' }), 'unknown_slot', `/nodes/${child}/slot`, 'body, caption'],
  ['text slot', page({}, { ...childNode, slot: 'caption' }), 'invalid_slot_content', `/nodes/${child}/slot`, 'text'],
  ['restricted slot', page({}, { ...childNode, type: 'Card' }), 'invalid_slot_content', `/nodes/${child}/slot`, 'Button'],
] as const)('checks the %s fixture', (_name, blueprint, code, pointer, message) => {
  expect(checkManifests(blueprint, manifests)).toMatchObject([
    { code, severity: 'error', doc, pointer, message: expect.stringContaining(message) },
  ])
})

it('FR-KT-07: gives deferred types a hint to use a local component', () => {
  expect(checkManifests(page({}, { ...childNode, type: 'TimePicker' }), manifests)).toMatchObject([
    { code: 'unknown_component', hint: { text: expect.stringContaining('local component') } },
  ])
})

it('FR-MF-03: a known missing component reports the registry item and install command', () => {
  const select: ResolvedManifest = {
    ...button, type: 'Select', installed: false,
    source: { registry: 'shadcn', item: 'select', import: { name: 'Select', from: '~ui/select' } },
  }
  const blueprint = page({ props: { [child]: { typo: true } } }, { ...childNode, type: 'Select' })
  expect(checkManifests(blueprint, { ...manifests, Select: select })).toMatchObject([{
    code: 'missing_component', doc, severity: 'error', pointer: `/nodes/${child}/type`,
    message: expect.stringContaining('select'),
    hint: { text: 'pnpm dlx shadcn@latest add select' },
  }])
})

it('FR-MF-03: names Refine’s registry item through its public registry URL', () => {
  const dataTable: ResolvedManifest = {
    ...button, type: 'DataTable', installed: false,
    source: { registry: 'refine', item: 'data-table', import: { name: 'DataTable', from: '~refine/data-table' } },
  }
  expect(checkManifests(page({}, { ...childNode, type: 'DataTable' }), {
    ...manifests, DataTable: dataTable,
  })).toMatchObject([{ hint: { text: 'pnpm dlx shadcn@latest add https://ui.refine.dev/r/data-table.json' } }])
})

const input: ResolvedManifest = {
  ...button,
  type: 'Input',
  source: { registry: 'shadcn', item: 'input', import: { name: 'Input', from: '~ui/input' } },
  props: [],
  slots: [],
  events: [{ name: 'onChange', prop: 'onChange' }],
  exposes: [{
    name: 'value', type: 'string', initial: '',
    via: { valueProp: 'value', changeProp: 'onChange', changeArg: 'event.target.value' },
  }],
  client: true,
}
const formManifests = {
  ...manifests,
  Button: { ...button, events: [{ name: 'onClick', prop: 'onClick' }] },
  Card: { ...card, slots: [{ name: 'body', kind: 'nodes' as const }] },
  Input: input,
}
const inputNode = { ...childNode, type: 'Input', name: 'search' }
const toast = [{ do: 'toast', message: "'Changed'" }]

it('checks a component’s action names and lists the available events', () => {
  expect(checkManifests(page({ actions: { [`${child}.onClick`]: toast } }), formManifests)).toEqual([])
  expect(checkManifests(page({ actions: { [`${child}.onBlur`]: toast } }), formManifests)).toMatchObject([{
    code: 'unknown_event', doc, severity: 'error', pointer: `/actions/${child}.onBlur`,
    message: expect.stringContaining('onClick'),
  }])
})

it('accepts an exposed value and an action on its change event', () => {
  expect(checkManifests(page({
    props: { [child]: { value: 'Start' } },
    actions: { [`${child}.onChange`]: toast },
  }, inputNode), formManifests)).toEqual([])
  expect(checkManifests(page({ bindings: { [child]: { value: 'state.search' } } }, inputNode), formManifests)).toEqual([])
  expect(checkManifests(page({ props: { [child]: { value: false } } }, inputNode), formManifests)).toMatchObject([
    { code: 'invalid_prop_value', pointer: `/props/${child}/value` },
  ])
})

it('uses the public event name when it refuses a direct change-prop binding', () => {
  const otherBase: ResolvedManifest = {
    ...input,
    events: [{ name: 'onChange', prop: 'onValueChange' }],
    exposes: input.exposes.map((value) => ({
      ...value, via: { ...value.via, changeProp: 'onValueChange', changeArg: 'value' },
    })),
  }
  const blueprint = page({ bindings: { [child]: { onValueChange: 'state.callback' } } }, inputNode)
  expect(checkManifests(blueprint, { ...formManifests, Input: otherBase })).toMatchObject([{
    code: 'controlled_change_binding', doc, severity: 'error', pointer: `/bindings/${child}/onValueChange`,
    hint: { text: expect.stringContaining(`actions["${child}.onChange"]`) },
  }])
})

it('builds a client ui root with declared member names and their TypeScript types', () => {
  const blueprint = page({ bindings: { [root]: { children: 'ui.search.value' } } }, inputNode)
  const entry = blueprint.docs[doc]
  if (entry?.kind !== 'page' || !entry.doc) throw new Error('Invalid test page')
  expect(exposedScope(entry.doc, formManifests)).toEqual({
    tier: 'client', members: { search: ['value'] }, types: { search: { value: 'string' } },
  })
  expect(exposedScope(entry.doc, { ...formManifests, Input: { ...input, installed: false } })).toEqual({
    tier: 'client', members: {}, types: {},
  })
})

it('FR-MF-06: validates HTML nodes through the same prop, slot and event checks', () => {
  const { manifests } = resolveManifests({ kit: [], components: [] })
  const div = { type: 'div', name: 'page', parent: null, slot: null, order: 'a0' }
  const link = { ...childNode, type: 'a', slot: 'children' }
  expect(checkManifests(page({
    nodes: { [root]: div, [child]: link },
    props: { [root]: { className: 'grid' }, [child]: { href: '/customers', children: 'Customers' } },
    actions: { [`${child}.onClick`]: toast },
  }), manifests)).toEqual([])
  expect(checkManifests(page({
    nodes: { [root]: { ...div, type: 'img' }, [child]: link },
    props: { [root]: { href: '/customers' } },
  }), manifests)).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'unknown_prop', pointer: `/props/${root}/href` }),
    expect.objectContaining({ code: 'unknown_slot', pointer: `/nodes/${child}/slot` }),
  ]))
  expect(checkManifests(page({ nodes: { [root]: { ...div, type: 'constructor' } } }), manifests)).toMatchObject([
    { code: 'unknown_component', pointer: `/nodes/${root}/type` },
  ])
})
