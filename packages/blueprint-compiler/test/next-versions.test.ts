import { readFileSync } from 'node:fs'

import { expect, it } from 'vitest'

it('pins the verified App Router and Refine versions in LLD-12', () => {
  const example = JSON.parse(readFileSync(new URL('../../../examples/next-admin/package.json', import.meta.url), 'utf8'))
  const design = readFileSync(new URL('../../../docs/blueprint/lld/LLD-12-nextjs-codegen-target.md', import.meta.url), 'utf8')
  for (const name of ['next', 'react', 'react-dom', '@refinedev/core', '@refinedev/nextjs-router', '@refinedev/react-hook-form', '@tanstack/react-query']) {
    expect(example.dependencies[name]).toMatch(/^\d+\.\d+\.\d+$/)
    expect(design).toContain('`' + name + '@' + example.dependencies[name] + '`')
  }
})
