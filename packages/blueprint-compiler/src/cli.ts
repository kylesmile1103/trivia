import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

import { APP_DOC, appSchema, BLUEPRINT_VERSION, hasErrors, loadDocument, SCHEMA_URL, serialize, validate, type Blueprint, type Diagnostic } from '@trivia/blueprint'

import { ASPIRE_MISSING, ASPIRE_NEXT_STEPS, checkAspireVersion } from './aspire.js'
import { compilePage, type CompileContext, type RegistryItem } from './compile.js'
import type { ProjectFacts } from './facts.js'
import { compareBytes } from './print/style.js'
import { checkedWebDirectory, DEFAULT_WEB_DIRECTORY, solutionFromWeb } from './solution.js'

const usage = `Usage: trivia-blueprint <command>
  new <dir> [--target vite-refine|next-refine] [--api dotnet-minimal] [--web-dir <dir>]
  validate [--json]
  compile <Page> [--out file]
  eject [pages…] [--dry-run]
  backend [--migration <Name>] [--web-dir <dir>]`

const options = {
  new: { target: { type: 'string' }, api: { type: 'string' }, 'web-dir': { type: 'string' } },
  validate: { json: { type: 'boolean' } },
  compile: { out: { type: 'string' } },
  eject: { 'dry-run': { type: 'boolean' } },
  backend: { migration: { type: 'string' }, 'web-dir': { type: 'string' } },
} as const

const contractSync = '@trivia/contract-sync'
const plugin = '@trivia/vite-plugin-ast-locator'
const next = '@trivia/next'
const service = '@trivia/dev-service'

/** What a successful `trivia-dotnet migrate` prints (LLD-09 §6). */
interface Migrated {
  migration: string
  modelRev?: string
  renames: Array<{ kind: string; entity: string; field?: string; from: string; oldName: string; newName: string }>
  settled: Array<{ entity: string; field?: string; from: string; outcome: string }>
}

interface Project {
  blueprintInputs(): Promise<{ blueprint: Blueprint; context: CompileContext }>
  planBlueprintEject(pages?: string[]): Promise<unknown>
  ejectBlueprint(pages?: string[]): Promise<unknown>
  recordGeneratedModel(modelRev: string): Promise<void>
  /** Clears the markers a migration settled; the model's new revision, or null when there were none. */
  clearRenameMarkers(migrated: Migrated): Promise<string | null>
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
  const appFile = path.join(root, 'blueprint', APP_DOC)
  const app = fs.existsSync(appFile) ? loadDocument(APP_DOC, fs.readFileSync(appFile, 'utf8')) : undefined
  const nextTarget = app?.kind === 'app' && app.doc?.targets.web === 'next-refine'
  const installedPlugin = resolveManifest(root, nextTarget ? next : plugin)
  const manifest = resolveManifest(root, service)
    ?? (installedPlugin && resolveManifest(path.dirname(installedPlugin), service))
    ?? checkoutManifest('dev-service')
  if (!manifest) throw new Error('Install the Trivia Vite plugin in this project to load its code generation adapter.')
  const { main, version } = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { main: string; version: string }
  const entry = pathToFileURL(path.resolve(path.dirname(manifest), main)).href
  const { EngineService, createStandaloneHost, loadEngine } = await import(entry)
  const engine = await loadEngine()
  if (!nextTarget) return new EngineService({ host: createStandaloneHost(root), engine, version }) as Project
  const nextManifest = installedPlugin ?? checkoutManifest('next')
  if (!nextManifest) throw new Error('Install @trivia/next to open this Next.js project.')
  const nextPackage = JSON.parse(fs.readFileSync(nextManifest, 'utf8')) as { main: string }
  const { createNextHost } = await import(pathToFileURL(path.resolve(path.dirname(nextManifest), nextPackage.main)).href)
  return new EngineService({ host: createNextHost(root, engine), engine, version }) as Project
}

const shellWord = (word: string) => /^[\w@./:+-]+$/.test(word) ? word : "'" + word.replaceAll("'", "'\\''") + "'"

