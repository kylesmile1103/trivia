import { describe, expect, it } from 'vitest'

import type { AttrDetails, ComponentSchema, NodeDetails } from '@/shared/engine/types'

import { buildModel, isIntrinsic, locatorScope, propLabel, validatePropName } from './model'

const button: ComponentSchema = {
  name: 'Button',
  file: 'src/components/ui/button.tsx',
  importSource: '@/components/ui/button',
  baseElement: 'button',
  acceptsChildren: true,
  props: [
    { name: 'variant', kind: 'enum', options: ['default', 'outline'], optional: true, default: 'default', source: 'variant' },
    { name: 'asChild', kind: 'boolean', optional: true, default: false, source: 'declared' },
    { name: 'onPick', kind: 'unknown', typeText: '(v: string) => void', optional: true, source: 'declared' },
    { name: 'className', kind: 'className', optional: true, source: 'intrinsic' },
  ],
}

function node(name: string, attributes: AttrDetails[]): NodeDetails {
  return {
    locator: `src/pages/Dashboard.tsx#Dashboard#0.1`,
    file: 'src/pages/Dashboard.tsx',
    name,
    isFragment: false,
    line: 3,
    column: 5,
    isRoot: false,
    isDirect: true,
    parent: 'src/pages/Dashboard.tsx#Dashboard#0',
    children: [],
    attributes,
    text: null,
  }
}

const str = (name: string, value: string): AttrDetails => ({ name, kind: 'string', value, source: `"${value}"` })
const expr = (name: string, source: string): AttrDetails => ({ name, kind: 'expression', value: null, source })

describe('buildModel', () => {
  it('lists schema props in order, absent ones with their default', () => {
    const m = buildModel(node('Button', []), button)
    expect(m.props.map((p) => p.name)).toEqual(['variant', 'asChild', 'onPick'])
    expect(m.props[0]).toMatchObject({ control: { kind: 'enum', options: ['default', 'outline'] }, value: { state: 'absent' }, defaultValue: 'default' })
    expect(m.props[2]).toMatchObject({ control: null, value: { state: 'absent' } })
    expect(m.className).toEqual({ state: 'absent' })
  })

  it('makes literals editable and expressions read-only', () => {
    const m = buildModel(node('Button', [str('variant', 'outline'), expr('asChild', 'flag')]), button)
    expect(m.props[0]?.value).toEqual({ state: 'literal', value: 'outline' })
    expect(m.props[1]).toMatchObject({ control: null, value: { state: 'readonly', source: 'flag', reason: 'expression' } })
  })

  it('treats a shorthand attribute as the literal true', () => {
    const m = buildModel(node('Button', [{ name: 'asChild', kind: 'shorthand', value: true, source: 'asChild' }]), button)
    expect(m.props[1]).toMatchObject({ control: { kind: 'boolean' }, value: { state: 'literal', value: true } })
  })

  it('refuses to retype a literal that does not match the declared kind', () => {
    const m = buildModel(node('Button', [str('asChild', 'yes')]), button)
    expect(m.props[1]).toMatchObject({ control: null, value: { state: 'readonly', reason: 'mismatch' } })
  })

  it('shows unknown source attributes as generic props, typed by their literal', () => {
    const m = buildModel(
      node('Button', [str('id', 'save'), { name: 'tabIndex', kind: 'expression', value: 3, source: '3' }, expr('key', 'plan')]),
      button,
    )
    expect(m.extra.map((p) => [p.name, p.control?.kind ?? null])).toEqual([
      ['id', 'string'],
      ['tabIndex', 'number'],
      ['key', null],
    ])
  })

  it('uses the last duplicate, like JSX does', () => {
    const m = buildModel(node('div', [str('id', 'a'), str('id', 'b')]), null)
    expect(m.extra).toHaveLength(1)
    expect(m.extra[0]?.value).toEqual({ state: 'literal', value: 'b' })
  })

  it('keeps spreads and an expression className read-only', () => {
    const m = buildModel(
      node('div', [{ name: null, kind: 'spread', value: null, source: '{...props}' }, expr('className', 'cn("a", b)')]),
      null,
    )
    expect(m.spreads).toEqual(['{...props}'])
    expect(m.className).toEqual({ state: 'readonly', source: 'cn("a", b)' })
  })

  it('edits a literal className, string attribute or {"…"} expression alike', () => {
    expect(buildModel(node('div', [str('className', 'p-4 flex')]), null).className).toEqual({ state: 'literal', value: 'p-4 flex' })
    const braced: AttrDetails = { name: 'className', kind: 'expression', value: 'p-4', source: '"p-4"' }
    expect(buildModel(node('div', [braced]), null).className).toEqual({ state: 'literal', value: 'p-4' })
  })

  it('hides the class manager for a component whose schema has no className', () => {
    const noClass: ComponentSchema = { ...button, props: button.props.filter((p) => p.kind !== 'className') }
    expect(buildModel(node('Button', []), noClass).className).toBeNull()
    expect(buildModel(node('Button', [str('className', 'x')]), noClass).className).toEqual({ state: 'literal', value: 'x' })
  })
})

describe('helpers', () => {
  it('classifies intrinsic elements', () => {
    expect(isIntrinsic('div')).toBe(true)
    expect(isIntrinsic('Button')).toBe(false)
    expect(isIntrinsic('motion.div')).toBe(false)
  })

  it('reads the component scope from a locator', () => {
    expect(locatorScope('src/pages/Dashboard.tsx#Dashboard#0.0.2')).toBe('Dashboard')
    expect(locatorScope('weird#name.tsx#App#0')).toBe('App')
  })

  it('validates new prop names', () => {
    const written = new Set(['id'])
    expect(validatePropName('aria-label', written)).toBeNull()
    expect(validatePropName('xlink:href', written)).toBeNull()
    expect(validatePropName('id', written)).toMatch(/already set/)
    expect(validatePropName('1x', written)).toMatch(/not a valid/)
    expect(validatePropName('data-ast-node', written)).toMatch(/managed/)
  })

  it('labels history entries', () => {
    expect(propLabel('Button', 'variant', 'outline')).toBe('Set Button.variant')
    expect(propLabel('Button', 'variant', null)).toBe('Remove Button.variant')
  })
})
