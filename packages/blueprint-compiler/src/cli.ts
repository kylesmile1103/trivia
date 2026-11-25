import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

import { APP_DOC, appSchema, BLUEPRINT_VERSION, hasErrors, loadDocument, SCHEMA_URL, serialize, validate, type Blueprint } from '@trivia/blueprint'

import { compilePage, type CompileContext } from './compile.js'

const usage = `Usage: trivia-blueprint <command>
  new <dir> [--target vite-refine] [--api dotnet-minimal]
  validate [--json]
  compile <Page> [--out file]
  eject [pages…] [--dry-run]
  backend [--migration <Name>]`

const options = {
  new: { target: { type: 'string' }, api: { type: 'string' } },
  validate: { json: { type: 'boolean' } },
  compile: { out: { type: 'string' } },
  eject: { 'dry-run': { type: 'boolean' } },
  backend: { migration: { type: 'string' } },
} as const

const contractSync = '@trivia/contract-sync'
const plugin = '@trivia/vite-plugin-ast-locator'
const service = '@trivia/dev-service'

interface Project {
  blueprintInputs(): Promise<{ blueprint: Blueprint; context: CompileContext }>
  planBlueprintEject(pages?: string[]): Promise<unknown>
  ejectBlueprint(pages?: string[]): Promise<unknown>
  refine: {
    drift(): Promise<{ pages: Array<{ file: string; issues: Array<{ message: string }> }> }>
  }
}

function resolveManifest(root: string, name: string): string | undefined {
  try {
    return createRequire(path.join(root, 'package.json')).resolve(name + '/package.json')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error
    return undefined
  }
}

function checkoutManifest(shortName: string): string | undefined {
  const file = fileURLToPath(new URL('../../' + shortName + '/package.json', import.meta.url))
  return fs.existsSync(file) ? file : undefined
}

async function openProject(root: string): Promise<Project> {
  const installedPlugin = resolveManifest(root, plugin)
  const manifest = resolveManifest(root, service)
    ?? (installedPlugin && resolveManifest(path.dirname(installedPlugin), service))
    ?? checkoutManifest('dev-service')
  if (!manifest) throw new Error('Install the Trivia Vite plugin in this project to load its code generation adapter.')
  const { main, version } = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { main: string; version: string }
  const entry = pathToFileURL(path.resolve(path.dirname(manifest), main)).href
  const { EngineService, createStandaloneHost, loadEngine } = await import(entry)
  return new EngineService({ host: createStandaloneHost(root), engine: await loadEngine(), version }) as Project
}

function createProject(root: string, dest: string, version: string, dotnet: boolean): void {
  const destination = path.resolve(root, dest)
  const stat = fs.lstatSync(destination, { throwIfNoEntry: false })
  if (stat && (!stat.isDirectory() || fs.readdirSync(destination).length > 0)) throw new Error(destination + ' must be an empty directory.')
  const dir = dotnet ? path.join(destination, 'web') : destination
  const template = fileURLToPath(new URL('../templates/vite-refine/', import.meta.url))
  const manifest = JSON.parse(fs.readFileSync(path.join(template, 'package.json.template'), 'utf8'))
  const localPlugin = resolveManifest(root, plugin) ?? checkoutManifest('vite-plugin-ast-locator')
  manifest.devDependencies[plugin] = localPlugin ? 'link:' + path.dirname(localPlugin) : version
  const localSync = resolveManifest(root, contractSync) ?? checkoutManifest('contract-sync')
  manifest.devDependencies[contractSync] = localSync ? 'link:' + path.dirname(localSync) : version
  const candidate = path.basename(destination).replace(/(?:^|[^A-Za-z0-9]+)([A-Za-z0-9])/g, (_, char: string) => char.toUpperCase())
  const fields = {
    $schema: SCHEMA_URL.app, blueprintVersion: BLUEPRINT_VERSION, name: candidate,
    targets: { web: 'vite-refine', ...(dotnet && { api: 'dotnet-minimal' }) },
  }
  const named = appSchema.safeParse(fields)
  const app = named.success ? named.data : appSchema.parse({ ...fields, name: 'TriviaApp' })

  fs.cpSync(template, dir, { recursive: true, force: false, errorOnExist: true, filter: (file) => !file.endsWith('.template') })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
  fs.copyFileSync(path.join(template, 'vite.config.ts.template'), path.join(dir, 'vite.config.ts'), fs.constants.COPYFILE_EXCL)
  fs.mkdirSync(path.join(dir, 'blueprint'))
  fs.writeFileSync(path.join(dir, 'blueprint', APP_DOC), serialize(app), { flag: 'wx' })
  console.log(`Created ${destination}`)
  if (!localPlugin) console.log('Point the Trivia Vite plugin and contract-sync dependencies at your Trivia distribution before installing.')
  console.log(`Run in ${dir}\n  pnpm install\n  pnpm exec shadcn add https://ui.refine.dev/r/layout-01.json https://ui.refine.dev/r/views.json`)
}

interface Command {
  executable: string
  prefix?: string[]
}

type BackendCommands = Record<'trivia-dotnet' | 'dotnet' | 'pnpm', Command>

const backendCommands: BackendCommands = {
  'trivia-dotnet': { executable: 'trivia-dotnet' },
  dotnet: { executable: 'dotnet' },
  pnpm: process.platform === 'win32' && process.env.npm_execpath?.endsWith('.cjs')
    ? { executable: process.execPath, prefix: [process.env.npm_execpath] } : { executable: 'pnpm' },
}

