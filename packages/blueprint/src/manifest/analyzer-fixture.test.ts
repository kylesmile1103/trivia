import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, it } from 'vitest'

import { FIXTURES } from '../../test/helpers.js'

it('FR-MF-02: records the real Refine Admin analyzer output with project-relative paths', () => {
  const text = readFileSync(join(FIXTURES, 'manifests/analyzer/refine-admin.components.json'), 'utf8')
  const components: Array<{ name: string; file: string; importSource: string; props: unknown[] }> = JSON.parse(text)
  const button = components.find(({ name }) => name === 'Button')

  expect(button).toMatchObject({
    file: 'src/components/ui/button.tsx',
    importSource: '@/components/ui/button',
    props: expect.arrayContaining([
      { name: 'variant', kind: 'enum', source: 'variant', optional: true, default: 'default',
        options: ['default', 'outline', 'secondary', 'ghost', 'destructive', 'link'] },
    ]),
  })
  expect(text).toBe(JSON.stringify(components, null, 2) + '\n')
})
