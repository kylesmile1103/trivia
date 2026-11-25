import { expect, it } from 'vitest'

import { projectFacts } from '../src/facts.js'
import type { ImportIR } from '../src/ir.js'
import { printImports } from '../src/print/imports.js'
import { literal, statement } from '../src/print/style.js'

it('FR-RC-04: groups and deduplicates imports by what the module references', () => {
  const facts = projectFacts({ aliases: { ui: '#/ui' }, entrySource: "import 'styles'\n" })
  const imports: ImportIR[] = [
    { source: './helpers', name: 'helper' },
    { source: '#/ui/input', name: 'Input' },
    { source: 'react', name: 'useState' },
    { source: 'react', name: 'ChangeEvent', kind: 'type' },
    { source: '#/ui/input', name: 'Input' },
    { source: '@/components/ui/button', name: 'Button', as: 'Button2' },
    { source: 'react', name: 'useEffect' },
    { source: '@refinedev/core', name: 'useGo' },
  ]
  const expected = [
    "import { useGo } from '@refinedev/core'",
    "import type { ChangeEvent } from 'react'",
    "import { useEffect, useState } from 'react'",
    '',
    "import { Input } from '#/ui/input'",
    "import { Button as Button2 } from '@/components/ui/button'",
    '',
    "import { helper } from './helpers'",
  ].join('\n')
  expect(printImports(imports, facts)).toBe(expected)
  expect(printImports(imports.toReversed(), facts)).toBe(expected)
})

it('FR-RC-11: prints literals and statements using project style', () => {
  const single = { quotes: 'single', semicolons: false } as const
  const double = { quotes: 'double', semicolons: true } as const
  const tricky = "Café's \"quote\"\\path\n"
  expect(literal(tricky, single)).toBe("'Café\\'s \"quote\"\\\\path\\n'")
  expect(literal(tricky, double)).toBe(JSON.stringify(tricky))
  expect(literal({ z: true, a: ['a', 'b'] }, single)).toBe("{ a: ['a', 'b'], z: true }")
  expect(statement('const x = 1', single)).toBe('const x = 1')
  expect(statement('const x = 1', double)).toBe('const x = 1;')
})
