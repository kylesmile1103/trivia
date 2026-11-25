import fs from 'node:fs'
import path from 'node:path'

import {
  APP_DOC, MODEL_DOC, apply, componentManifestSchema, loadBlueprint, resolveManifests, ulidSource,
  type Blueprint, type BlueprintStore, type ComponentManifest, type ComponentSchema, type Diagnostic, type ManifestResolution,
  type ApplyOutcome,
} from '@trivia/blueprint'
import type { TriviaManifest } from '@trivia/contract-sync'

import { ApiError, type EngineBinding } from '../engine.js'
import type { DevHost } from '../host.js'
import { validationContext } from './context.js'
import { checkedPath } from './paths.js'

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
      kit: [],
      overrides,
      components,
      aliases: { ...config?.aliases, ui: this.#host.importBase, ...(typeof config?.style === 'string' && { style: config.style }) },
    })
    return { manifests: resolved.manifests, diagnostics: [...diagnostics, ...resolved.diagnostics] }
  }

  context() {
    return validationContext(this.manifests(), this.#json(this.#manifestPath) as TriviaManifest | null, this.#engine)
  }

  async apply(ops: readonly unknown[]): Promise<ApplyOutcome> {
    return apply(await this.read(), ops, {
      ids: this.#ids,
      ctx: this.context(),
      expressions: { renameReferences: this.#engine.renameReferences },
    })
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
