import fs from 'node:fs'
import path from 'node:path'

import {
  APP_DOC, BLUEPRINT_VERSION, MODEL_DOC, apply, blueprintOpSchema, componentManifestSchema, loadBlueprint, resolveManifests, ulidSource,
  type Blueprint, type BlueprintStore, type ComponentManifest, type ComponentSchema, type Diagnostic, type DocEntry, type ManifestResolution,
  type ApplyOutcome,
} from '@trivia/blueprint'
import type { TriviaManifest } from '@trivia/contract-sync'

import { ApiError, type EngineBinding } from '../engine.js'
import type { DevHost } from '../host.js'
import { validationContext } from './context.js'
import { checkedPath } from './paths.js'

const kitDir = new URL('./kit/', import.meta.resolve('@trivia/blueprint-compiler/package.json'))
const kit = fs.readdirSync(kitDir).filter((file) => file.endsWith('.manifest.json')).sort().map((file) =>
  componentManifestSchema.parse(JSON.parse(fs.readFileSync(new URL(file, kitDir), 'utf8'))),
)

export function readBytes(root: string, file: string): Buffer | null {
  try {
    const absolute = checkedPath(root, file)
    const stat = fs.lstatSync(absolute, { throwIfNoEntry: false })
    if (!stat) return null
    if (!stat.isFile()) throw new ApiError('io_error', `${file} is not a regular file`)
    return fs.readFileSync(absolute)
  } catch (error) {
    if (error instanceof ApiError) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new ApiError('io_error', `Cannot read ${file}: ${(error as Error).message}`)
  }
}

function readText(root: string, file: string): string | null {
  return readBytes(root, file)?.toString('utf8') ?? null
}

function listFiles(root: string, dir: string): string[] {
  const absolute = checkedPath(root, dir)
  try {
    return fs.readdirSync(absolute, { withFileTypes: true }).filter((entry) => !entry.isDirectory())
      .map(({ name }) => name).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new ApiError('io_error', `Cannot list ${dir}: ${(error as Error).message}`)
  }
}

export function checkDocumentVersion(entry: DocEntry | undefined): void {
  const unsupported = entry?.diagnostics.find(({ code }) => code === 'unsupported_version')
  if (unsupported) {
    const found = (entry?.value as { blueprintVersion?: number })?.blueprintVersion
    throw new ApiError('unsupported', unsupported.message, { found, supported: BLUEPRINT_VERSION })
  }
}

/** Checked reads for the shared service. The blueprint package owns parsing and reduction. */
export class BlueprintWorkspace implements BlueprintStore {
  readonly #host: DevHost
  readonly #engine: EngineBinding
  readonly #components: () => unknown[]
  readonly #manifestPath: string
  readonly #ids = ulidSource()

  constructor(host: DevHost, readonly dir: string, engine: EngineBinding, components: () => unknown[], manifestPath = 'trivia.manifest.json') {
    this.#host = host
    this.#engine = engine
    this.#components = components
    this.#manifestPath = manifestPath
  }

  get root(): string {
    return this.#host.root
  }

  readDocumentText(file: string): string | null {
    return readText(this.root, `${this.dir}/${file}`)
  }

  async read(): Promise<Blueprint> {
    const directory = checkedPath(this.root, this.dir)
    const stat = fs.lstatSync(directory, { throwIfNoEntry: false })
    if (!stat) return loadBlueprint({}, { exists: false })
    if (!stat.isDirectory()) throw new ApiError('io_error', `${this.dir} is not a directory`)
    const files: Record<string, string> = {}
    const paths = [APP_DOC, MODEL_DOC, ...listFiles(this.root, `${this.dir}/pages`).map((name) => `pages/${name}`)]
    for (const file of paths) {
      const text = this.readDocumentText(file)
      if (text !== null) files[file] = text
    }
    return loadBlueprint(files)
  }

  manifests(): ManifestResolution {
    const config = this.#json('components.json') as { style?: string; aliases?: { components?: string } } | null
    const components = fs.existsSync(path.resolve(this.root, this.#host.uiDir))
      ? this.#components() as ComponentSchema[] : []
    const overrides: ComponentManifest[] = []
    const diagnostics: Diagnostic[] = []
    for (const name of listFiles(this.root, `${this.dir}/manifests`).filter((file) => file.endsWith('.manifest.json'))) {
      const file = `manifests/${name}`
      const text = this.readDocumentText(file)
      if (text === null) continue
      try {
        const manifest = componentManifestSchema.parse(JSON.parse(text))
        if (name !== `${manifest.type}.manifest.json`) throw new Error(`Expected ${manifest.type}.manifest.json`)
        overrides.push(manifest)
      } catch (error) {
        diagnostics.push({ code: 'invalid_manifest', severity: 'error', doc: file, pointer: '', message: (error as Error).message })
      }
    }
    const resolved = resolveManifests({
      kit,
      overrides,
      components,
      aliases: { ...config?.aliases, ui: this.#host.importBase, ...(typeof config?.style === 'string' && { style: config.style }) },
    })
    return { manifests: resolved.manifests, diagnostics: [...diagnostics, ...resolved.diagnostics] }
  }

  contract(): TriviaManifest | null {
    return this.#json(this.#manifestPath) as TriviaManifest | null
  }

  aliases(): Record<string, string> {
    const config = this.#json('components.json') as { aliases?: Record<string, unknown> } | null
    return Object.fromEntries(Object.entries(config?.aliases ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  }

  get hostKind(): DevHost['kind'] {
    return this.#host.kind
  }

  get canPreview(): boolean {
    return this.#host.preview.blueprints === true
  }

  context(manifests = this.manifests(), contract = this.contract()) {
    return validationContext(manifests, contract, this.#engine)
  }

  async apply(ops: readonly unknown[]): Promise<ApplyOutcome> {
    const blueprint = await this.read()
    const outcome = apply(blueprint, ops, {
      ids: this.#ids,
      ctx: this.context(),
      expressions: { renameReferences: this.#engine.renameReferences },
    })
    if (!outcome.ok && outcome.error.code === 'invalid_op' && outcome.error.op !== undefined) {
      const refused = blueprintOpSchema.safeParse(ops[outcome.error.op])
      if (refused.success) checkDocumentVersion(blueprint.docs[refused.data.doc])
    }
    return outcome
  }

  #json(file: string): unknown {
    const text = readText(this.root, file)
    try {
      return text === null ? null : JSON.parse(text)
    } catch (error) {
      throw new ApiError('io_error', `Cannot read ${file}: ${(error as Error).message}`)
    }
  }
}
