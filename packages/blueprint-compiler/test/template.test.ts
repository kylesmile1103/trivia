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