/**
 * One install line for shadcn items and one for Refine UI's, deduplicated and byte-sorted.
 * The CLI prints them and never runs them: fetching components needs the network.
 */
export function registryCommands(items: readonly RegistryItem[]): string[] {
  const words = (registry: RegistryItem['registry'], word: (item: string) => string) =>
    [...new Set(items.filter((entry) => entry.registry === registry).map(({ item }) => item))].sort(compareBytes).map(word)
  return [words('shadcn', shellWord), words('refine', (item) => shellWord('https://ui.refine.dev/r/' + encodeURIComponent(item) + '.json'))]
    .filter((line) => line.length).map((line) => 'pnpm exec shadcn add ' + line.join(' '))
}

/** The registry items of the shipped kit manifests. */
function kitItems(): RegistryItem[] {
  const kit = fileURLToPath(new URL('../kit/', import.meta.url))
  return fs.readdirSync(kit).filter((file) => file.endsWith('.manifest.json')).map((file) => {
    const { source: { registry, item } } = JSON.parse(fs.readFileSync(path.join(kit, file), 'utf8')) as { source: RegistryItem }
    return { registry, item }
  })
}

/** The template's Refine UI layout and views, plus the whole kit, for either target (LLD-06 §7). */
const templateItems = (): RegistryItem[] => [
  { registry: 'refine', item: 'layout-01' }, { registry: 'refine', item: 'views' }, ...kitItems(),
]

function createProject(
  root: string, dest: string, version: string, target: ProjectFacts['target'], dotnet: boolean, webDirectory = DEFAULT_WEB_DIRECTORY,
): void {
  const destination = path.resolve(root, dest)
  const stat = fs.lstatSync(destination, { throwIfNoEntry: false })
  if (stat && (!stat.isDirectory() || fs.readdirSync(destination).length > 0)) throw new Error(destination + ' must be an empty directory.')
  const dir = dotnet ? path.join(destination, webDirectory) : destination
  const template = fileURLToPath(new URL('../templates/' + target + '/', import.meta.url))
  const manifest = JSON.parse(fs.readFileSync(path.join(template, 'package.json.template'), 'utf8'))
  if (dotnet) manifest.trivia = { solutionRoot: path.relative(dir, destination).split(path.sep).join('/') }
  const framework = target === 'next-refine' ? next : plugin
  const localPlugin = resolveManifest(root, framework) ?? checkoutManifest(framework.slice('@trivia/'.length))
  manifest.devDependencies[framework] = localPlugin ? 'link:' + path.dirname(localPlugin) : version
  const localSync = resolveManifest(root, contractSync) ?? checkoutManifest('contract-sync')
  manifest.devDependencies[contractSync] = localSync ? 'link:' + path.dirname(localSync) : version
  const candidate = path.basename(destination).replace(/(?:^|[^A-Za-z0-9]+)([A-Za-z0-9])/g, (_, char: string) => char.toUpperCase())
  const fields = {
    $schema: SCHEMA_URL.app, blueprintVersion: BLUEPRINT_VERSION, name: candidate,
    targets: { web: target, ...(dotnet && { api: 'dotnet-minimal' }) },
  }
  const named = appSchema.safeParse(fields)
  const app = named.success ? named.data : appSchema.parse({ ...fields, name: 'TriviaApp' })

  fs.cpSync(template, dir, { recursive: true, force: false, errorOnExist: true, filter: (file) => !file.endsWith('.template') })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
  const config = target === 'next-refine' ? 'next.config.ts' : 'vite.config.ts'
  fs.copyFileSync(path.join(template, config + '.template'), path.join(dir, config), fs.constants.COPYFILE_EXCL)
  fs.mkdirSync(path.join(dir, 'blueprint'))
  fs.writeFileSync(path.join(dir, 'blueprint', APP_DOC), serialize(app), { flag: 'wx' })
  console.log(`Created ${destination}`)
  if (!localPlugin) console.log('Point ' + framework + ' and contract-sync at your Trivia distribution before installing.')
  console.log(`Run in ${dir}\n  pnpm install` + registryCommands(templateItems()).map((line) => '\n  ' + line).join(''))
  if (dotnet) console.log(ASPIRE_NEXT_STEPS)
}

