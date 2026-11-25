import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const next = createRequire(import.meta.url).resolve('next/dist/bin/next')
const build = spawnSync(process.execPath, [next, 'build'], {
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
  stdio: 'inherit',
})
if (build.error) throw build.error
if (build.status !== 0) process.exit(build.status ?? 1)

const output = path.resolve('.next')
const markers = ['data-ast-node', '@trivia/']
assert(fs.existsSync(path.join(output, 'server')) && fs.existsSync(path.join(output, 'static')), 'Next production assets are missing')

function check(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (dir === output && (entry.name === 'dev' || entry.name === 'cache')) continue
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      check(file)
    } else if (entry.isFile()) {
      const bytes = fs.readFileSync(file)
      for (const marker of markers) {
        assert(!bytes.includes(marker), `${path.relative(output, file)} contains ${marker}`)
      }
    }
  }
}
check(output)
console.log('Production output contains no Trivia locators or runtime modules')
