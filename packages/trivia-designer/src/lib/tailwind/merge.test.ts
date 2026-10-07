import { twMerge } from 'tailwind-merge'
import { describe, expect, it } from 'vitest'

import { mergeClassName, removeUtilities } from './merge'

describe('mergeClassName: conflict resolution', () => {
  it.each([
    ['p-4', 'p-6', 'p-6'],
    ['px-2 py-4', 'p-6', 'p-6'],
    ['pt-2 p-4', 'p-6', 'p-6'],
    ['p-4', 'px-6', 'p-4 px-6'],
    ['p-4 px-2', 'px-6', 'p-4 px-6'],
    ['-m-2', 'm-4', 'm-4'],
    ['ml-2', 'mx-auto', 'mx-auto'],
    ['gap-x-2 gap-y-4', 'gap-6', 'gap-6'],
    ['flex', 'hidden', 'hidden'],
    ['flex', 'inline-flex', 'inline-flex'],
    ['flex-row', 'flex-col', 'flex-col'],
    ['items-center', 'items-start', 'items-start'],
    ['justify-between', 'justify-end', 'justify-end'],
    ['size-4', 'w-6', 'size-4 w-6'],
    ['w-1/2', 'w-[300px]', 'w-[300px]'],
    ['rounded-t-lg', 'rounded-xl', 'rounded-xl'],
    ['opacity-50', 'opacity-[0.375]', 'opacity-[0.375]'],
    ['font-medium', 'font-[450]', 'font-[450]'],
    ['text-[13px]', 'text-sm', 'text-sm'],
  ])('%j + %j → %j', (current, addition, expected) => {
    expect(mergeClassName(current, addition)).toBe(expected)
  })
})

describe('mergeClassName: keeps unrelated tokens and their order', () => {
  it('replaces in place', () => {
    expect(mergeClassName('p-4 flex items-center', 'p-6')).toBe('p-6 flex items-center')
    expect(mergeClassName('mx-auto grid max-w-3xl gap-6', 'gap-8')).toBe('mx-auto grid max-w-3xl gap-8')
    expect(mergeClassName('px-2 flex py-4 text-sm', 'p-6')).toBe('p-6 flex text-sm')
  })

  it('appends when nothing conflicts', () => {
    expect(mergeClassName('grid gap-2', 'p-6')).toBe('grid gap-2 p-6')
    expect(mergeClassName('', 'p-6')).toBe('p-6')
    expect(mergeClassName('   ', 'p-6')).toBe('p-6')
  })

  it('keeps font size and text color apart', () => {
    expect(mergeClassName('text-sm text-muted-foreground', 'text-lg')).toBe('text-lg text-muted-foreground')
    expect(mergeClassName('text-center text-sm', 'text-[13px]')).toBe('text-center text-[13px]')
  })

  it('never touches variants', () => {
    expect(mergeClassName('md:p-4 p-2', 'p-6')).toBe('md:p-4 p-6')
    expect(mergeClassName('hover:opacity-50 flex', 'opacity-80')).toBe('hover:opacity-50 flex opacity-80')
  })

  it('leaves conflicts among existing tokens alone unless an addition touches them', () => {
    expect(mergeClassName('p-4 p-2 flex', 'gap-2')).toBe('p-4 p-2 flex gap-2')
  })

  it('preserves the whitespace of multi-line classNames', () => {
    expect(mergeClassName('\n  flex\n  p-4\n  text-sm\n', 'p-6')).toBe('\n  flex\n  p-6\n  text-sm\n')
    expect(mergeClassName('flex  p-4', 'gap-2')).toBe('flex  p-4 gap-2')
    expect(mergeClassName('\n  px-2\n  py-4\n', 'p-6')).toBe('\n  p-6\n')
  })

  it('applies several additions in order, like twMerge', () => {
    expect(mergeClassName('flex p-4', ['px-2', 'p-6'])).toBe('flex p-6')
    expect(mergeClassName('flex p-4', 'p-6 px-2')).toBe('flex p-6 px-2')
  })

  it('stays correct when a component runs it through twMerge again (cn(base, className))', () => {
    // In place would give "pt-6 flex p-4", which twMerge reads as "flex p-4".
    const merged = mergeClassName('pt-2 flex p-4', 'pt-6')
    expect(merged).toBe('flex p-4 pt-6')
    expect(twMerge('px-6', merged).split(' ')).toContain('pt-6')
  })

  it('is twMerge-equivalent as a set of classes', () => {
    const cases: Array<[string, string]> = [
      ['p-4 flex', 'p-6'],
      ['px-2 flex py-4 text-sm', 'p-6'],
      ['grid gap-2', 'p-6'],
      ['size-4 rounded-t-lg text-sm', 'w-6 rounded-xl text-[13px]'],
      ['items-center justify-between flex', 'flex-col items-start'],
    ]
    for (const [current, additions] of cases) {
      const ours = new Set(mergeClassName(current, additions).split(/\s+/))
      const theirs = new Set(twMerge(current, additions).split(/\s+/))
      expect(ours, `${current} + ${additions}`).toEqual(theirs)
    }
  })
})

describe('removeUtilities', () => {
  it('removes only base tokens of the named utilities', () => {
    expect(removeUtilities('p-4 md:p-2 flex', ['p'])).toBe('md:p-2 flex')
    expect(removeUtilities('flex px-2 py-4 pt-1 text-sm', ['px', 'py', 'pt'])).toBe('flex text-sm')
    expect(removeUtilities('rounded-lg text-sm text-muted-foreground', ['font-size'])).toBe('rounded-lg text-muted-foreground')
    expect(removeUtilities('p-4 px-2', ['p'])).toBe('px-2')
  })

  it('collapses to "" when nothing is left', () => {
    expect(removeUtilities(' p-4 ', ['p'])).toBe('')
  })
})
