// Adopt: the recipe in docs/getting-started.md ("Using Trivia in your own Vite app"), run on an
// app outside this workspace. The app is a copy of examples/refine-admin without its
// node_modules, its contract-sync output and its links to Trivia; it installs its own
// dependencies from the registry, then follows the recipe step by step. Not part of
// `pnpm check` (it installs from the network): `nx run tools:adopt`, in CI's e2e job.

import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

const repo = path.resolve(import.meta.dirname, '../..')
const example = path.join(repo, 'examples/refine-admin')
const linked = (name) => path.join(repo, 'packages', name)
const appPort = Number(process.env.TRIVIA_ADOPT_APP_PORT ?? 5741)
const designerPort = Number(process.env.TRIVIA_ADOPT_PORT ?? 4741)
const LIST = 'src/pages/customers/list.tsx'

const execute = promisify(execFile)
async function run(cwd, command, args) {
  try {
    const { stdout } = await execute(command, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 300_000 })
    return stdout
  } catch (error) {
    throw new Error(`${command} ${args.join(' ')} failed in ${cwd}\n${error.stdout ?? ''}${error.stderr ?? ''}`, { cause: error })
  }
}

/** Start a long-running command; `close` stops it and its children. */
function start(cwd, command, args, env = {}) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', (text) => { output += text })
  child.stderr.setEncoding('utf8').on('data', (text) => { output += text })
  const exited = new Promise((resolve) => child.once('exit', resolve))
  return {
    output: () => output,
    exited,
    async close() {
      try { process.kill(-child.pid, 'SIGTERM') } catch { return }
      if (await Promise.race([exited.then(() => true), delay(10_000, false)])) return
      try { process.kill(-child.pid, 'SIGKILL') } catch {}
    },
  }
}

/** Wait until `url` answers 200, or fail with what the server printed. */
async function ready(url, server, what) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const status = await fetch(url, { signal: AbortSignal.timeout(5_000) }).then((r) => r.status, () => 0)
    if (status === 200) return
    if (await Promise.race([server.exited.then(() => true), delay(500, false)])) break
  }
  throw new Error(`${what} did not answer at ${url}\n${server.output()}`)
}

async function api(origin, endpoint, body) {
  const response = await fetch(origin + '/@trivia/api' + endpoint, {
    signal: AbortSignal.timeout(30_000),
    ...(body !== undefined && { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const result = await response.json()
  assert.ok(response.ok && result.ok, `${endpoint}: ${JSON.stringify(result)}`)
  return result.data
}

test('adopt: Trivia in an existing Vite + Refine app outside the workspace, by the getting-started recipe', { timeout: 900_000 }, async (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'trivia-adopt-')))
  const app = path.join(root, 'app')
  const servers = []
  t.after(async () => {
    await Promise.all(servers.map((server) => server.close()))
    rmSync(root, { recursive: true, force: true })
  })

  // The app as its owner has it: tracked files only, no contract-sync output, no Trivia packages.
  const files = execFileSync('git', ['ls-files'], { cwd: example, encoding: 'utf8' }).split('\n').filter(Boolean)
  for (const file of files) {
    if (file === 'trivia.manifest.json' || file.startsWith('src/api/generated/')) continue
    mkdirSync(path.dirname(path.join(app, file)), { recursive: true })
    copyFileSync(path.join(example, file), path.join(app, file))
  }
  const manifest = JSON.parse(readFileSync(path.join(app, 'package.json'), 'utf8'))
  for (const deps of [manifest.dependencies, manifest.devDependencies]) {
    for (const [name, spec] of Object.entries(deps ?? {})) if (String(spec).startsWith('workspace:')) delete deps[name]
  }
  writeFileSync(path.join(app, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  await run(app, 'pnpm', ['install', '--prefer-offline'])

  // Step 2: link the plugin and contract-sync (the example also renders the inferencer).
  await run(app, 'pnpm', ['add', '-D', `link:${linked('vite-plugin-ast-locator')}`, `link:${linked('contract-sync')}`])
  await run(app, 'pnpm', ['add', `link:${linked('trivia-inferencer')}`])
  // Step 3: the plugin first in vite.config.ts (the copy has it as the recipe says).
  assert.match(readFileSync(path.join(app, 'vite.config.ts'), 'utf8'), /plugins: \[astLocator\(\), react\(\)/)
  // Step 4: the contract, then the app still type-checks with the generated client in it.
  await run(app, 'pnpm', ['exec', 'trivia-contract-sync', '--input', 'openapi/bank.openapi.json', '--output', 'src/api/generated', '--zod'])
  await run(app, 'pnpm', ['exec', 'tsc', '-b', '--noEmit'])

  // Step 5: the app's own dev server, with the plugin.
  const appServer = start(app, 'pnpm', ['exec', 'vite', '--port', String(appPort), '--strictPort'])
  servers.push(appServer)
  const origin = `http://localhost:${appPort}`
  await ready(origin + '/@trivia/api/health', appServer, 'the app')
  assert.equal((await api(origin, '/health')).root, app)
  const served = await fetch(`${origin}/${LIST}`).then((r) => r.text())
  assert.match(served, /"data-ast-node": "src\/pages\/customers\/list\.tsx#CustomerList#0"/)
  const pages = await api(origin, '/refine/pages')
  assert.ok(pages.some((page) => page.file === LIST && page.kind === 'list' && page.contract?.resource === 'Customer'), JSON.stringify(pages))

  // An edit through the API: only the planned lines change, and undo restores every byte.
  const before = readFileSync(path.join(app, LIST), 'utf8')
  const plan = await api(origin, '/refine/columns/plan', { file: LIST, changes: [{ action: 'remove', column: 'email' }] })
  assert.equal((await api(origin, '/batch', { ops: plan.ops, label: plan.label })).changed, true)
  const after = readFileSync(path.join(app, LIST), 'utf8')
  const [was, now] = [before.split('\n'), after.split('\n')]
  let at = 0
  for (const line of now) at = was.indexOf(line, at) + 1 || assert.fail(`a line the plan did not write: ${line}`)
  const removed = was.filter((line) => !now.includes(line))
  assert.ok(removed.some((line) => line.includes('accessorKey: "email"')) && was.length - now.length <= 6, removed.join('\n'))
  await api(origin, '/undo', {})
  assert.equal(readFileSync(path.join(app, LIST), 'utf8'), before)

  // Step 6: the designer, from the Trivia workspace, on the app.
  const designer = start(repo, 'pnpm', ['--filter', '@trivia/designer', 'dev'], {
    TRIVIA_TARGET: origin, TRIVIA_PORT: String(designerPort), TRIVIA_CACHE_DIR: path.join(root, 'designer-cache'),
  })
  servers.push(designer)
  const designed = `http://localhost:${designerPort}`
  await ready(designed + '/__trivia/', designer, 'the designer')
  assert.match(await fetch(designed + '/__trivia/').then((r) => r.text()), /<title>Trivia<\/title>/)
  assert.match(await fetch(designed + '/').then((r) => r.text()), /<title>Bank back office<\/title>/)
  const { manifest: contract, drift } = await api(designed, '/manifest')
  assert.deepEqual(contract.resources.map((r) => r.name).sort(), ['Account', 'Customer', 'Transaction'])
  assert.equal(drift.status, 'current')
})
