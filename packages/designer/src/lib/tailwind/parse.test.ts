import { describe, expect, it } from 'vitest'

import { cssToTailwind, type StyleProperty } from './convert'
import { common, parse, parseToken } from './parse'
import { SCALE_ONLY_THEME } from './theme'

describe('parseToken', () => {
  it('reads the spacing scale: p-4 → padding 1rem, scale 4', () => {
    expect(parseToken('p-4')).toEqual({ token: 'p-4', utility: 'p', css: '1rem', px: 16, scale: 4, name: null })
    expect(parseToken('px-0.5')).toMatchObject({ utility: 'px', css: '0.125rem', px: 2, scale: 0.5 })
    expect(parseToken('p-0')).toMatchObject({ css: '0px', px: 0, scale: 0 })
    expect(parseToken('p-px')).toMatchObject({ css: '1px', px: 1, scale: null, name: 'px' })
  })

  it('reads arbitrary values and v4 variable shorthands', () => {
    expect(parseToken('p-[13px]')).toMatchObject({ utility: 'p', css: '13px', px: 13, scale: null })
    expect(parseToken('pt-[1.5rem]')).toMatchObject({ utility: 'pt', css: '1.5rem', px: 24 })
    expect(parseToken('w-[calc(100%_-_2rem)]')).toMatchObject({ utility: 'w', css: 'calc(100% - 2rem)', px: null })
    expect(parseToken('py-(--card-spacing)')).toMatchObject({ utility: 'py', css: 'var(--card-spacing)' })
  })

  it('reads negative margins and auto', () => {
    expect(parseToken('-m-2')).toMatchObject({ utility: 'm', css: '-0.5rem', px: -8, scale: -2 })
    expect(parseToken('-mt-[13px]')).toMatchObject({ utility: 'mt', css: '-13px', px: -13 })
    expect(parseToken('mx-auto')).toMatchObject({ utility: 'mx', css: 'auto', name: 'auto' })
  })

  it('rejects classes Tailwind does not generate', () => {
    expect(parseToken('p-3.3')).toBeNull() // off the 0.25 grid
    expect(parseToken('-p-2')).toBeNull() // padding has no negative
    expect(parseToken('-mx-auto')).toBeNull()
    expect(parseToken('p-auto')).toBeNull()
  })

  it('leaves variants, important and unrelated utilities alone', () => {
    for (const token of ['md:p-4', 'hover:opacity-50', '[&>*]:p-2', 'p-4!', '!p-4', 'max-w-3xl', 'pointer-events-none', 'text-muted-foreground', 'rounded-t-lg', 'font-sans', 'justify-items-center']) {
      expect(parseToken(token), token).toBeNull()
    }
  })

  it('reads layout keywords as their CSS values', () => {
    expect(parseToken('hidden')).toMatchObject({ utility: 'display', css: 'none' })
    expect(parseToken('inline-flex')).toMatchObject({ utility: 'display', css: 'inline-flex' })
    expect(parseToken('flex-col')).toMatchObject({ utility: 'flex-direction', css: 'column' })
    expect(parseToken('flex-wrap')).toMatchObject({ utility: 'flex-wrap', css: 'wrap' })
    expect(parseToken('items-center')).toMatchObject({ utility: 'align-items', css: 'center' })
    expect(parseToken('justify-between')).toMatchObject({ utility: 'justify-content', css: 'space-between' })
  })

  it('reads sizes', () => {
    expect(parseToken('w-full')).toMatchObject({ utility: 'w', css: '100%', name: 'full' })
    expect(parseToken('h-screen')).toMatchObject({ utility: 'h', css: '100vh', name: 'screen' })
    expect(parseToken('w-1/2')).toMatchObject({ utility: 'w', css: '50%', name: '1/2' })
    expect(parseToken('w-64')).toMatchObject({ utility: 'w', css: '16rem', px: 256, scale: 64 })
    expect(parseToken('size-4')).toMatchObject({ utility: 'size', px: 16 })
    expect(parseToken('w-sm')).toMatchObject({ utility: 'w', css: 'var(--container-sm)', name: 'sm' })
  })

  it('reads radius, typography and opacity', () => {
    expect(parseToken('rounded-lg')).toMatchObject({ utility: 'rounded', css: '0.5rem', px: 8, name: 'lg' })
    expect(parseToken('rounded')).toMatchObject({ utility: 'rounded', css: '0.25rem', name: '' })
    expect(parseToken('rounded-[10px]')).toMatchObject({ utility: 'rounded', css: '10px', px: 10 })
    expect(parseToken('text-sm')).toMatchObject({ utility: 'font-size', css: '0.875rem', px: 14, name: 'sm' })
    expect(parseToken('text-sm/6')).toMatchObject({ utility: 'font-size', name: 'sm' })
    expect(parseToken('text-[13px]')).toMatchObject({ utility: 'font-size', css: '13px' })
    expect(parseToken('text-[length:var(--fs)]')).toMatchObject({ utility: 'font-size', css: 'var(--fs)' })
    expect(parseToken('text-[#fff]')).toBeNull() // a color
    expect(parseToken('font-semibold')).toMatchObject({ utility: 'font-weight', css: '600', name: 'semibold' })
    expect(parseToken('font-[450]')).toMatchObject({ utility: 'font-weight', css: '450' })
    expect(parseToken('text-center')).toMatchObject({ utility: 'text-align', css: 'center' })
    expect(parseToken('opacity-50')).toMatchObject({ utility: 'opacity', css: '0.5' })
  })

  it('recognises named tokens without a value when the theme has none', () => {
    expect(parseToken('rounded-lg', SCALE_ONLY_THEME)).toMatchObject({ utility: 'rounded', css: null, px: null, name: 'lg' })
    expect(parseToken('text-sm', SCALE_ONLY_THEME)).toMatchObject({ utility: 'font-size', css: null, name: 'sm' })
  })
})

