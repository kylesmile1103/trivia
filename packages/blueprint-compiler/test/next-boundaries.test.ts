import { describe, expect, it } from 'vitest'

import { planBoundaries } from '../src/targets/next-refine/boundaries.js'

describe('FR-NX-02 client boundaries', () => {
  it('joins two inputs that share state at their lowest common ancestor', () => {
    expect(planBoundaries([
      { id: 'page', parent: null },
      { id: 'card', parent: 'page' },
      { id: 'first', parent: 'card', client: true, dependencies: ['state.filter'] },
      { id: 'second', parent: 'card', client: true, dependencies: ['state.filter'] },
    ]).roots).toEqual(['card'])
  })

  it('keeps a static header on the server above a client table', () => {
    expect(planBoundaries([
      { id: 'page', parent: null },
      { id: 'heading', parent: 'page' },
      { id: 'table', parent: 'page', client: true },
    ]).roots).toEqual(['table'])
  })

  it('omits a view for a fully static tree', () => {
    expect(planBoundaries([{ id: 'page', parent: null }, { id: 'heading', parent: 'page' }])).toEqual({
      roots: [], crossings: [], invalid: [],
    })
  })

  it('merges a nested group into its enclosing client boundary', () => {
    expect(planBoundaries([
      { id: 'page', parent: null },
      { id: 'tabs', parent: 'page', client: true },
      { id: 'panel', parent: 'tabs' },
      { id: 'first', parent: 'panel', client: true, dependencies: ['state.filter'] },
      { id: 'second', parent: 'panel', client: true, dependencies: ['state.filter'] },
      { id: 'footer', parent: 'page', client: true },
    ]).roots).toEqual(['footer', 'tabs'])
  })

  it('assigns server props to the merged boundary and refuses a crossing function', () => {
    expect(planBoundaries([
      { id: 'page', parent: null },
      { id: 'panel', parent: 'page', client: true },
      { id: 'editor', parent: 'panel', client: true, values: [
        { pointer: '/bindings/editor/label', serializable: true },
        { pointer: '/bindings/editor/format', serializable: false },
      ] },
    ])).toEqual({
      roots: ['panel'],
      crossings: [{ boundary: 'panel', node: 'editor', pointer: '/bindings/editor/label' }],
      invalid: [{ boundary: 'panel', node: 'editor', pointer: '/bindings/editor/format' }],
    })
  })
})
