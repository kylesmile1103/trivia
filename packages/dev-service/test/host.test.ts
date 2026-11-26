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

// A host's updates for the service's writes come from its own file watcher, like for any other
// write (the Vite host replays a change its watcher dropped, vite-plugin-ast-locator/src/watch.ts),
// and filesWritten is optional (the Next.js host has none): the service needs nothing more.
it('edits, undoes and redoes through a host that is not told of the writes, and reports the files each wrote', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'trivia-host-'))
  fs.mkdirSync(path.join(root, 'src/components/ui'), { recursive: true })
  const file = path.join(root, 'src/App.tsx')
  const original = 'export function App() {\n  return <div title="a" />\n}\n'
  fs.writeFileSync(file, original)
  const host: DevHost = {
    root, kind: 'vite', uiDir: 'src/components/ui', importBase: '@/components/ui', allowedHosts: [],
    resolveModule: async () => null, readRoutes: async () => [], preview: { publish: () => '/preview' },
  }
  const service = new EngineService({ host, engine: await loadEngine(), version: 'test' })
  const edit = (value: string) => ({ op: 'updateProp', target: 'src/App.tsx#App#0', expectedName: 'div', prop: 'title', value })
  const edited = original.replace('title="a"', 'title="b"')

  expect(await service.apply(edit('b'), 'edit')).toMatchObject({ file: 'src/App.tsx', changed: true })
  expect(fs.readFileSync(file, 'utf8')).toBe(edited)
  expect(await service.undo()).toMatchObject({ files: ['src/App.tsx'], history: { canUndo: false, redoLabel: 'edit' } })
  expect(fs.readFileSync(file, 'utf8')).toBe(original)
  expect(await service.redo()).toMatchObject({ files: ['src/App.tsx'], history: { undoLabel: 'edit', canRedo: false } })
  expect(fs.readFileSync(file, 'utf8')).toBe(edited)

  expect(await service.apply(edit('b'), 'no-op')).toMatchObject({ changed: false })
  await expect(service.apply({ ...edit('c'), expectedName: 'span' }, 'refused')).rejects.toThrow()
  expect(fs.readFileSync(file, 'utf8')).toBe(edited)
  fs.rmSync(root, { recursive: true, force: true })
})

// A dev server that caches transformed modules would answer a request made right after the
// write (the eject dialog navigates the canvas then) with the module from before it, while its
// watcher has not reported the write yet. So the service names what it wrote, once it is on disk
// and before the call is answered; the host only drops its cache, and its watcher sends the update.
it('names the files each write put on disk before answering, after the previews, and nothing for a no-op or a refusal', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'trivia-host-'))
  fs.mkdirSync(path.join(root, 'src/components/ui'), { recursive: true })
  const file = path.join(root, 'src/App.tsx')
  fs.writeFileSync(file, 'export function App() {\n  return <div title="a" />\n}\n')
  const events: string[] = []
  const title = () => /title="(\w)"/.exec(fs.readFileSync(file, 'utf8'))?.[1]
  const host: DevHost = {
    root, kind: 'vite', uiDir: 'src/components/ui', importBase: '@/components/ui', allowedHosts: [],
    resolveModule: async () => null, readRoutes: async () => [],
    preview: { publish: () => '/preview', invalidateBlueprints: () => events.push('previews') },
    filesWritten: (files) => events.push(`written ${files.join(',')}${files.includes('src/App.tsx') ? ` title=${title()}` : ''}`),
  }
  const service = new EngineService({ host, engine: await loadEngine(), version: 'test' })
  const edit = (value: string) => ({ op: 'updateProp', target: 'src/App.tsx#App#0', expectedName: 'div', prop: 'title', value })
  const answered = (call: string) => () => { events.push(`answered ${call}`) }

  await service.apply(edit('b'), 'edit').then(answered('edit'))
  await service.batch([edit('c')], 'batch').then(answered('batch'))
  await service.undo().then(answered('undo'))
  await service.redo().then(answered('redo'))
  await service.apply(edit('c'), 'no-op').then(answered('no-op'))
  await service.apply({ ...edit('d'), expectedName: 'span' }, 'refused').catch(answered('refused'))
  await service.writeDocuments([{ file: 'pages/Draft.page.json', before: null, after: '{}\n' }], 'document').then(answered('document'))
  await service.undo().then(answered('document undo'))
  await service.redo().then(answered('document redo'))
  expect(events).toEqual([
    'written src/App.tsx title=b', 'answered edit',
    'written src/App.tsx title=c', 'answered batch',
    'written src/App.tsx title=b', 'answered undo',
    'written src/App.tsx title=c', 'answered redo',
    'answered no-op',
    'answered refused',
    // A document write is no engine write; its undo and redo are, after the previews.
    'previews', 'answered document',
    'previews', 'written blueprint/pages/Draft.page.json', 'answered document undo',
    'previews', 'written blueprint/pages/Draft.page.json', 'answered document redo',
  ])
  fs.rmSync(root, { recursive: true, force: true })
})
