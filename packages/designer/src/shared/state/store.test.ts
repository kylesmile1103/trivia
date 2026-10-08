import { beforeEach, describe, expect, it } from 'vitest'

import type { NodeDetails } from '@/shared/engine/types'

import { designer } from './store'

const LOC = 'src/pages/Dashboard.tsx#Dashboard#0.0.1.3'

function details(name: string, locator = LOC): NodeDetails {
  return {
    locator,
    file: 'src/pages/Dashboard.tsx',
    name,
    isFragment: false,
    line: 1,
    column: 1,
    isRoot: false,
    isDirect: true,
    parent: null,
    children: [],
    attributes: [],
    text: null,
  }
}

describe('selection guard around undo/redo', () => {
  beforeEach(() => {
    const s = designer.getState()
    s.select(null)
    s.select(LOC)
    s.setDetails(details('Button'))
  })

  it('drops the selection when a history jump puts a different element at the locator', () => {
    designer.getState().expectSelectedName('Button')
    designer.getState().setDetails(details('div'))
    const s = designer.getState()
    expect(s.selected).toBeNull()
    expect(s.details).toBeNull()
    expect(s.expectedSelectedName).toBeNull()
  })

  it('keeps the selection when the same element is still there (e.g. undoing a prop change)', () => {
    designer.getState().expectSelectedName('Button')
    designer.getState().setDetails(details('Button'))
    const s = designer.getState()
    expect(s.selected).toBe(LOC)
    expect(s.details?.name).toBe('Button')
    expect(s.expectedSelectedName).toBeNull()
  })

  it('ignores details for another locator and is cleared by a new selection', () => {
    designer.getState().expectSelectedName('Button')
    designer.getState().setDetails(details('div', 'src/App.tsx#App#0'))
    expect(designer.getState().selected).toBe(LOC)
    designer.getState().select('src/App.tsx#App#0')
    expect(designer.getState().expectedSelectedName).toBeNull()
  })
})
