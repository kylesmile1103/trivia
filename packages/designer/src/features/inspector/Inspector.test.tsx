// @vitest-environment jsdom
//
// The inspector in a real React tree against a fake engine (inspect/apply over an in-memory
// file), driven the way the canvas drives it: `select()` on the store.

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { NodeDetails, Op } from '@/shared/engine/types'
import { designer } from '@/shared/state/store'

import { Inspector } from './Inspector'
import { find, type Mounted, mount, press, settle, typeInto } from './test-utils'

const world = vi.hoisted(() => ({
  nodes: new Map<string, NodeDetails>(),
  applies: [] as Array<{ op: Op; label: string | undefined }>,
  toasts: [] as Array<{ kind: string; message: unknown; data: unknown }>,
}))

vi.mock('@/shared/engine/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/shared/engine/client')>()
  return {
    ...real,
    engine: {
      ...real.engine,
      inspect: async (locator: string) => {
        const node = world.nodes.get(locator)
        if (node === undefined) throw new real.ApiError({ code: 'node_not_found', message: `nothing at ${locator}` }, 404)
        return structuredClone(node)
      },
      apply: async (op: Op, label?: string) => {
        world.applies.push({ op, label })
        if (op.op !== 'updateProp') throw new Error(`unexpected op ${op.op}`)
        const node = world.nodes.get(op.target)
        if (node === undefined) throw new real.ApiError({ code: 'node_not_found', message: `nothing at ${op.target}` }, 404)
        if (op.expectedName !== undefined && op.expectedName !== node.name) {
          throw new real.ApiError({ code: 'stale_locator', message: `expected <${op.expectedName}>, found <${node.name}>` }, 409)
        }
        const attributes = node.attributes.filter((a) => a.name !== op.prop)
        if (op.value !== null) attributes.push({ name: op.prop, kind: 'string', value: op.value, source: JSON.stringify(op.value) })
        world.nodes.set(op.target, { ...node, attributes })
        return {
          file: node.file,
          changed: true,
          locator: op.target,
          history: { canUndo: true, canRedo: false, undoLabel: label ?? null, redoLabel: null },
        }
      },
    },
  }
})

vi.mock('sonner', async (importOriginal) => {
  const real = await importOriginal<typeof import('sonner')>()
  const record = (kind: string) => (message: unknown, data?: unknown) => world.toasts.push({ kind, message, data })
  const toast = Object.assign(record('default'), {
    error: record('error'),
    warning: record('warning'),
    info: record('info'),
    success: record('success'),
  })
  return { ...real, toast }
})

const INPUT = 'src/App.tsx#App#0.0'
const BOX = 'src/App.tsx#App#0.1'

function node(locator: string, name: string, attributes: Record<string, string>): NodeDetails {
  return {
    locator,
    file: 'src/App.tsx',
    name,
    isFragment: false,
    line: 1,
    column: 1,
    isRoot: false,
    isDirect: true,
    parent: null,
    children: [],
    attributes: Object.entries(attributes).map(([attr, value]) => ({ name: attr, kind: 'string', value, source: JSON.stringify(value) })),
    text: null,
  }
}

let view: Mounted | null

beforeEach(async () => {
  world.nodes.clear()
  world.nodes.set(INPUT, node(INPUT, 'input', { placeholder: 'old', className: 'p-4' }))
  world.nodes.set(BOX, node(BOX, 'div', { className: 'flex' }))
  world.applies.length = 0
  world.toasts.length = 0
  designer.getState().select(null)
  designer.getState().setHistory({ canUndo: false, canRedo: false, undoLabel: null, redoLabel: null })
  view = await mount(<Inspector />)
})

afterEach(async () => {
  await view?.unmount()
  view = null
})

async function select(locator: string | null) {
  await act(async () => designer.getState().select(locator))
  await settle()
}

const host = () => view!.host
const heading = () => host().querySelector('h2')?.textContent ?? null
const readout = () => find(host(), '[data-testid="style-classname"]').textContent
/** The text setter of a prop row, found through its label as a user would. */
function propField(name: string): HTMLInputElement {
  const label = [...host().querySelectorAll('label')].find((l) => l.textContent === name)
  if (label === undefined) throw new Error(`no prop row ${name}`)
  return find<HTMLInputElement>(host(), `#${CSS.escape(label.htmlFor)}`)
}
const padding = () => find<HTMLInputElement>(host(), 'input[aria-label="Padding"]')

describe('style panel commits through the inspector', () => {
  it('carry the panel’s history label', async () => {
    await select(BOX)
    await typeInto(padding(), '24')
    await press(padding(), { key: 'Enter' })
    await settle()
    expect(world.applies).toEqual([
      { op: { op: 'updateProp', target: BOX, expectedName: 'div', prop: 'className', value: 'flex p-6' }, label: 'Padding p-6' },
    ])
    expect(designer.getState().history.undoLabel).toBe('Padding p-6')
    expect(readout()).toBe('flex p-6')
  })

  it('drop a refused value instead of showing it as applied and re-sending it with the next edit', async () => {
    await select(BOX)
    expect(readout()).toBe('flex')
    // Renamed in the IDE before the inspector refreshed: the engine refuses the stale locator.
    world.nodes.set(BOX, { ...world.nodes.get(BOX)!, name: 'section' })

    await typeInto(padding(), '24')
    await press(padding(), { key: 'Enter' })
    await settle()
    expect(world.applies.map((a) => a.op)).toEqual([
      { op: 'updateProp', target: BOX, expectedName: 'div', prop: 'className', value: 'flex p-6' },
    ])
    expect(world.toasts.map((t) => t.kind)).toEqual(['error'])
    expect(readout()).toBe('flex')

    // The next edit starts from the source, not from the refused value.
    const margin = find<HTMLInputElement>(host(), 'input[aria-label="Margin"]')
    await typeInto(margin, '8')
    await press(margin, { key: 'Enter' })
    await settle()
    expect(world.applies[1]).toEqual({
      op: { op: 'updateProp', target: BOX, expectedName: 'section', prop: 'className', value: 'flex m-2' },
      label: 'Margin m-2',
    })
    expect(readout()).toBe('flex m-2')
  })
})

