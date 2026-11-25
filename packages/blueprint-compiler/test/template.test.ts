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
