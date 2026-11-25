import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { expect, it } from 'vitest'

it('ships a Vite Refine shell with eject anchors and registry aliases', () => {
  const root = path.resolve(import.meta.dirname, '../templates/vite-refine')
  const read = (file: string) => readFileSync(path.join(root, file), 'utf8')
  const app = read('src/App.tsx')
  expect(app).toContain('resources={[]}')
  expect(app).toContain('<Route path="*"')
  expect(app).toContain('<Layout>')
  expect(app).toContain('<style id="trivia-theme" />')
  expect(read('vite.config.ts.template')).toContain('plugins: [astLocator(), react(), tailwindcss()]')
  expect(JSON.parse(read('components.json')).aliases.ui).toBe('@/components/ui')
  expect(JSON.parse(read('tsconfig.json')).compilerOptions.paths['@/*']).toEqual(['./src/*'])
  expect(existsSync(path.join(root, 'src/components'))).toBe(false)
  expect(JSON.parse(read('../../package.json')).files).toContain('templates')
})

it('documents the commands to create, generate, eject and run an Aspire solution', () => {
  const readme = readFileSync(new URL('../../../docs/blueprint/README.md', import.meta.url), 'utf8')
  const gettingStarted = readme.split('## Run a generated .NET and Vite app')[1]?.split('\n## ')[0]
  const commands = gettingStarted?.match(/```sh\n([\s\S]*?)```/)?.[1]?.trim().split('\n').filter((line) => !line.startsWith('#'))
  expect(commands).toEqual([
    'trivia-blueprint new backoffice --api dotnet-minimal',
    'cd backoffice',
    'trivia-blueprint backend --migration Initial',
    'trivia-blueprint eject',
    'aspire run',
  ])
})

it('FR-NX-06 ships an App Router shell with the validated pins and the shared API provider', () => {
  const templates = new URL('../templates/', import.meta.url)
  const read = (file: string) => readFileSync(new URL('next-refine/' + file, templates), 'utf8')
  const example = JSON.parse(readFileSync(new URL('../../../examples/next-admin/package.json', import.meta.url), 'utf8'))
  const manifest = JSON.parse(read('package.json.template'))
  for (const name of ['next', 'react', 'react-dom', '@refinedev/core', '@refinedev/nextjs-router', '@refinedev/react-hook-form', '@tanstack/react-query']) {
    expect(manifest.dependencies[name]).toBe(example.dependencies[name])
  }
  expect(manifest.scripts).toMatchObject({ dev: 'trivia-next dev', build: 'next build', sync: expect.stringContaining('openapi/api.openapi.json') })
  expect(read('next.config.ts.template')).toContain('withTrivia(')
  expect(read('app/layout.tsx')).toContain('<Providers>')
  const providers = read('app/providers.tsx')
  expect(providers).toMatch(/^['"]use client['"]/)
  expect(providers).toContain('resources={[]}')
  expect(providers).toContain('notificationProvider=')
  expect(read('app/(app)/layout.tsx')).toContain('<Layout>')
  expect(read('app/error.tsx')).toMatch(/^['"]use client['"]/)
  expect(read('app/not-found.tsx')).toContain('Page not found')
  expect(JSON.parse(read('components.json'))).toMatchObject({ rsc: true, aliases: { ui: '@/components/ui' } })
  expect(read('src/providers/data-provider.ts')).toBe(readFileSync(new URL('vite-refine/src/providers/data-provider.ts', templates), 'utf8'))
})
