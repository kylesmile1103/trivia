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
  expect(read('vite.config.ts.template')).toContain('plugins: [astLocator() as Plugin, react(), tailwindcss()]')
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

it('FR-NX-04 rewrites the same-origin API under Aspire and builds standalone output', () => {
  const template = new URL('../templates/next-refine/', import.meta.url)
  const config = readFileSync(new URL('next.config.ts.template', template), 'utf8')
  expect(config).toContain('const origin = apiOrigin()')
  expect(config).toContain("source: '/api/:path*'")
  expect(config).toContain("destination: origin + '/api/:path*'")
  expect(config).toContain("output: 'standalone'")
  expect(existsSync(new URL('public/', template))).toBe(true)
})

it('documents the verified generated Next workflow and production gate', () => {
  const readme = readFileSync(new URL('../../../docs/blueprint/README.md', import.meta.url), 'utf8')
  const next = readme.split('## Run a generated .NET and Next.js app')[1]?.split('\n## ')[0]
  expect(next).toContain('trivia-blueprint new backoffice --target next-refine --api dotnet-minimal')
  expect(next).toContain('trivia-blueprint backend --migration Initial')
  expect(next).toContain('trivia-blueprint eject')
  expect(next).toContain('aspire run')
  expect(next).toContain('TRIVIA_NEXT_BUILD=1 pnpm exec nx test blueprint-compiler')
})

it('FR-MVP-02: the generated app mounts a Refine notification provider and its toaster', () => {
  const root = new URL('../templates/vite-refine/', import.meta.url)
  const app = readFileSync(new URL('src/App.tsx', root), 'utf8')
  const manifest = JSON.parse(readFileSync(new URL('package.json.template', root), 'utf8'))
  expect(manifest.dependencies.sonner).toBe('2.0.8')
  expect(app).toContain('notificationProvider={notificationProvider}')
  expect(app).toContain('<Toaster richColors />')
})