interface Command {
  executable: string
  prefix?: string[]
}

type BackendCommands = Record<'trivia-dotnet' | 'dotnet' | 'pnpm' | 'aspire', Command>

const backendCommands: BackendCommands = {
  'trivia-dotnet': { executable: 'trivia-dotnet' },
  dotnet: { executable: 'dotnet' },
  aspire: { executable: 'aspire' },
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

// Running the solution needs the pinned Aspire CLI; generating it does not. Another major or minor stops here.
function checkAspire({ executable, prefix = [] }: Command, cwd: string): void {
  const { status, stdout, error } = spawnSync(executable, [...prefix, '--version'], {
    cwd, shell: false, encoding: 'utf8', timeout: 60_000, env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1' },
  })
  if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    console.error(ASPIRE_MISSING)
    return
  }
  const checked = checkAspireVersion(error || status !== 0 ? '' : stdout)
  if (checked && 'error' in checked) throw new Error(checked.error)
  if (checked) console.error(checked.warning)
}

function migrated(stdout: string): Migrated {
  const value = JSON.parse(stdout) as Partial<Migrated>
  if (typeof value.migration !== 'string' || !Array.isArray(value.renames) || !Array.isArray(value.settled)) {
    throw new Error('The migration step returned no migration, renames or settled markers.')
  }
  return value as Migrated
}

function webProject(directory: string): string {
  const nested = path.join(directory, DEFAULT_WEB_DIRECTORY)
  return !fs.existsSync(path.join(directory, 'blueprint', APP_DOC)) &&
    fs.existsSync(path.join(nested, 'blueprint', APP_DOC)) ? nested : directory
}