describe('typed values when the selection moves on (a canvas click unmounts the inspector before blur)', () => {
  it('commit a prop draft to the element it was typed for, and keep the new selection', async () => {
    await select(INPUT)
    await typeInto(propField('placeholder'), 'Search…')
    expect(world.applies).toEqual([])

    await select(BOX)
    expect(world.applies).toEqual([
      {
        op: { op: 'updateProp', target: INPUT, expectedName: 'input', prop: 'placeholder', value: 'Search…' },
        label: 'Set input.placeholder',
      },
    ])
    expect(world.nodes.get(INPUT)!.attributes).toContainEqual(expect.objectContaining({ name: 'placeholder', value: 'Search…' }))
    expect(designer.getState().selected).toBe(BOX)
    expect(heading()).toBe('div')
    expect(designer.getState().history.undoLabel).toBe('Set input.placeholder')
  })

  it('commit on deselect (click on empty canvas)', async () => {
    await select(INPUT)
    await typeInto(propField('placeholder'), 'Search…')
    await select(null)
    expect(world.applies.map((a) => a.op)).toEqual([
      { op: 'updateProp', target: INPUT, expectedName: 'input', prop: 'placeholder', value: 'Search…' },
    ])
    expect(designer.getState().selected).toBeNull()
  })

  it('commit a typed style value with the panel’s label', async () => {
    await select(INPUT)
    await typeInto(padding(), '24')
    await select(BOX)
    expect(world.applies).toEqual([
      { op: { op: 'updateProp', target: INPUT, expectedName: 'input', prop: 'className', value: 'p-6' }, label: 'Padding p-6' },
    ])
    expect(designer.getState().selected).toBe(BOX)
  })

  it('commit nothing that Escape reverted, and nothing twice after Enter', async () => {
    await select(INPUT)
    const field = propField('placeholder')
    await typeInto(field, 'Search…')
    await press(field, { key: 'Escape' })
    await select(BOX)
    expect(world.applies).toEqual([])

    await select(INPUT)
    await typeInto(propField('placeholder'), 'Search…')
    await press(propField('placeholder'), { key: 'Enter' })
    await settle()
    await select(BOX)
    expect(world.applies).toHaveLength(1)
  })

  it('report a refused leave commit, naming the edit, without moving the selection back', async () => {
    await select(INPUT)
    await typeInto(propField('placeholder'), 'Search…')
    world.nodes.set(INPUT, { ...world.nodes.get(INPUT)!, name: 'textarea' })
    await select(BOX)
    expect(world.applies).toHaveLength(1)
    expect(world.toasts).toEqual([
      expect.objectContaining({ kind: 'error', message: expect.stringContaining('Set input.placeholder') }),
    ])
    expect(String(world.toasts[0]!.message)).toContain('expected <input>, found <textarea>')
    expect(designer.getState().selected).toBe(BOX)
  })

  it('write nothing when the source makes the field read-only under the draft, and say so', async () => {
    await select(INPUT)
    await typeInto(propField('placeholder'), 'Search…')
    // An IDE edit binds the prop to an expression; HMR refreshes the inspector.
    const before = world.nodes.get(INPUT)!
    world.nodes.set(INPUT, {
      ...before,
      attributes: before.attributes.map((a) =>
        a.name === 'placeholder' ? { name: 'placeholder', kind: 'expression', value: null, source: 't("search")' } : a,
      ),
    })
    await act(async () => designer.getState().bumpRevision())
    await settle()
    expect(host().textContent).toContain('Bound to an expression')
    expect(world.applies).toEqual([])
    expect(world.toasts).toEqual([expect.objectContaining({ kind: 'warning', message: 'placeholder “Search…” not applied' })])
    expect(designer.getState().selected).toBe(INPUT)
  })

  it('never apply classes typed without Enter, but say they were not applied', async () => {
    await select(INPUT)
    await typeInto(find<HTMLInputElement>(host(), 'input[aria-label="Add classes"]'), 'px-8')
    await select(BOX)
    expect(world.applies).toEqual([])
    expect(world.toasts).toEqual([expect.objectContaining({ kind: 'warning', message: expect.stringContaining('px-8') })])
  })

  it('never add a prop that was not submitted, but say it was not added', async () => {
    await select(INPUT)
    const add = [...host().querySelectorAll('button')].find((b) => b.textContent === 'Add prop')!
    await act(async () => add.click())
    await typeInto(find<HTMLInputElement>(host(), 'input[aria-label="Prop name"]'), 'autoComplete')
    await typeInto(find<HTMLInputElement>(host(), 'input[aria-label="Prop value"]'), 'off')
    await select(BOX)
    expect(world.applies).toEqual([])
    expect(world.toasts).toEqual([expect.objectContaining({ kind: 'warning', message: expect.stringContaining('autoComplete') })])
  })
})
