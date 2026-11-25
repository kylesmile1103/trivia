import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

import { APP_DOC, appSchema, BLUEPRINT_VERSION, hasErrors, SCHEMA_URL, serialize, validate, type Blueprint } from '@trivia/blueprint'

import { compilePage, type CompileContext } from './compile.js'

const usage = `Usage: trivia-blueprint <command>
  new <dir> [--target vite-refine]
  validate [--json]
  compile <Page> [--out file]
  eject [pages…] [--dry-run]`

const options = {
  new: { target: { type: 'string' } },
  validate: { json: { type: 'boolean' } },
  compile: { out: { type: 'string' } },
  eject: { 'dry-run': { type: 'boolean' } },
} as const

const contractSync = '@trivia/contract-sync'
const plugin = '@trivia/vite-plugin-ast-locator'
const service = '@trivia/dev-service'

interface Project {
  blueprintInputs(): Promise<{ blueprint: Blueprint; context: CompileContext }>
  planBlueprintEject(pages?: string[]): Promise<unknown>
  ejectBlueprint(pages?: string[]): Promise<unknown>
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

function createProject(root: string, dest: string, version: string): void {
  const dir = path.resolve(root, dest)
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false })
  if (stat && (!stat.isDirectory() || fs.readdirSync(dir).length > 0)) throw new Error(dir + ' must be an empty directory.')
  const template = fileURLToPath(new URL('../templates/vite-refine/', import.meta.url))
  const manifest = JSON.parse(fs.readFileSync(path.join(template, 'package.json.template'), 'utf8'))
  const localPlugin = resolveManifest(root, plugin) ?? checkoutManifest('vite-plugin-ast-locator')
  manifest.devDependencies[plugin] = localPlugin ? 'link:' + path.dirname(localPlugin) : version
  const localSync = resolveManifest(root, contractSync) ?? checkoutManifest('contract-sync')
  manifest.devDependencies[contractSync] = localSync ? 'link:' + path.dirname(localSync) : version
  const candidate = path.basename(dir).replace(/(?:^|[^A-Za-z0-9]+)([A-Za-z0-9])/g, (_, char: string) => char.toUpperCase())
  const fields = { $schema: SCHEMA_URL.app, blueprintVersion: BLUEPRINT_VERSION, targets: { web: 'vite-refine' }, name: candidate }
  const named = appSchema.safeParse(fields)
  const app = named.success ? named.data : appSchema.parse({ ...fields, name: 'TriviaApp' })

  fs.cpSync(template, dir, { recursive: true, force: false, errorOnExist: true, filter: (file) => !file.endsWith('.template') })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
  fs.copyFileSync(path.join(template, 'vite.config.ts.template'), path.join(dir, 'vite.config.ts'), fs.constants.COPYFILE_EXCL)
  fs.mkdirSync(path.join(dir, 'blueprint'))
  fs.writeFileSync(path.join(dir, 'blueprint', APP_DOC), serialize(app), { flag: 'wx' })
  console.log(`Created ${dir}`)
  if (!localPlugin) console.log('Point the Trivia Vite plugin and contract-sync dependencies at your Trivia distribution before installing.')
  console.log('Run in the new directory:\n  pnpm install\n  pnpm exec shadcn add https://ui.refine.dev/r/layout-01.json https://ui.refine.dev/r/views.json')
}

export async function run(argv: string[], version: string): Promise<number> {
  const [command, ...args] = argv
  let values: Record<string, unknown>
  let positionals: string[]
  try {
    if (!command || !Object.hasOwn(options, command)) throw new Error('Choose a command.')
    const parsed = parseArgs({ args, allowPositionals: true, options: options[command as keyof typeof options] })
    values = parsed.values
    positionals = parsed.positionals
    if (command === 'validate' && positionals.length) throw new Error('Validate takes no positional arguments.')
    if ((command === 'new' || command === 'compile') && (positionals.length !== 1 || !positionals[0])) throw new Error('Provide exactly one directory or page name.')
    if (values.target !== undefined && values.target !== 'vite-refine') throw new Error('The supported target is vite-refine.')
    if (values.out === '') throw new Error('Provide an output filename.')
  } catch (error) {
    console.error((error as Error).message + '\n' + usage)
    return 2
  }

  const root = process.cwd()
  try {
    if (command === 'new') {
      createProject(root, positionals[0]!, version)
      return 0
    }
    const project = await openProject(root)
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
    return 1
  }
}