describe('parse', () => {
  it('resolves box sides by CSS precedence, not className order', () => {
    const s = parse('pt-2 p-4 px-6')
    expect(s.padding.top?.token).toBe('pt-2')
    expect(s.padding.bottom?.token).toBe('p-4')
    expect(s.padding.left?.token).toBe('px-6')
    expect(s.padding.right?.token).toBe('px-6')
    expect(s.paddingMode).toBe('sides')
  })

  it('lets the later token win within one level', () => {
    expect(parse('p-4 p-6').padding.top?.token).toBe('p-6')
  })

  it('derives the editor mode from what is written', () => {
    expect(parse('p-4').paddingMode).toBe('all')
    expect(parse('px-2 py-4').paddingMode).toBe('axis')
    expect(parse('mt-2').marginMode).toBe('sides')
    expect(parse('gap-4').gapMode).toBe('all')
    expect(parse('gap-x-4').gapMode).toBe('axis')
  })

  it('splits gap and size into their axes', () => {
    const s = parse('gap-4 gap-x-2 size-8 w-full')
    expect(s.gap.row?.token).toBe('gap-4')
    expect(s.gap.column?.token).toBe('gap-x-2')
    expect(s.width?.token).toBe('w-full')
    expect(s.height?.token).toBe('size-8')
  })

  it('collects everything else in `other`, in order', () => {
    const s = parse('mx-auto grid max-w-3xl gap-6 md:p-4 text-muted-foreground')
    expect(s.display?.css).toBe('grid')
    expect(s.margin.left?.css).toBe('auto')
    expect(s.gap.row?.px).toBe(24)
    expect(s.other).toEqual(['max-w-3xl', 'md:p-4', 'text-muted-foreground'])
  })

  it('handles empty and whitespace-only classNames', () => {
    expect(parse('').other).toEqual([])
    expect(parse('  \n ').padding.top).toBeNull()
  })
})

describe('common', () => {
  it('reports shared, mixed and unset values', () => {
    const s = parse('px-4 py-[1rem]')
    expect(common([s.padding.top, s.padding.bottom])).toMatchObject({ kind: 'value', token: { token: 'py-[1rem]' } })
    // 1rem written two ways is still one value
    expect(common([s.padding.top, s.padding.left]).kind).toBe('value')
    expect(common([parse('pt-2').padding.top, null]).kind).toBe('mixed')
    expect(common([null, null]).kind).toBe('unset')
  })
})

describe('round trip: cssToTailwind → parseToken gives back the CSS', () => {
  const rows: ReadonlyArray<readonly [StyleProperty, string]> = [
    ['padding', '1.5rem'],
    ['padding', '0.125rem'],
    ['padding', '13px'],
    ['padding-inline', '1rem'],
    ['margin-top', '-0.5rem'],
    ['margin', 'auto'],
    ['gap', '0.375rem'],
    ['column-gap', '2rem'],
    ['width', '100%'],
    ['width', '16rem'],
    ['height', '100vh'],
    ['width', '300px'],
    ['display', 'none'],
    ['display', 'inline-flex'],
    ['flex-direction', 'column'],
    ['align-items', 'center'],
    ['justify-content', 'space-between'],
    ['border-radius', '0.5rem'],
    ['border-radius', '10px'],
    ['font-size', '0.875rem'],
    ['font-size', '13px'],
    ['font-weight', '600'],
    ['text-align', 'center'],
    ['opacity', '0.5'],
  ]
  it.each(rows)('%s: %s', (property, value) => {
    const cls = cssToTailwind(property, value)
    const parsed = parseToken(cls)
    expect(parsed, cls).not.toBeNull()
    expect(parsed?.css).toBe(value === '300px' ? '18.75rem' : value)
  })

  it('round-trips a whole className through parse → convert', () => {
    const s = parse('flex flex-col items-center justify-between gap-4 p-6 rounded-lg text-sm font-medium opacity-80')
    const back = [
      cssToTailwind('display', s.display!.css!),
      cssToTailwind('flex-direction', s.flexDirection!.css!),
      cssToTailwind('align-items', s.alignItems!.css!),
      cssToTailwind('justify-content', s.justifyContent!.css!),
      cssToTailwind('gap', s.gap.row!.css!),
      cssToTailwind('padding', s.padding.top!.css!),
      cssToTailwind('border-radius', s.radius!.css!),
      cssToTailwind('font-size', s.fontSize!.css!),
      cssToTailwind('font-weight', s.fontWeight!.css!),
      cssToTailwind('opacity', s.opacity!.css!),
    ]
    expect(back.join(' ')).toBe('flex flex-col items-center justify-between gap-4 p-6 rounded-lg text-sm font-medium opacity-80')
  })
})
