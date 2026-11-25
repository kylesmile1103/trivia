// Shared setup for the scripted and browser acceptance tests.
import { execFile, spawn, spawnSync } from 'node:child_process'
import { cpSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

export const repo = path.resolve(import.meta.dirname, '../..')
const kit = path.join(repo, 'examples/blueprint-kit')
const cli = path.join(repo, 'packages/blueprint-compiler/bin/trivia-blueprint.js')

export function missingMvpPrerequisite() {
  const sdk = spawnSync('dotnet', ['--list-sdks'], { encoding: 'utf8', timeout: 10_000 })
  if (sdk.status !== 0 || !/^10\./m.test(sdk.stdout)) return 'The MVP slice needs the .NET 10 SDK.'
  const runtime = process.env.DCP_CONTAINER_RUNTIME || 'docker'
  if (spawnSync(runtime, ['info'], { stdio: 'ignore', timeout: 10_000 }).status !== 0) {
    return `The MVP slice needs a running container runtime (${runtime} info failed).`
  }
  return undefined
}

const execute = promisify(execFile)

export async function run(cwd, command, args) {
  try {
    const { stdout } = await execute(command, args, {
      cwd,
      env: {
        ...process.env,
        PATH: [path.join(repo, 'e2e/bin'), process.env.PATH ?? ''].join(path.delimiter),
        DOTNET_CLI_TELEMETRY_OPTOUT: '1',
        DOTNET_NOLOGO: '1',
      },
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 300_000,
    })
    return stdout
  } catch (error) {
    throw new Error(error.message + '\n' + (error.stdout ?? ''), { cause: error })
  }
}

export function blueprint(root, ...args) {
  return run(root, process.execPath, [cli, ...args])
}

export async function prepareMvp(directory) {
  const root = realpathSync(directory)
  await blueprint(repo, 'new', root, '--api', 'dotnet-minimal')
  const web = path.join(root, 'web')
  cpSync(path.join(repo, 'examples/blueprint-mvp/blueprint'), path.join(web, 'blueprint'), { recursive: true })
  for (const item of ['components', 'hooks', 'lib', 'index.css']) {
    cpSync(path.join(kit, 'src', item), path.join(web, 'src', item), { recursive: true })
  }
  const packagePath = path.join(web, 'package.json')
  const manifest = JSON.parse(readFileSync(packagePath, 'utf8'))
  const { dependencies } = JSON.parse(readFileSync(path.join(kit, 'package.json'), 'utf8'))
  manifest.dependencies = { ...dependencies, ...manifest.dependencies }
  writeFileSync(packagePath, JSON.stringify(manifest, null, 2) + '\n')
  await run(web, 'pnpm', ['install', '--prefer-offline'])
  return web
}


export async function startMvpApi(root) {
  const project = 'Trivia.Blueprint.Mvp.Host'
  const harness = path.join(repo, 'dotnet/tests', project, project + '.csproj')
  const artifacts = path.join(root, '.mvp-host')
  await run(root, 'dotnet', ['build', harness, '--artifacts-path', artifacts, '--disable-build-servers'])
  const dll = path.join(artifacts, 'bin', project, 'debug', project + '.dll')
  const appHost = path.join('src/BankAdmin.AppHost/bin/Debug/net10.0/BankAdmin.AppHost.dll')
  const child = spawn('dotnet', [dll, appHost], {
    cwd: root, stdio: 'pipe',
    env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' },
  })
  let output = ''
  const closed = new Promise((resolve) => child.once('close', resolve))
  child.stderr.setEncoding('utf8').on('data', (text) => { output += text })
  child.stdin.on('error', () => {}) // The host can exit before shutdown is requested.
  const lines = createInterface({ input: child.stdout })
  const endpoint = new Promise((resolve, reject) => {
    child.once('error', reject)
    lines.on('line', (line) => {
      const prefix = 'TRIVIA_MVP_API='
      if (line.startsWith(prefix)) resolve(line.slice(prefix.length))
      else output += line + '\n'
    })
  })
  async function close() {
    child.stdin.end()
    if (await Promise.race([closed.then(() => true), delay(20_000, false, { ref: false })])) return
    child.kill('SIGKILL')
    await closed
    throw new Error('MVP Aspire host did not shut down after stdin closed.\n' + output)
  }
  try {
    const url = await Promise.race([
      endpoint,
      closed.then((status) => { throw new Error(`MVP Aspire host exited (${status}).\n${output}`) }),
      delay(200_000, undefined, { ref: false }).then(() => { throw new Error('MVP Aspire host did not become ready.\n' + output) }),
    ])
    return { url, close }
  } catch (error) {
    await close().catch(() => {})
    throw error
  }
}

export async function startMvpDevService(web) {
  const { createStandaloneHost, startDevService } = await import('../../packages/dev-service/dist/index.js')
  return startDevService(createStandaloneHost(web))
}

export async function triviaRequest(origin, endpoint, data) {
  const response = await fetch(origin + '/@trivia/api' + endpoint, {
    signal: AbortSignal.timeout(30_000),
    ...(data !== undefined && {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
    }),
  })
  const result = await response.json()
  if (!response.ok || !result.ok) throw new Error(endpoint + ' failed: ' + JSON.stringify(result))
  return result.data
}

export async function applyRefineChange(origin, tool, file, changes) {
  const { ops, label } = await triviaRequest(origin, '/refine/' + tool + '/plan', { file, changes })
  return triviaRequest(origin, '/batch', { ops, label })
}

export async function reviseCustomerModel(origin) {
  const doc = 'model.blueprint.json'
  const entity = 'Customer'
  const { rev: baseRev } = await triviaRequest(origin, '/blueprint/doc?path=' + doc)
  const { revs } = await triviaRequest(origin, '/blueprint/patch', {
    label: 'Define customer segments and remove notes',
    ops: [
      { op: 'setEnum', doc, baseRev, enum: { name: 'CustomerSegment', values: ['retail', 'business'] } },
      { op: 'removeField', doc, baseRev, entity, field: 'notes' },
    ],
  })
  await triviaRequest(origin, '/blueprint/patch', {
    label: 'Add customer segment',
    ops: [{
      op: 'setField', doc, baseRev: revs[doc], entity,
      field: { name: 'segment', type: 'enum', enum: 'CustomerSegment' },
    }],
  })
}
