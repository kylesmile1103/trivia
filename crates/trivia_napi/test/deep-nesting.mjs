// Deeply nested user files must come back from the binding as a result or an error, never
// kill Node. OXC's parser recurses once per nesting level, and the JS main thread's stack
// (8 MiB, shared with V8) used to overflow at about 18 000 nested elements or 5 000 nested
// brackets: the dev server died with SIGSEGV, losing its undo history.
//
// Each case calls one binding function in its own child process, so a crash shows up here
// as that child's signal instead of taking this script down with it.
//
//   pnpm build:engine && node crates/trivia_napi/test/deep-nesting.mjs

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const FILE = 'src/App.tsx'

/** A component whose JSX holds `depth` levels of one construct. */
function deepSource(construct, depth) {
  const inner =
    construct === 'elements'
      ? '<a>'.repeat(depth) + '</a>'.repeat(depth)
      : `{${'('.repeat(depth)}1${')'.repeat(depth)}}`
  return `export function App() {\n  return <div>${inner}</div>\n}\n`
}

/** Child: run `fn` on a deep file in a fresh project and print a one-line summary. */
async function child(fn, construct, depth) {
  const engine = await import(path.join(here, '..', 'index.js'))
  const src = deepSource(construct, depth)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trivia-deep-'))
  try {
    fs.mkdirSync(path.join(root, 'src/components/ui'), { recursive: true })
    fs.writeFileSync(path.join(root, FILE), src)
    const update = { op: 'updateProp', target: `${FILE}#App#0`, expectedName: 'div', prop: 'title', value: 'deep' }
    const envelope = (json) => {
      const e = JSON.parse(json)
      return e.ok ? `ok ${JSON.stringify(e.data).length} bytes of data` : `error ${e.error.code}: ${e.error.message.slice(0, 80)}`
    }
    switch (fn) {
      case 'annotate':
        return `${engine.annotate(src, FILE).length} insertions`
      case 'inspect':
        return envelope(engine.inspect(root, `${FILE}#App#0`))
      case 'applyOp':
        return envelope(engine.applyOp(root, JSON.stringify(update)))
      case 'applyOps':
        return envelope(engine.applyOps(root, JSON.stringify([update])))
      case 'components':
        fs.writeFileSync(path.join(root, 'src/components/ui/deep.tsx'), src)
        return envelope(engine.components(root, 'src/components/ui', '@/components/ui'))
      case 'restore':
        return envelope(engine.restore(root, FILE, src, `${src}\n`))
      case 'restoreFiles':
        return envelope(engine.restoreFiles(root, JSON.stringify([{ file: FILE, expected: src, content: `${src}\n` }])))
      default:
        throw new Error(`unknown binding function ${fn}`)
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

if (process.argv[2] === '--child') {
  const [fn, construct, depth] = process.argv.slice(3)
  console.log(await child(fn, construct, Number(depth)))
  process.exit(0)
}

if (!fs.existsSync(path.join(here, '..', 'index.js'))) {
  console.error('crates/trivia_napi/index.js is missing: build the addon first with `pnpm build:engine`')
  process.exit(1)
}

// Past the old crash points (5 000 brackets, 18 000 elements), well inside the engine
// thread's stack. Elements stay near that point: every element's locator is as long as its
// depth, so their cost grows with the square of the depth.
const cases = [
  ...['annotate', 'inspect', 'applyOp', 'applyOps', 'components', 'restore', 'restoreFiles'].map((fn) => [
    fn,
    'brackets',
    15_000,
  ]),
  ['annotate', 'elements', 24_000],
  ['applyOps', 'elements', 24_000],
]

let failed = 0
for (const [fn, construct, depth] of cases) {
  const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', fn, construct, String(depth)], {
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  })
  const label = `${fn}(${depth} nested ${construct})`.padEnd(40)
  const ok = run.status === 0 && run.signal === null && !run.stdout.startsWith('error')
  if (!ok) failed += 1
  const outcome =
    run.signal !== null
      ? `KILLED by ${run.signal}`
      : run.status !== 0
        ? `exit ${run.status}: ${(run.stderr.trim().split('\n').at(-1) ?? '').slice(0, 120)}`
        : run.stdout.trim()
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} ${outcome}`)
}
console.log(failed === 0 ? `\nall ${cases.length} cases survived` : `\n${failed} of ${cases.length} cases failed`)
process.exit(failed === 0 ? 0 : 1)
