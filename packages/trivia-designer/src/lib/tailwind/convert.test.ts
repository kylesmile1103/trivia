import { describe, expect, it } from 'vitest'

import { cssToTailwind, declarationsToTailwind, type StyleProperty, TailwindConversionError } from './convert'
import { SCALE_ONLY_THEME } from './theme'

type Row = readonly [StyleProperty, string, string]

function table(rows: readonly Row[]) {
  it.each(rows)('%s: %s → %s', (property, value, expected) => {
    expect(cssToTailwind(property, value)).toBe(expected)
  })
}

describe('spacing scale (1 unit = 0.25rem = 4px)', () => {
  table([
    ['padding', '16px', 'p-4'],
    ['padding', '1rem', 'p-4'],
    ['padding', '1.5rem', 'p-6'],
    ['padding', '24px', 'p-6'],
    ['padding', '0.125rem', 'p-0.5'],
    ['padding', '2px', 'p-0.5'],
    ['padding', '6px', 'p-1.5'],
    ['padding', '0', 'p-0'],
    ['padding', '0px', 'p-0'],
    ['padding', '0rem', 'p-0'],
    ['padding', '1px', 'p-px'],
    ['padding', '384px', 'p-96'],
    ['padding', '24rem', 'p-96'],
  ])
})

describe('off-scale values become arbitrary in the unit given', () => {
  table([
    ['padding', '13px', 'p-[13px]'],
    ['padding', '3px', 'p-[3px]'],
    ['padding', '0.8rem', 'p-[0.8rem]'],
    ['padding', '388px', 'p-[388px]'],
    ['padding', '25rem', 'p-[25rem]'],
    ['padding', '5%', 'p-[5%]'],
    ['padding', '2em', 'p-[2em]'],
    ['padding', 'calc(1rem + 2px)', 'p-[calc(1rem_+_2px)]'],
    ['padding', 'var(--gutter)', 'p-[var(--gutter)]'],
  ])
})

describe('padding sides and shorthands', () => {
  table([
    ['padding-top', '8px', 'pt-2'],
    ['padding-right', '0.75rem', 'pr-3'],
    ['padding-bottom', '13px', 'pb-[13px]'],
    ['padding-left', '1px', 'pl-px'],
    ['padding-inline', '1.5rem', 'px-6'],
    ['padding-block', '4px', 'py-1'],
    ['padding', '1rem 2rem', 'py-4 px-8'],
    ['padding', '1rem 1rem', 'p-4'],
    ['padding', '4px 8px 12px', 'pt-1 pb-3 px-2'],
    ['padding', '4px 8px 4px 12px', 'py-1 pr-2 pl-3'],
    ['padding', '4px 8px 12px 16px', 'pt-1 pb-3 pr-2 pl-4'],
  ])
})

describe('margin: negatives and auto', () => {
  table([
    ['margin', '-0.5rem', '-m-2'],
    ['margin', '-8px', '-m-2'],
    ['margin', '-13px', '-m-[13px]'],
    ['margin', '-1px', '-m-px'],
    ['margin', 'auto', 'm-auto'],
    ['margin-inline', 'auto', 'mx-auto'],
    ['margin-top', '-1rem', '-mt-4'],
    ['margin-block', '2rem', 'my-8'],
    ['margin', '0 auto', 'my-0 mx-auto'],
    ['margin', '-4px 8px', '-my-1 mx-2'],
  ])
})

describe('gap', () => {
  table([
    ['gap', '16px', 'gap-4'],
    ['gap', '0.375rem', 'gap-1.5'],
    ['gap', '13px', 'gap-[13px]'],
    ['row-gap', '8px', 'gap-y-2'],
    ['column-gap', '2rem', 'gap-x-8'],
    ['gap', '8px 16px', 'gap-y-2 gap-x-4'],
    ['gap', '8px 8px', 'gap-2'],
  ])
})

describe('layout keywords', () => {
  table([
    ['display', 'block', 'block'],
    ['display', 'flex', 'flex'],
    ['display', 'grid', 'grid'],
    ['display', 'inline-flex', 'inline-flex'],
    ['display', 'none', 'hidden'],
    ['display', 'FLEX', 'flex'],
    ['flex-direction', 'row', 'flex-row'],
    ['flex-direction', 'column', 'flex-col'],
    ['flex-direction', 'column-reverse', 'flex-col-reverse'],
    ['flex-wrap', 'wrap', 'flex-wrap'],
    ['flex-wrap', 'nowrap', 'flex-nowrap'],
    ['align-items', 'center', 'items-center'],
    ['align-items', 'flex-start', 'items-start'],
    ['align-items', 'end', 'items-end'],
    ['align-items', 'stretch', 'items-stretch'],
    ['justify-content', 'space-between', 'justify-between'],
    ['justify-content', 'flex-end', 'justify-end'],
    ['justify-content', 'center', 'justify-center'],
    ['justify-content', 'space-evenly', 'justify-evenly'],
  ])
})

