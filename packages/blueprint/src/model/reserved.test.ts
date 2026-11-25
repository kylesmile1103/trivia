import fs from 'node:fs'

import { describe, expect, it } from 'vitest'

describe('FR-DM-03: reserved word data', () => {
  it.each([
    ['csharp', ['class', 'namespace', 'while'], ['async', 'record']],
    ['postgres', ['constraint', 'order', 'select'], ['account', 'value']],
    ['generator', ['id', 'items', 'total'], ['customer']],
  ])('records the source and date for %s and stores sorted, unique lower-case words', (name, included, excluded) => {
    const { source, date, words } = JSON.parse(fs.readFileSync(new URL(`./reserved/${name}.json`, import.meta.url), 'utf8'))
    expect(source).toMatch(/\S/)
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(words).toEqual([...new Set(words)].sort())
    expect(words.every((word: string) => /^[a-z][a-z0-9_]*$/.test(word))).toBe(true)
    expect(words).toEqual(expect.arrayContaining(included))
    for (const word of excluded) expect(words).not.toContain(word)
  })
})
