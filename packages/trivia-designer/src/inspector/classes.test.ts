import { describe, expect, it } from 'vitest'

import { classValue, mergeClasses, overrides, removeClass, splitClasses } from './classes'

describe('splitClasses', () => {
  it('splits on any whitespace and drops empties', () => {
    expect(splitClasses('  justify-end\n  gap-2\tp-4 ')).toEqual(['justify-end', 'gap-2', 'p-4'])
    expect(splitClasses('')).toEqual([])
  })
})

describe('overrides', () => {
  it('follows tailwind-merge conflict groups', () => {
    expect(overrides('p-6', 'p-4')).toBe(true)
    expect(overrides('p-4', 'px-2')).toBe(true)
    expect(overrides('px-2', 'p-4')).toBe(false) // refines, does not replace
    expect(overrides('gap-4', 'justify-end')).toBe(false)
    expect(overrides('p-4', 'p-4')).toBe(false)
  })
})

describe('mergeClasses', () => {
  it('replaces a conflicting utility in place', () => {
    expect(mergeClasses(['p-4', 'justify-end'], ['p-6'])).toEqual(['p-6', 'justify-end'])
    expect(mergeClasses(['justify-end', 'gap-2'], ['gap-4'])).toEqual(['justify-end', 'gap-4'])
  })

  it('appends non-conflicting tokens in the order given', () => {
    expect(mergeClasses(['justify-end'], ['gap-2', 'text-sm'])).toEqual(['justify-end', 'gap-2', 'text-sm'])
  })

  it('ignores tokens that are already present', () => {
    expect(mergeClasses(['p-4', 'flex'], ['flex'])).toEqual(['p-4', 'flex'])
  })

  it('lets the later of two conflicting additions win', () => {
    expect(mergeClasses(['flex'], ['p-4', 'p-6'])).toEqual(['flex', 'p-6'])
    expect(mergeClasses(['p-2', 'flex'], ['p-4', 'p-6'])).toEqual(['p-6', 'flex'])
  })

  it('collapses several replaced tokens into the first slot', () => {
    expect(mergeClasses(['px-2', 'flex', 'py-1'], ['p-4'])).toEqual(['p-4', 'flex'])
  })

  it('never drops authored tokens that only conflict with each other', () => {
    expect(mergeClasses(['px-2', 'p-4'], ['flex'])).toEqual(['px-2', 'p-4', 'flex'])
  })

  it('keeps unknown tokens (partial input while typing) without conflicts', () => {
    expect(mergeClasses(['p-4'], ['p-'])).toEqual(['p-4', 'p-'])
  })
})

describe('removeClass / classValue', () => {
  it('removes every occurrence and maps an empty list to null', () => {
    expect(removeClass(['a', 'b', 'a'], 'a')).toEqual(['b'])
    expect(classValue(['b', 'c'])).toBe('b c')
    expect(classValue([])).toBeNull()
  })
})
