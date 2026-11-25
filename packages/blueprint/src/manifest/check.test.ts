import { expect, it } from 'vitest'

import { loadBlueprint } from '../store.js'
import { SCHEMA_URL } from '../types/common.js'
import { checkManifests } from './check.js'
import type { ResolvedManifest, ResolvedManifests } from './resolve.js'

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