function step(label: string, { executable, prefix = [] }: Command, args: string[], cwd: string): string {
  const { status, stdout, stderr, error, signal } = spawnSync(executable, [...prefix, ...args], {
    cwd, shell: false, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 300_000,
    env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' },
  })
  if (status !== 0 || error) {
    const reason = error?.message ?? (signal ? 'signal ' + signal : 'exit ' + status)
    const output = [stdout?.trimEnd(), stderr?.trimEnd()].filter(Boolean).join('\n')
    throw new Error(`${label} failed (${reason})${output ? '\n' + output : ''}`)
  }
  if (stderr) process.stderr.write(stderr)
  return stdout
}

function webProject(directory: string): string {
  const nested = path.join(directory, 'web')
  return !fs.existsSync(path.join(directory, 'blueprint', APP_DOC)) &&
    fs.existsSync(path.join(nested, 'blueprint', APP_DOC)) ? nested : directory
}

async function backend(web: string, migration: string | undefined, commands: BackendCommands): Promise<void> {
  web = fs.realpathSync(web)
  const blueprint = path.join(web, 'blueprint')
  const entry = loadDocument(APP_DOC, fs.readFileSync(path.join(blueprint, APP_DOC), 'utf8'))
  if (entry.kind !== 'app' || !entry.doc || entry.doc.targets.api !== 'dotnet-minimal' || path.basename(web) !== 'web') {
    throw new Error('Use a .NET solution created by trivia-blueprint new <dir> --api dotnet-minimal.')
  }
  const solution = path.dirname(web)
  const args = ['--blueprint', blueprint, '--root', solution]
  step('Generate the backend', commands['trivia-dotnet'], ['write', ...args], solution)
  if (migration !== undefined) {
    step('Add the migration', commands['trivia-dotnet'], ['migrate', migration, ...args], solution)
  }
  const build = step('Build the solution', commands.dotnet, ['build', entry.doc.name + '.slnx', '--disable-build-servers'], solution)
  if (build) process.stdout.write(build)
  const sync = step('Sync the API contract', commands.pnpm, ['run', 'sync'], web)
  if (sync) process.stdout.write(sync)

  const { pages } = await (await openProject(web)).refine.drift()
  if (!pages.length) console.log('No contract drift.')
  else {
    console.log(`Contract drift affects ${pages.length} page(s).`)
    for (const { file, issues } of pages) {
      for (const { message } of issues) console.log(`  ${file}  ${message}`)
    }
  }
}

export async function run(argv: string[], version: string, commands = backendCommands): Promise<number> {
  const [command, ...args] = argv
  let values: Record<string, unknown>
  let positionals: string[]
  try {
    if (!command || !Object.hasOwn(options, command)) throw new Error('Choose a command.')
    const parsed = parseArgs({ args, allowPositionals: true, options: options[command as keyof typeof options] })
    values = parsed.values
    positionals = parsed.positionals
    if ((command === 'validate' || command === 'backend') && positionals.length) throw new Error(command + ' takes no positional arguments.')
    if ((command === 'new' || command === 'compile') && (positionals.length !== 1 || !positionals[0])) throw new Error('Provide exactly one directory or page name.')
    if (values.target !== undefined && values.target !== 'vite-refine') throw new Error('The supported target is vite-refine.')
    if (values.api !== undefined && values.api !== 'dotnet-minimal') throw new Error('The supported API target is dotnet-minimal.')
    if (typeof values.migration === 'string' && !values.migration.trim()) throw new Error('Provide a migration name.')
    if (values.out === '') throw new Error('Provide an output filename.')
  } catch (error) {
    console.error((error as Error).message + '\n' + usage)
    return 2
  }

  const root = process.cwd()
  try {
    if (command === 'new') {
      createProject(root, positionals[0]!, version, values.api === 'dotnet-minimal')
      return 0
    }
    const web = webProject(root)
    if (command === 'backend') {
      await backend(web, typeof values.migration === 'string' ? values.migration : undefined, commands)
      return 0
    }
    const project = await openProject(web)
    if (command === 'eject') {
      const pages = positionals.length ? positionals : undefined
      const result = values['dry-run'] ? await project.planBlueprintEject(pages) : await project.ejectBlueprint(pages)
      console.log(JSON.stringify(result, null, 2))
      return 0
    }
    const { blueprint, context } = await project.blueprintInputs()
    if (command === 'validate') {
      const diagnostics = validate(blueprint, context.validation)
      if (values.json) console.log(JSON.stringify(diagnostics, null, 2))
      else for (const finding of diagnostics) console.log(`${finding.severity} ${finding.doc}${finding.pointer}: ${finding.message}`)
      return hasErrors(diagnostics) ? 1 : 0
    }
    const { code } = compilePage(blueprint, positionals[0]!, context)
    if (typeof values.out === 'string') fs.writeFileSync(path.resolve(root, values.out), code)
    else process.stdout.write(code)
    return 0
  } catch (error) {
    const { code, message, details } = error as Error & { code?: string; details?: unknown }
    console.error((code ? code + ': ' : '') + message)
    if (details) console.error(JSON.stringify(details, null, 2))
    if (command === 'eject' && (details as { diagnostics?: { code: string }[] } | undefined)?.diagnostics
      ?.some(({ code }) => code === 'unknown_resource')) {
      console.error('Generate the backend and sync the contract with trivia-blueprint backend, then eject again.')
    }
    return 1
  }
}
