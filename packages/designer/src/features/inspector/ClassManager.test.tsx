// @vitest-environment jsdom
//
// What the class manager writes. The value is the user's authored className with only the
// touched tokens changed: its whitespace (a multi-line className's line breaks and indentation)
// is part of the source the edit must not reformat.

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { NodeDetails } from '@/shared/engine/types'

import { ClassManager } from './ClassManager'
import { find, type Mounted, mount, press, settle, typeInto } from '@/shared/lib/test-utils'

const MULTI_LINE = '\n        flex items-center\n        gap-2 px-2 p-4\n      '

let writes: Array<string | null>
let view: Mounted | null

beforeEach(() => {
  writes = []
  view = null
})

afterEach(async () => {
  await view?.unmount()
})

function details(className: string): NodeDetails {
  return {
    locator: 'src/App.tsx#App#0',
    file: 'src/App.tsx',
    name: 'div',
    isFragment: false,
    line: 1,
    column: 1,
    isRoot: false,
    isDirect: true,
    parent: null,
    children: [],
    attributes: [{ name: 'className', kind: 'string', value: className, source: JSON.stringify(className) }],
    text: null,
  }
}

async function open(authored: string) {
  view = await mount(
    <ClassManager
      details={details(authored)}
      authored={authored}
      commit={async (value) => {
        writes.push(value)
        return true
      }}
    />,
  )
  return view.host
}

async function add(host: HTMLElement, text: string) {
  const input = find<HTMLInputElement>(host, 'input[aria-label="Add classes"]')
  await typeInto(input, text)
  await press(input, { key: 'Enter' })
  await settle()
}

async function removeChip(host: HTMLElement, token: string) {
  await act(async () => find(host, `button[aria-label="Remove class ${token}"]`).click())
  await settle()
}

const chips = (host: HTMLElement) => [...host.querySelectorAll('ul[aria-label="Classes"] > li')].map((li) => li.textContent)

describe('ClassManager writes', () => {
  it('keep a multi-line className’s layout when adding a class', async () => {
    const host = await open(MULTI_LINE)
    await add(host, 'bg-red-500')
    expect(writes).toEqual(['\n        flex items-center\n        gap-2 px-2 p-4 bg-red-500\n      '])
  })

  it('keep a multi-line className’s layout when removing a chip', async () => {
    const host = await open(MULTI_LINE)
    await removeChip(host, 'gap-2')
    expect(writes).toEqual(['\n        flex items-center\n        px-2 p-4\n      '])
  })

  it('keep irregular spacing outside the touched token', async () => {
    const host = await open('flex  items-center   gap-2')
    await add(host, 'gap-4')
    expect(writes).toEqual(['flex  items-center   gap-4'])
  })

  it('place a replacement where a later authored token cannot override it at runtime (cn/twMerge)', async () => {
    // In px-2's slot ("px-8 p-4"), shadcn's cn(base, className) would let the later p-4 win and
    // drop px-8 at runtime, while the UI says px-2 was replaced.
    const host = await open('px-2 p-4')
    const input = find<HTMLInputElement>(host, 'input[aria-label="Add classes"]')
    await typeInto(input, 'px-8')
    expect(host.textContent).toContain('Replaces px-2.')
    await press(input, { key: 'Enter' })
    await settle()
    expect(writes).toEqual(['p-4 px-8'])
  })

  it('replace a conflicting class in place when nothing later overrides it', async () => {
    const host = await open('justify-end gap-2')
    await add(host, 'gap-4')
    expect(writes).toEqual(['justify-end gap-4'])
    expect(chips(host)).toEqual(['justify-end', 'gap-4'])
  })

  it('remove the attribute when the last class goes', async () => {
    const host = await open('  flex  ')
    await removeChip(host, 'flex')
    expect(writes).toEqual([null])
  })

  it('write nothing when every typed class is already there', async () => {
    const host = await open(MULTI_LINE)
    await add(host, 'flex p-4')
    expect(writes).toEqual([])
  })

  it('ignore a typed class that is already there instead of letting it drop authored tokens', async () => {
    const host = await open('px-2 p-4')
    await add(host, 'p-4 flex')
    expect(writes).toEqual(['px-2 p-4 flex'])
  })
})
