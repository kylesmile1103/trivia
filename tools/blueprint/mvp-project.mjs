// Shared setup for the scripted and browser acceptance tests.
import { spawnSync } from 'node:child_process'
import { cpSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'

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
