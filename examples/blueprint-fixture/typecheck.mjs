import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const app = import.meta.dirname
const goldens = path.resolve(app, '../../packages/blueprint-compiler/fixtures/pages')
const workspace = mkdtempSync(path.join(os.tmpdir(), 'trivia-golden-tsc-'))

try {
  symlinkSync(path.join(app, 'node_modules'), path.join(workspace, 'node_modules'), 'junction')
  const inputs = [path.join(app, 'src', '**', '*')]
  for (const fixture of readdirSync(goldens, { withFileTypes: true })) {
    if (!fixture.isDirectory()) continue
    const source = path.join(goldens, fixture.name)
    for (const file of readdirSync(source)) {
      let target
      if (file.endsWith('.tsx')) {
        target = path.join(workspace, 'src/pages', path.basename(file, '.tsx'), file)
      } else if (file.endsWith('.handler.ts')) {
        target = path.join(workspace, 'src/handlers', file.replace(/\.handler\.ts$/, '.ts'))
      } else {
        continue
      }
      mkdirSync(path.dirname(target), { recursive: true })
      cpSync(path.join(source, file), target)
      inputs.push(target)
    }
  }
  writeFileSync(path.join(workspace, 'tsconfig.json'), JSON.stringify({
    extends: path.join(app, 'tsconfig.json'),
    include: inputs,
  }))
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc')
  execFileSync(process.execPath, [tsc, '-p', workspace, '--noEmit', ...process.argv.slice(2)], { stdio: 'inherit' })
} finally {
  rmSync(workspace, { recursive: true, force: true })
}
