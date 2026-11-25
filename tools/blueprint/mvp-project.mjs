// Shared setup for the scripted and browser acceptance tests.
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'

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

export function run(cwd, command, args) {
  const result = spawnSync(command, args, {
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
  if (result.status !== 0 || result.error) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.error?.message ?? result.signal ?? result.status})\n${result.stdout ?? ''}${result.stderr ?? ''}`)
  }
  return result.stdout
}

export function blueprint(root, ...args) {
  return run(root, process.execPath, [cli, ...args])
}

export function prepareMvp(directory) {
  const root = realpathSync(directory)
  blueprint(repo, 'new', root, '--api', 'dotnet-minimal')
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
  run(web, 'pnpm', ['install', '--prefer-offline'])
  return web
}


export async function startMvpApi(root) {
  const project = 'Trivia.Blueprint.Mvp.Host'
  const harness = path.join(repo, 'dotnet/tests', project, project + '.csproj')
  const artifacts = path.join(root, '.mvp-host')
  run(root, 'dotnet', ['build', harness, '--artifacts-path', artifacts, '--disable-build-servers'])
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
