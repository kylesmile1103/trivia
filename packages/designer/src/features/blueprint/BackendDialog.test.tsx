// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

import { ApiError, engine } from '@/shared/engine/client'
import type { BlueprintBackendResult, BlueprintSummary } from '@/shared/engine/types'
import { find, mount, typeInto } from '@/shared/lib/test-utils'

import { BackendDialog } from './BackendDialog'

const file = { path: 'src/Bank.Api/Program.cs', kind: 'scaffold', action: 'create' } as const
const plan: BlueprintBackendResult = { files: [file], diagnostics: [], log: '', written: false }
const summary: BlueprintSummary = {
  exists: true, dir: 'blueprint', app: null, model: { rev: 'read', entities: ['Account'] }, pages: [], diagnostics: [], next: '',
}

afterEach(() => vi.restoreAllMocks())

it('FR-DS-06 shows the file table before generation and runs an optional migration after writing', async () => {
  const backend = vi.spyOn(engine.blueprint, 'backend')
    .mockResolvedValueOnce(plan)
    .mockResolvedValueOnce({ ...plan, written: true })
    .mockResolvedValueOnce({ ...plan, written: true, files: [{ ...file, path: 'Migrations/Initial.cs' }] })
  vi.spyOn(engine.blueprint, 'summary').mockResolvedValue(summary)
  const ui = await mount(<BackendDialog modelRev="read" appRev={null} onClose={vi.fn()} />)
  try {
    const dialog = find(globalThis.document.body, '[role="dialog"]')
    expect(find(dialog, 'table').textContent).toContain('src/Bank.Api/Program.cs')
    expect(find(dialog, 'table').textContent).toContain('create')
    expect(dialog.textContent).toContain('outside undo history')
    expect(backend.mock.calls).toEqual([[{ mode: 'plan' }]])
    await typeInto(find<HTMLInputElement>(dialog, 'input'), 'Initial')
    await act(async () => find<HTMLButtonElement>(dialog, 'button[data-confirm]').click())
    expect(backend.mock.calls).toEqual([[{ mode: 'plan' }], [{ mode: 'write' }], [{ mode: 'write', migration: 'Initial' }]])
    expect(dialog.textContent).toContain('Migrations/Initial.cs')
    expect(dialog.textContent).toMatch(/Build[\s\S]*Sync[\s\S]*drift/)
  } finally {
    await ui.unmount()
  }
})

it('FR-DS-06 displays the .NET SDK installation hint when planning is unsupported', async () => {
  vi.spyOn(engine.blueprint, 'backend').mockRejectedValue(new ApiError({
    code: 'unsupported', message: 'dotnet is unavailable.', details: { hint: 'Install the .NET 10 SDK and make dotnet available on PATH.' },
  }, 422))
  const ui = await mount(<BackendDialog modelRev="read" appRev={null} onClose={vi.fn()} />)
  try {
    const dialog = find(document.body, '[role="dialog"]')
    expect(find(dialog, '[role="alert"]').textContent).toContain('Install the .NET 10 SDK')
    expect(dialog.querySelector('[data-confirm]')).toBeNull()
  } finally {
    await ui.unmount()
  }
})

it('FR-DS-06 refuses to write a displayed plan after the model revision changes', async () => {
  const backend = vi.spyOn(engine.blueprint, 'backend').mockResolvedValue(plan)
  vi.spyOn(engine.blueprint, 'summary').mockResolvedValue({ ...summary, model: { rev: 'agent', entities: ['Account'] } })
  const ui = await mount(<BackendDialog modelRev="read" appRev={null} onClose={vi.fn()} />)
  try {
    const dialog = find(document.body, '[role="dialog"]')
    await act(async () => find<HTMLButtonElement>(dialog, 'button[data-confirm]').click())
    expect(find(dialog, '[role="alert"]').textContent).toMatch(/changed.*plan/i)
    expect(backend.mock.calls).toEqual([[{ mode: 'plan' }]])
  } finally {
    await ui.unmount()
  }
})
