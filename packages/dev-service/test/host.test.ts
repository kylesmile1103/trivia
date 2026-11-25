import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect, it, vi } from 'vitest'

import { EngineService } from '../src/api/service.js'
import { loadEngine } from '../src/engine.js'
import type { DevHost, RouteSource } from '../src/host.js'

it('FR-TN-02 delegates route discovery to the host with the engine readers', async () => {
  const root = fs.realpathSync(path.resolve(import.meta.dirname, '../../../examples/playground'))
  const route = {
    path: '/dashboard', params: [], index: false, catchAll: false, router: 'react-router' as const,
    component: 'Dashboard', file: 'src/pages/Dashboard.tsx',
    declared: { file: 'src/pages/Dashboard.tsx', line: 1 }, locator: null,
  }
  const readRoutes = vi.fn(async ({ outline }: RouteSource) => {
    expect(outline(route.file)).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'div' })]))
    return [route]
  })
  const host: DevHost = {
    root,
    kind: 'vite',
    uiDir: 'src/components/ui',
    importBase: '@/components/ui',
    allowedHosts: [],
    resolveModule: async () => null,
    readRoutes,
    preview: { publish: () => '/preview' },
  }
  const service = new EngineService({ host, engine: await loadEngine(), version: 'test' })
  expect(await service.routes()).toEqual([{ ...route, resource: null }])
  expect(readRoutes).toHaveBeenCalledOnce()
})

// A file watcher can miss a write (an edit and its undo milliseconds apart), and a host that
// missed one keeps serving the module it transformed before: the canvas then shows stale code,
// even after a reload. So the service names every file it wrote, after the write succeeded.
it('tells the host which files an edit, an undo and a redo wrote, and nothing for a no-op or a refusal', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'trivia-host-'))
  fs.mkdirSync(path.join(root, 'src/components/ui'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src/App.tsx'), 'export function App() {\n  return <div title="a" />\n}\n')
  const filesChanged = vi.fn()
  const host: DevHost = {
    root, kind: 'vite', uiDir: 'src/components/ui', importBase: '@/components/ui', allowedHosts: [],
    resolveModule: async () => null, readRoutes: async () => [], preview: { publish: () => '/preview' },
    filesChanged,
  }
  const service = new EngineService({ host, engine: await loadEngine(), version: 'test' })
  const edit = (value: string) => ({ op: 'updateProp', target: 'src/App.tsx#App#0', expectedName: 'div', prop: 'title', value })

  await service.apply(edit('b'), 'edit')
  expect(filesChanged).toHaveBeenLastCalledWith(['src/App.tsx'])
  await service.undo()
  expect(filesChanged).toHaveBeenLastCalledWith(['src/App.tsx'])
  await service.redo()
  expect(filesChanged).toHaveBeenLastCalledWith(['src/App.tsx'])
  expect(filesChanged).toHaveBeenCalledTimes(3)

  await service.apply(edit('b'), 'no-op')
  await expect(service.apply({ ...edit('c'), expectedName: 'span' }, 'refused')).rejects.toThrow()
  expect(filesChanged).toHaveBeenCalledTimes(3)
  fs.rmSync(root, { recursive: true, force: true })
})
