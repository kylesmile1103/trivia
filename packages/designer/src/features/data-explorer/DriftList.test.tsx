// @vitest-environment jsdom
//
// The drift list over a stubbed GET /refine/drift: each issue's message, and the other code its
// fix leaves behind, named for what that code mentions.

import { afterEach, expect, it, vi } from 'vitest'

import type { ContractDrift } from '@/shared/engine/types'
import { type Mounted, mount, settle } from '@/shared/lib/test-utils'

import { DriftList } from './DriftList'

const drift = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('@/shared/engine/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/shared/engine/client')>()
  return { ...real, engine: { ...real.engine, contractDrift: async () => drift.current } }
})

let ui: Mounted | null = null
afterEach(async () => {
  await ui?.unmount()
  ui = null
})

it('names what the other code mentions: a removed field, or a value the contract dropped', async () => {
  drift.current = {
    spec: null,
    pages: [
      {
        file: 'src/pages/customers/edit.tsx',
        component: 'CustomerEdit',
        kind: 'form',
        issues: [
          {
            code: 'missing_field',
            name: 'nickname',
            message: 'Field Nickname sends `nickname`, which the updateCustomer body no longer has; the file still mentions it on line 40',
            line: 31,
            fix: { label: 'Remove field Nickname', changes: [{ action: 'remove', field: 'nickname' }] },
            references: [{ line: 40, text: 'const shown = values.nickname' }],
          },
          {
            code: 'enum_changed',
            name: 'status',
            message: 'Field Status offers active, suspended; the contract\'s values are active, closed; the file still names "suspended" on line 52',
            line: 44,
            fix: { label: 'Update the Status options from the contract', changes: [{ action: 'align', field: 'status' }] },
            references: [{ line: 52, text: 'if (status === "suspended") warn()' }],
          },
        ],
      },
    ],
  } satisfies ContractDrift
  ui = await mount(<DriftList reload={0} />)
  await settle()

  const list = (label: string) => document.querySelector(`ul[aria-label='${label}']`)?.textContent
  expect(list('Other code that names nickname')).toBe('40: const shown = values.nickname')
  expect(list('Other code that names a status value the contract dropped')).toBe('52: if (status === "suspended") warn()')
  expect(document.querySelector("ul[aria-label='Other code that names status']")).toBeNull()
})
