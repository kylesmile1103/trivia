// Deeply nested user files and snippets must come back from the binding as a result or an
// error, never kill Node. OXC's parser recurses once per nesting level, and the JS main
// thread's stack (8 MiB, shared with V8) used to overflow at about 18 000 nested elements or
// 5 000 nested brackets: the dev server died with SIGSEGV, losing its undo history. A 64 MiB
// engine thread still died (SIGILL) on 100 000-deep ternary or arrow chains and 50 000
// nested brackets.
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

/** JSX children holding `depth` levels of one construct. */
const CONSTRUCTS = {
  elements: (depth) => '<a>'.repeat(depth) + '</a>'.repeat(depth),
  brackets: (depth) => `{${'('.repeat(depth)}1${')'.repeat(depth)}}`,
  arrays: (depth) => `{${'['.repeat(depth)}${']'.repeat(depth)}}`,
  objects: (depth) => `{${'{a:'.repeat(depth)}1${'}'.repeat(depth)}}`,
  // Chains with no tag or bracket per level (the round-1 review's payloads): a snippet
  // nesting check that counts `<([{` cannot see these.
  ternaries: (depth) => `{${'a ? b : '.repeat(depth)}c}`,
  arrows: (depth) => `{${'x => '.repeat(depth)}x}`,
  assignments: (depth) => `{${'x = '.repeat(depth)}1}`,
  news: (depth) => `{${'new '.repeat(depth)}X}`,
  powers: (depth) => `{${'x ** '.repeat(depth)}x}`,
  sums: (depth) => `{x${' + x'.repeat(depth)}}`,
  nullish: (depth) => `{${'x ?? '.repeat(depth)}y}`,
  nots: (depth) => `{${'!'.repeat(depth)}x}`,
  typeofs: (depth) => `{${'typeof '.repeat(depth)}x}`,
  casts: (depth) => `{x${' as T'.repeat(depth)}}`,
}

/** A component whose `<div>` holds `inner`. */
const component = (inner) => `export function App() {\n  return <div>${inner}</div>\n}\n`

/** Child: run `fn` on a deep file (or, for `insert`, a deep snippet) and print a one-line summary. */
async function child(fn, construct, depth) {
  const engine = await import(path.join(here, '..', 'index.js'))
  const deep = CONSTRUCTS[construct](depth)
  // `insert` sends the deep text as a snippet into a small file, as POST /apply would.
  const src = component(fn === 'insert' ? '' : deep)
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
        try {
          return `${engine.annotate(src, FILE).length} insertions`
        } catch (error) {
          return `error (thrown): ${String(error?.message ?? error).slice(0, 80)}`
        }
      case 'inspect':
        return envelope(engine.inspect(root, `${FILE}#App#0`))
      case 'outline':
        return envelope(engine.outline(root, FILE))
      case 'applyOp':
        return envelope(engine.applyOp(root, JSON.stringify(update)))
      case 'applyOps':
        return envelope(engine.applyOps(root, JSON.stringify([update])))
      case 'insert': {
        const insert = { op: 'insert', target: `${FILE}#App#0`, expectedName: 'div', placement: 'lastChild', snippet: deep, imports: [] }
        return envelope(engine.applyOps(root, JSON.stringify([insert])))
      }
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
  const summary = await child(fn, construct, Number(depth))
  // Peak RSS in MiB on the last line (`resourceUsage` reports KiB).
  console.log(`${summary}\n${Math.round(process.resourceUsage().maxRSS / 1024)}`)
  process.exit(0)
}

if (!fs.existsSync(path.join(here, '..', 'index.js'))) {
  console.error('crates/trivia_napi/index.js is missing: build the addon first with `pnpm build:engine`')
  process.exit(1)
}

// [function, construct, depth, outcome]. `result`: the file is valid, so the call must
// succeed. `either`: an error envelope is as good as a result; only a dead process fails.
// `refused`: the call must fail cleanly (an error envelope, or a throw for `annotate`).
const cases = [
  // Past the main thread's crash points (5 000 brackets, 18 000 elements).
  ...['annotate', 'inspect', 'outline', 'applyOp', 'applyOps', 'components', 'restore', 'restoreFiles'].map((fn) => [
    fn,
    'brackets',
    15_000,
    'result',
  ]),
  // Every element's locator is as long as its depth, so locators grow with the square of the
  // depth: 50 000 nested elements took more than 6 GB. The engine still parses these files
  // (past the main thread's crash point) but refuses them once their locators would pass
  // 2^22 segments, about 2 900 levels deep, so they cost no more than a shallow file.
  ['annotate', 'elements', 2_800, 'result'],
  ['outline', 'elements', 2_800, 'result'],
  ...['annotate', 'inspect', 'applyOps'].map((fn) => [fn, 'elements', 24_000, 'refused']),
  ...['annotate', 'inspect', 'outline', 'applyOps'].map((fn) => [fn, 'elements', 50_000, 'refused']),
  // The round-1 review's 1.4 MB snippet (POST /apply): it killed a 64 MiB engine thread
  // before the engine refused deep snippets.
  ['insert', 'elements', 200_000, 'either'],
  // User files past the 64 MiB thread's crash points (measured on darwin-arm64: brackets,
  // arrays and objects at 50 000; ternaries and arrows at 100 000; assignments and `new` at
  // 200 000) and about half of the 512 MiB thread's (brackets, arrays and objects at
  // 400 000; ternaries and arrows at 800 000).
  ...['brackets', 'arrays', 'objects'].map((construct) => ['annotate', construct, 100_000, 'result']),
  ...['ternaries', 'arrows', 'assignments', 'news'].map((construct) => ['annotate', construct, 200_000, 'result']),
  ['applyOps', 'ternaries', 200_000, 'result'],
  ['applyOps', 'arrows', 200_000, 'result'],
  // The rest of the review's chains at its 50 000 levels: cheap per level, but the review
  // crashed the main thread with them.
  ...['powers', 'sums', 'nullish', 'nots', 'typeofs', 'casts'].map((construct) => ['annotate', construct, 50_000, 'result']),
]

// Peak RSS a case may reach. The largest legitimate case (annotate of a 2 800-deep chain)
// peaks near 140 MiB on darwin-arm64; 24 000 nested elements took 2.8 GB before the limit.
const MAX_RSS_MIB = 512

let failed = 0
for (const [fn, construct, depth, outcome] of cases) {
  const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', fn, construct, String(depth)], {
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  })
  const label = `${fn}(${depth} nested ${construct})`.padEnd(40)
  const survived = run.status === 0 && run.signal === null
  const [result = '', rss = 'NaN'] = run.stdout.trim().split('\n')
  const failure = result.startsWith('error')
  const lean = Number(rss) <= MAX_RSS_MIB
  const ok =
    survived && lean && (outcome === 'either' || (outcome === 'refused' ? failure : !failure))
  if (!ok) failed += 1
  const summary =
    run.signal !== null
      ? `KILLED by ${run.signal}`
      : run.status !== 0
        ? `exit ${run.status}: ${(run.stderr.trim().split('\n').at(-1) ?? '').slice(0, 120)}`
        : `${result} (peak RSS ${rss} MiB${lean ? '' : `, over ${MAX_RSS_MIB}`})`
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} ${summary}`)
}
console.log(failed === 0 ? `\nall ${cases.length} cases survived` : `\n${failed} of ${cases.length} cases failed`)
process.exit(failed === 0 ? 0 : 1)