async function backend(directory: string, migration: string | undefined, commands: BackendCommands, requested?: string): Promise<void> {
  directory = fs.realpathSync(directory)
  const web = requested === undefined ? webProject(directory) : path.join(directory, requested)
  const blueprint = path.join(web, 'blueprint')
  if (fs.realpathSync(blueprint) !== blueprint) throw new Error('The web blueprint must use real directories within the solution.')
  const entry = loadDocument(APP_DOC, fs.readFileSync(path.join(blueprint, APP_DOC), 'utf8'))
  if (entry.kind !== 'app' || !entry.doc || entry.doc.targets.api !== 'dotnet-minimal') {
    throw new Error('Use a .NET solution created by trivia-blueprint new <dir> --api dotnet-minimal.')
  }
  const packagePath = path.join(web, 'package.json')
  const manifest: unknown = fs.existsSync(packagePath) ? JSON.parse(fs.readFileSync(packagePath, 'utf8')) : null
  const layout = requested === undefined
    ? solutionFromWeb(web, manifest) ?? (path.basename(web) === DEFAULT_WEB_DIRECTORY
      ? { root: path.dirname(web), webDirectory: DEFAULT_WEB_DIRECTORY } : null)
    : { root: directory, webDirectory: requested }
  if (!layout) throw new Error('Pass --web-dir from the solution root to locate the web app.')
  const { root: solution, webDirectory } = layout
  checkAspire(commands.aspire, solution)
  const args = ['--blueprint', blueprint, '--root', solution]
  const location = webDirectory === DEFAULT_WEB_DIRECTORY ? [] : ['--web-dir', webDirectory]
  const generated = step('Generate the backend', commands['trivia-dotnet'], ['write', ...args, ...location], solution)
  const { modelRev, diagnostics } = JSON.parse(generated) as { modelRev?: string; diagnostics?: Partial<Diagnostic>[] }
  if (typeof modelRev !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(modelRev)) {
    throw new Error('Backend generation returned no model revision.')
  }
  // A successful write carries warnings only, such as an API without authentication.
  for (const { severity, doc, pointer, message } of diagnostics ?? []) {
    console.log(`${severity ?? 'warning'} ${doc ?? ''}${pointer ?? ''}: ${message ?? ''}`)
  }
  const project = await openProject(web)
  let recorded = modelRev
  if (migration !== undefined) {
    const result = migrated(step('Add the migration', commands['trivia-dotnet'], ['migrate', migration, ...args], solution))
    // The guarded clear refuses if the model changed after migrate read it, and the loop stops there.
    recorded = await project.clearRenameMarkers(result) ?? modelRev
    for (const { oldName, newName } of result.renames) console.log(`Renamed ${oldName} to ${newName}.`)
  }
  const build = step('Build the solution', commands.dotnet, ['build', entry.doc.name + '.slnx', '--disable-build-servers'], solution)
  if (build) process.stdout.write(build)
  const sync = step('Sync the API contract', commands.pnpm, ['run', 'sync'], web)
  if (sync) process.stdout.write(sync)

  const { pages } = await project.refine.drift()
  await project.recordGeneratedModel(recorded)
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
  let webDirectory: string | undefined
  try {
    if (!command || !Object.hasOwn(options, command)) throw new Error('Choose a command.')
    const parsed = parseArgs({ args, allowPositionals: true, options: options[command as keyof typeof options] })
    values = parsed.values
    positionals = parsed.positionals
    if ((command === 'validate' || command === 'backend') && positionals.length) throw new Error(command + ' takes no positional arguments.')
    if ((command === 'new' || command === 'compile') && (positionals.length !== 1 || !positionals[0])) throw new Error('Provide exactly one directory or page name.')
    if (values.target !== undefined && values.target !== 'vite-refine' && values.target !== 'next-refine') {
      throw new Error('The supported targets are vite-refine and next-refine.')
    }
    if (values.api !== undefined && values.api !== 'dotnet-minimal') throw new Error('The supported API target is dotnet-minimal.')
    if (typeof values['web-dir'] === 'string') {
      if (command === 'new' && values.api !== 'dotnet-minimal') throw new Error('--web-dir requires --api dotnet-minimal.')
      webDirectory = checkedWebDirectory(values['web-dir'])
    }
    if (typeof values.migration === 'string' && !values.migration.trim()) throw new Error('Provide a migration name.')
    if (values.out === '') throw new Error('Provide an output filename.')
  } catch (error) {
    console.error((error as Error).message + '\n' + usage)
    return 2
  }

  const root = process.cwd()
  try {
    if (command === 'new') {
      createProject(root, positionals[0]!, version, values.target === 'next-refine' ? 'next-refine' : 'vite-refine',
        values.api === 'dotnet-minimal', webDirectory)
      return 0
    }
    if (command === 'backend') {
      await backend(root, typeof values.migration === 'string' ? values.migration : undefined, commands, webDirectory)
      return 0
    }
    const project = await openProject(webProject(root))
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
    const { code, additional = [] } = compilePage(blueprint, positionals[0]!, context)
    if (typeof values.out === 'string') {
      const out = path.resolve(root, values.out)
      if (additional.some(({ file }) => path.basename(file) === path.basename(out))) {
        throw new Error('The output filename collides with a generated view.')
      }
      fs.writeFileSync(out, code)
      for (const { file, code } of additional) fs.writeFileSync(path.join(path.dirname(out), path.basename(file)), code)
    }
    else process.stdout.write(code)
    return 0
  } catch (error) {
    const { code, message, details } = error as Error & { code?: string; details?: unknown }
    console.error((code ? code + ': ' : '') + message)
    if (details) console.error(JSON.stringify(details, null, 2))
    if (command === 'eject' && code === 'unresolved_component') {
      for (const line of registryCommands((details as { requires?: RegistryItem[] } | undefined)?.requires ?? [])) console.error(line)
    }
    if (command === 'eject' && (details as { diagnostics?: { code: string }[] } | undefined)?.diagnostics
      ?.some(({ code }) => code === 'unknown_resource')) {
      console.error('Generate the backend and sync the contract with trivia-blueprint backend, then eject again.')
    }
    return 1
  }
}