describe('width and height', () => {
  table([
    ['width', 'auto', 'w-auto'],
    ['width', '100%', 'w-full'],
    ['width', 'fit-content', 'w-fit'],
    ['width', '100vw', 'w-screen'],
    ['height', '100vh', 'h-screen'],
    ['height', '100dvh', 'h-dvh'],
    ['width', 'max-content', 'w-max'],
    ['width', '50%', 'w-1/2'],
    ['width', '33.333333%', 'w-1/3'],
    ['width', '75%', 'w-3/4'],
    ['width', '41.666667%', 'w-5/12'],
    ['width', '37%', 'w-[37%]'],
    ['width', '16rem', 'w-64'],
    ['height', '40px', 'h-10'],
    ['width', '300px', 'w-75'],
    ['width', '388px', 'w-[388px]'],
    ['height', '1px', 'h-px'],
  ])
})

describe('radius (Tailwind v4 default theme)', () => {
  table([
    ['border-radius', '0', 'rounded-none'],
    ['border-radius', '0.125rem', 'rounded-xs'],
    ['border-radius', '4px', 'rounded-sm'],
    ['border-radius', '0.375rem', 'rounded-md'],
    ['border-radius', '0.5rem', 'rounded-lg'],
    ['border-radius', '12px', 'rounded-xl'],
    ['border-radius', '1rem', 'rounded-2xl'],
    ['border-radius', '9999px', 'rounded-full'],
    ['border-radius', 'calc(infinity * 1px)', 'rounded-full'],
    ['border-radius', '10px', 'rounded-[10px]'],
    ['border-radius', '50%', 'rounded-[50%]'],
  ])

  it('maps lengths only to exact named tokens under SCALE_ONLY_THEME', () => {
    expect(cssToTailwind('border-radius', '0.5rem', SCALE_ONLY_THEME)).toBe('rounded-[0.5rem]')
    expect(cssToTailwind('border-radius', '0', SCALE_ONLY_THEME)).toBe('rounded-none')
    expect(cssToTailwind('border-radius', '9999px', SCALE_ONLY_THEME)).toBe('rounded-full')
  })
})

describe('typography', () => {
  table([
    ['font-size', '12px', 'text-xs'],
    ['font-size', '0.875rem', 'text-sm'],
    ['font-size', '16px', 'text-base'],
    ['font-size', '1.125rem', 'text-lg'],
    ['font-size', '1.5rem', 'text-2xl'],
    ['font-size', '48px', 'text-5xl'],
    ['font-size', '13px', 'text-[13px]'],
    ['font-size', '1.1em', 'text-[1.1em]'],
    ['font-size', 'var(--fs)', 'text-[length:var(--fs)]'],
    ['font-weight', '400', 'font-normal'],
    ['font-weight', '500', 'font-medium'],
    ['font-weight', '600', 'font-semibold'],
    ['font-weight', 'bold', 'font-bold'],
    ['font-weight', '450', 'font-[450]'],
    ['text-align', 'center', 'text-center'],
    ['text-align', 'right', 'text-right'],
    ['text-align', 'justify', 'text-justify'],
  ])

  it('writes arbitrary font sizes under SCALE_ONLY_THEME', () => {
    expect(cssToTailwind('font-size', '14px', SCALE_ONLY_THEME)).toBe('text-[14px]')
  })
})

describe('opacity', () => {
  table([
    ['opacity', '0.5', 'opacity-50'],
    ['opacity', '1', 'opacity-100'],
    ['opacity', '0', 'opacity-0'],
    ['opacity', '.37', 'opacity-37'],
    ['opacity', '75%', 'opacity-75'],
    ['opacity', '0.375', 'opacity-[0.375]'],
  ])
})

describe('honest errors', () => {
  const bad: ReadonlyArray<readonly [StyleProperty, string]> = [
    ['padding', '-4px'],
    ['padding', '16'],
    ['font-size', '16'],
    ['border-radius', '8'],
    ['padding', 'auto'],
    ['padding', ''],
    ['padding', '1px 2px 3px 4px 5px'],
    ['padding-top', '1px 2px'],
    ['gap', '-1rem'],
    ['margin', '-auto'],
    ['display', 'table-cell-ish'],
    ['align-items', 'normal'],
    ['opacity', '1.5'],
    ['opacity', 'half'],
    ['font-weight', '1200'],
    ['font-size', '-2px'],
    ['border-radius', '-4px'],
    ['width', '-10px'],
    ['padding', 'url("x")'],
    ['padding', '1px;color:red'],
    ['width', 'calc(100% - 2rem'],
    ['font-size', 'sm'],
    ['padding', 'abc'],
    ['border-radius', 'large'],
    ['width', 'half'],
  ]
  it.each(bad)('%s: %j throws', (property, value) => {
    expect(() => cssToTailwind(property, value)).toThrow(TailwindConversionError)
  })
})

describe('declarationsToTailwind', () => {
  it('converts a preview record in order', () => {
    expect(declarationsToTailwind({ 'padding-inline': '1.5rem', 'padding-block': '8px' })).toEqual(['px-6', 'py-2'])
    expect(declarationsToTailwind({ padding: '1rem 2rem' })).toEqual(['py-4', 'px-8'])
  })

  it('refuses properties it does not handle', () => {
    expect(() => declarationsToTailwind({ color: 'red' })).toThrow(TailwindConversionError)
  })
})
