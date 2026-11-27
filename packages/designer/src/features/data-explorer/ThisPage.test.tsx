// @vitest-environment jsdom
//
// The Data tab's card for the page on the canvas, when Trivia cannot read it: what it found and
// why, instead of nothing (GET /refine/unread, stubbed).

import { afterEach, expect, it, vi } from 'vitest'

import type { UnreadPage } from '@/shared/engine/types'
import { type Mounted, mount, settle } from '@/shared/lib/test-utils'

import { ThisPage } from './ThisPage'

const LIST = 'src/pages/orders/list.tsx'
const stubs = vi.hoisted(() => ({ unread: [] as unknown[], files: [] as string[] }))
vi.mock('@/shared/engine/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/shared/engine/client')>()
  return { ...real, engine: { ...real.engine, refinePages: async () => [], refineUnread: async () => stubs.unread } }
})
vi.mock('@/shared/canvas', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/shared/canvas')>()
  return {
    ...real,
    canvas: { ...real.canvas, layers: () => stubs.files.map((file) => ({ locator: `${file}#OrderList#0`, name: 'div', count: 1, text: null, children: [] })) },
  }
})

let ui: Mounted | null = null
afterEach(async () => {
  await ui?.unmount()
  ui = null
})

const orders: UnreadPage = {
  file: LIST,
  component: 'OrderList',
  hook: 'useTable',
  line: 5,
  reason: 'the columns come from `columns`, which is not declared in this file (imported?); Trivia reads columns written as an array literal in this file',
}

it('says why the page on the canvas is not read, where it said nothing', async () => {
  stubs.unread = [orders, { ...orders, file: 'src/pages/other/list.tsx', component: 'OtherList' }]
  stubs.files = [LIST]
  ui = await mount(<ThisPage />)
  await settle()
  const card = document.querySelector("[aria-label='OrderList is not read']")
  expect(card?.textContent).toContain(`${LIST}:5`)
  expect(card?.textContent).toContain("Trivia can't edit this list's columns: the columns come from `columns`, which is not declared in this file")
  expect(document.querySelector("[aria-label='OtherList is not read']")).toBeNull() // not on the canvas
})

it('shows nothing for a page that is not on the canvas', async () => {
  stubs.unread = [orders]
  stubs.files = ['src/pages/customers/list.tsx']
  ui = await mount(<ThisPage />)
  await settle()
  expect(document.querySelector("[aria-label='This page']")).toBeNull()
})
