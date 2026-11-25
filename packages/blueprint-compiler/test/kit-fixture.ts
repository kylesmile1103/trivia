import { cpSync, globSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { componentManifestSchema, exposedScope, expressionCheck, loadBlueprint, manifestCheck, resolveManifests, type ComponentManifest, type ComponentSchema } from '@trivia/blueprint'

import * as engine from '@trivia/engine'

import { compilePage, pageDiagnostics, projectFacts, type CompileContext } from '../src/index.js'

const kit = new URL('../kit/', import.meta.url)
export const fixtureDir = new URL('../fixtures/kit/', import.meta.url)

const list = (pattern: string, root: URL) => globSync(pattern, { cwd: fileURLToPath(root) }).sort()
const read = (file: string, root: URL) => readFileSync(new URL(file.replaceAll('\\', '/'), root), 'utf8')

export function kitManifests(): ComponentManifest[] {
  return list('*.manifest.json', kit).map((file) => {
    const manifest = componentManifestSchema.parse(JSON.parse(read(file, kit)))
    if (file !== manifest.type + '.manifest.json') throw new Error('Unexpected kit manifest filename: ' + file)
    return manifest
  })
}

export function fixture(): Record<string, string> {
  const files = ['app.blueprint.json', ...list('pages/*.page.json', fixtureDir)]
  return Object.fromEntries(files.map((file) => [file.replaceAll('\\', '/'), read(file, fixtureDir)]))
}

export function missingKitTypes(manifests: readonly Pick<ComponentManifest, 'type'>[], files: Record<string, string>): string[] {
  const types = new Set<string>()
  for (const entry of Object.values(loadBlueprint(files).docs)) {
    if (entry.kind !== 'page') continue
    if (entry.doc === null) throw new Error('Invalid fixture page: ' + entry.path)
    if (entry.doc.kind !== 'custom') continue
    for (const { type } of Object.values(entry.doc.nodes)) types.add(type)
  }
  return manifests.map(({ type }) => type).filter((type) => !types.has(type))
}


export const kitApp = new URL('../../../examples/blueprint-kit/', import.meta.url)

export function kitContext(app = kitApp): CompileContext {
  const config = JSON.parse(read('components.json', app))
  const checked = JSON.parse(engine.components(fileURLToPath(app), 'src/components/ui', config.aliases.ui))
  if (!checked.ok) throw new Error(checked.error.message)
  const { manifests } = resolveManifests({
    kit: kitManifests(), components: checked.data as ComponentSchema[], aliases: { ...config.aliases, style: config.style },
  })
  const facts = projectFacts({ aliases: config.aliases })
  return {
    engine, facts, manifests,
    validation: {
      manifests: manifestCheck(manifests),
      expressions: expressionCheck(engine.analyzeExpressions, (page) => exposedScope(page, manifests)),
    },
  }
}

export function compileKitPage(name: string, context = kitContext()) {
  const blueprint = loadBlueprint(fixture())
  const errors = pageDiagnostics(blueprint, name, context).filter(({ severity }) => severity === 'error')
  if (errors.length) throw new Error(JSON.stringify(errors, null, 2))
  return compilePage(blueprint, name, context)
}


export async function kitServiceContext(app = kitApp): Promise<CompileContext> {
  // The compiler's Nx test target builds the plugin and its dev-service dependency.
  const module = new URL('../../dev-service/dist/index.js', import.meta.url)
  const { createStandaloneHost, EngineService } = await import(module.href)
  const service = new EngineService({ engine, host: createStandaloneHost(fileURLToPath(app)), version: 'test' })
  return (await service.blueprintInputs()).context
}


export async function kitFormFieldContext(): Promise<CompileContext> {
  const app = new URL('../../../examples/refine-admin/', import.meta.url)
  const temp = mkdtempSync(join(tmpdir(), 'trivia-kit-form-field-'))
  try {
    mkdirSync(join(temp, 'src/components'), { recursive: true })
    cpSync(new URL('src/components/ui/', app), join(temp, 'src/components/ui'), { recursive: true })
    rmSync(join(temp, 'src/components/ui/field.tsx'))
    for (const file of ['components.json', 'trivia.manifest.json']) cpSync(new URL(file, app), join(temp, file))
    return await kitServiceContext(pathToFileURL(temp + '/'))
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}
