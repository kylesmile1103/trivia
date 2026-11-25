// What the engine API does, independent of how it is reached: the HTTP routes (./http.ts) and
// the MCP tools (../mcp) both call this. Edits run through one queue, so two edits never
// interleave their read-modify-write of a file, and land in one undo history, whoever sent
// them.

import fsp from 'node:fs/promises'
import path from 'node:path'

import { ApiError, type EngineBinding, type GuardedWrite, type OpsResult, unwrap } from '../engine.js'
import type { DevHost } from '../host.js'
import type { ApplyResult, Drift, Health, HistoryResult, HistoryState, ManifestState } from '../types.js'
import { type Mention, RefineAdapter } from '../refine/index.js'
import type { RouteEntry } from '../routes/index.js'
import { normalizePath } from '../routes/paths.js'
import { uncommitted } from './git.js'
import { History } from './history.js'
import { SerialQueue } from './queue.js'
import { type Screenshot, ScreenshotRelay } from './screenshots.js'
import { type Selected, type SelectionState, SelectionStore, rebase } from './selection.js'

export type Json = Record<string, unknown>

export interface ServiceOptions {
  host: DevHost
  version: string
  engine: EngineBinding
  /** Undo entries kept (docs/api.md: 100). */
  historyLimit?: number
  /** Project-relative path of contract-sync's manifest. Default "trivia.manifest.json". */
  manifestPath?: string
  /** How long a screenshot request waits for an open designer (ms). Default 15 000. */
  screenshotTimeoutMs?: number
}

/** A route, with the Refine resource and action that declare its path (`<Refine resources>`). */
export interface AppRoute extends RouteEntry {
  resource: { name: string; action: string } | null
}

export interface SyncOptions {
  /** Spec path or URL; default: the manifest's `source.location`. */
  input?: string
  /** Generate zod schemas; default: as the manifest was (true without one). */
  zod?: boolean
  /** Regenerate even over uncommitted changes to the generated code. */
  force?: boolean
}

export interface SyncResult {
  source: string
  outputDir: string
  files: number
  schemaHash: string
  /** False when the spec's schemaHash is the one the manifest already had: nothing in the contract changed. */
  contractChanged: boolean
  resources: string[]
  /** What the git guard found: "clean", what `force` replaced, or that the project isn't a git work tree. */
  git: string
}

/** Who sent an edit: the designer (or another HTTP client), or an agent through MCP. */
export interface EditSource {
  /** An agent's edit moves the published selection along with the node it was on. */
  by?: 'designer' | 'agent'
}

export class EngineService {
  readonly #options: ServiceOptions
  readonly #history: History
  readonly #queue = new SerialQueue()
  readonly #selection = new SelectionStore()
  readonly #screenshots = new ScreenshotRelay()
  /** Refine pages: their columns, contract fields, and the ops that change them (docs/product.md). */
  readonly refine: RefineAdapter

  constructor(options: ServiceOptions) {
    this.#options = options
    this.#history = new History(options.historyLimit ?? 100)
    this.refine = new RefineAdapter({
      root: options.host.root,
      kind: options.host.kind,
      uiDir: options.host.uiDir,
      importBase: options.host.importBase,
      preview: options.host.preview,
      routes: () => this.routes(),
      describeValues: (file) => this.describeValues(file),
      manifest: () => this.manifest(),
      outline: (file) => this.outline(file),
      inspect: (locator) => this.inspect(locator),
      describeValue: (path) => this.describeValue(path),
      mentions: (file, name) => this.mentions(file, name),
    })
  }

  health(): Health {
    const { host: { root, uiDir, importBase, kind }, version } = this.#options
    return { root, uiDir, importBase, version, ...(kind === 'next' ? { host: kind } : {}) }
  }

  components(): unknown[] {
    const { engine, host: { root, uiDir, importBase } } = this.#options
    return unwrap<unknown[]>(engine.components(root, uiDir, importBase))
  }

  inspect(locator: string): unknown {
    if (!locator) throw new ApiError('invalid_locator', 'missing locator (<file>#<component>#<i.j.k>)')
    return unwrap<unknown>(this.#options.engine.inspect(this.#options.host.root, locator))
  }

  /** Every JSX tree of the project-relative `file`, with locators (docs/api.md). */
  outline(file: string): unknown[] {
    if (!file) throw new ApiError('invalid_op', 'missing file (project-relative, e.g. src/pages/Home.tsx)')
    return unwrap<unknown[]>(this.#options.engine.outline(this.#options.host.root, file))
  }

  /** The scopes of `file` with their top-level bindings and hook calls (engine value descriptions). */
  describeValues(file: string): unknown[] {
    if (!file) throw new ApiError('invalid_op', 'missing file (project-relative, e.g. src/pages/Home.tsx)')
    return unwrap<unknown[]>(this.#options.engine.describeValues(this.#options.host.root, file))
  }

  /** The value at a value path (`<file>#<scope>#<path>`), unwrapped to its literal. */
  describeValue(path: string): unknown {
    return unwrap<unknown>(this.#options.engine.describeValue(this.#options.host.root, path))
  }

  /** The app's routes, read from its source (docs/api.md `GET /routes`). */
  async routes(): Promise<AppRoute[]> {
    const found = await this.#options.host.readRoutes({
      outline: (file) => this.outline(file),
      inspect: (locator) => this.inspect(locator),
      describeValues: (file) => this.describeValues(file),
    })
    const resources = await this.refine.resourceRoutes().catch(() => [])
    return found.map((route) => {
      const declared = resources.find((r) => normalizePath(r.path) === normalizePath(route.path))
      return { ...route, resource: declared ? { name: declared.resource, action: declared.action } : null }
    })
  }

  /** Where `file` still names `name`: member accesses, string literals, object keys, destructured names. */
  mentions(file: string, name: string): Mention[] {
    return unwrap<Mention[]>(this.#options.engine.mentions(this.#options.host.root, file, name))
  }

  history(): HistoryState {
    return this.#history.state()
  }

  /** contract-sync's manifest, and whether its spec changed since the code was generated. */
  async manifest(): Promise<ManifestState> {
    const file = path.join(this.#options.host.root, this.#options.manifestPath ?? 'trivia.manifest.json')
    let text: string
    try {
      text = await fsp.readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { manifest: null, drift: null }
      throw new ApiError('io_error', `cannot read ${path.basename(file)}: ${(error as Error).message}`)
    }
    let manifest: { schemaHash?: unknown; source?: { location?: unknown } }
    try {
      manifest = JSON.parse(text) as typeof manifest
    } catch (error) {
      throw new ApiError('io_error', `${path.basename(file)} is not valid JSON (${(error as Error).message}); re-run contract-sync`)
    }
    return { manifest, drift: await this.#drift(manifest) }
  }

  /**
   * Re-run contract-sync (`docs/data-provider.md`) with the manifest's own source, output and
   * zod setting, in the edit queue. Refused (`conflict`) when the generated code or the manifest
   * has uncommitted changes it would replace, unless `force`. Not in Trivia's undo history.
   */
  async syncContract(options: SyncOptions = {}): Promise<SyncResult> {
    return this.#queue.run(async () => {
      const root = this.#options.host.root
      const { manifest } = await this.manifest()
      const current = manifest as {
        schemaHash?: unknown
        source?: { location?: string }
        modules?: { outputDir?: string; zod?: unknown }
      } | null
      const input = options.input ?? current?.source?.location
      if (!input) {
        throw new ApiError('invalid_op', 'no spec to generate from: pass input (a spec path or URL); this project has no trivia.manifest.json to take it from')
      }
      const outputDir = current?.modules?.outputDir ?? 'src/api/generated'
      const manifestPath = this.#options.manifestPath ?? 'trivia.manifest.json'
      const dirty = await uncommitted(root, [outputDir, manifestPath])
      if (dirty !== null && dirty.length > 0 && !options.force) {
        throw new ApiError(
          'conflict',
          `regenerating would replace uncommitted changes in ${dirty.join(', ')}; commit them first (or pass force: true to replace them)`,
        )
      }
      const contractSync = await import('@trivia/contract-sync')
      let result: Awaited<ReturnType<typeof contractSync.syncContract>>
      try {
        result = await contractSync.syncContract({
          input,
          cwd: root,
          outputDir,
          manifestPath,
          zod: options.zod ?? (current ? current.modules?.zod != null : true),
        })
      } catch (error) {
        if (error instanceof contractSync.ContractSyncError) {
          throw new ApiError('unsupported', `contract-sync failed (${error.code}): ${error.message}${error.hint ? ` (${error.hint})` : ''}`)
        }
        throw error
      }
      return {
        source: input,
        outputDir,
        files: result.files.length,
        schemaHash: result.manifest.schemaHash,
        contractChanged: current?.schemaHash !== result.manifest.schemaHash,
        resources: result.manifest.resources.map((r) => r.name),
        git:
          dirty === null
            ? 'not a git work tree: nothing was guarded'
            : dirty.length === 0
              ? 'clean'
              : `forced: replaced uncommitted changes in ${dirty.join(', ')}`,
      }
    })
  }

  /** A PNG of the designer's canvas, from the open designer (see ScreenshotRelay). */
  screenshot(): Promise<Screenshot> {
    return this.#screenshots.request(this.#options.screenshotTimeoutMs ?? 15_000)
  }

  /** The designer's long-poll for screenshot requests; `signal` aborts when it hangs up. */
  nextScreenshot(timeoutMs = 25_000, signal?: AbortSignal): Promise<{ id: string | null }> {
    return this.#screenshots.next(timeoutMs, signal)
  }

  /** The designer's answer to a screenshot request. */
  fulfillScreenshot(id: string, answer: { png: string; width: number; height: number } | { error: string }): void {
    this.#screenshots.fulfill(id, answer)
  }

  /**
   * Hash the spec the manifest names with contract-sync's own canonical hash (so formatting
   * alone is no drift). Unknown for a URL (not fetched on every look) or a spec that is gone.
   */
  async #drift(manifest: { schemaHash?: unknown; source?: { location?: unknown } }): Promise<Drift> {
    const source = typeof manifest.source?.location === 'string' ? manifest.source.location : null
    const manifestHash = typeof manifest.schemaHash === 'string' ? manifest.schemaHash : null
    const unknown: Drift = { status: 'unknown', source, manifestHash, specHash: null }
    if (source === null || /^https?:\/\//i.test(source)) return unknown
    try {
      // Loaded on first use: contract-sync brings hey-api, which the dev server needs only here.
      const { loadSpec, schemaHash } = await import('@trivia/contract-sync')
      const specHash = schemaHash((await loadSpec(source, { cwd: this.#options.host.root })).spec)
      return { status: specHash === manifestHash ? 'current' : 'changed', source, manifestHash, specHash }
    } catch {
      return unknown
    }
  }

  selection(): SelectionState {
    return this.#selection.get()
  }

  /** The designer's selection changed (null: nothing selected). */
  select(selection: Selected | null): SelectionState {
    if (selection !== null && !isLocator(selection.locator)) {
      throw new ApiError('invalid_locator', `invalid locator \`${selection.locator}\` (expected \`<file>#<component>#<i.j.k>\`)`)
    }
    return this.#selection.set(selection, 'designer')
  }

  /** One op, one undo entry. `label` defaults to a description of the op. */
  apply(op: unknown, label?: string, source: EditSource = {}): Promise<ApplyResult> {
    if (!isObject(op)) throw new ApiError('invalid_op', 'an op must be an object ({ op: "updateProp", … }, docs/api.md)')
    return this.#queue.run(() => this.#transact([op], label ?? describe(op), source))
  }

  /** Several ops as one transaction: all files are written or none, as one undo entry. */
  batch(ops: unknown, label?: string, source: EditSource = {}): Promise<ApplyResult> {
    if (!Array.isArray(ops) || ops.length === 0 || !ops.every(isObject)) {
      throw new ApiError('invalid_op', 'ops must be a non-empty array of op objects')
    }
    return this.#queue.run(() => this.#transact(ops, label ?? `${ops.length} edits`, source))
  }

  undo(): Promise<HistoryResult> {
    return this.#queue.run(() => this.#travel('undo'))
  }

  redo(): Promise<HistoryResult> {
    return this.#queue.run(() => this.#travel('redo'))
  }

  /** Apply ops as one transaction (the engine writes all files or none) and record it. */
  #transact(ops: Json[], label: string, source: EditSource): ApplyResult {
    const { engine, host } = this.#options
    const finish = host.trackFileWrites?.(ops.flatMap((op) => op.op === 'createFile' && typeof op.file === 'string' ? [op.file] : []), [])
    const result = unwrap<OpsResult>(engine.applyOps(host.root, JSON.stringify(ops)))
    if (result.changed) {
      finish?.()
      host.filesChanged?.(result.changes.map((change) => change.file))
    }
    if (result.changes.length > 0) this.#history.record({ label, changes: result.changes })
    if (source.by === 'agent' && result.changed) this.#follow(ops, result.locator)
    return { file: result.file, changed: result.changed, locator: result.locator, history: this.#history.state() }
  }

  /**
   * Move the published selection with an agent's edit: to where its node now is, checked by
   * tag name, or to nothing when that can't be known (the node was removed, the tag there is
   * another one, several ops ran). Never to whatever slid into its old position.
   */
  #follow(ops: Json[], resultLocator: string | null): void {
    const current = this.#selection.get().selection
    if (current === null) return
    const [only] = ops
    let next = ops.length === 1 && only ? rebase(current.locator, only, resultLocator) : current.locator
    if (next !== null) {
      try {
        const details = unwrap<{ name: string }>(this.#options.engine.inspect(this.#options.host.root, next))
        if (details.name !== current.name) next = null
      } catch {
        next = null
      }
    }
    this.#selection.set(next === null ? null : { locator: next, name: current.name }, 'agent')
  }

  /** Undo writes each `before` back where the file still holds `after`; redo mirrors it. */
  #travel(direction: 'undo' | 'redo'): HistoryResult {
    const history = this.#history
    const entry = direction === 'undo' ? history.nextUndo : history.nextRedo
    if (!entry) return { files: [], history: history.state() }
    const writes: GuardedWrite[] =
      direction === 'undo'
        ? entry.changes.toReversed().map((c) => ({ file: c.file, expected: c.after, content: c.before }))
        : entry.changes.map((c) => ({ file: c.file, expected: c.before, content: c.after }))
    const finish = this.#options.host.trackFileWrites?.(
      writes.filter((write) => write.expected === null).map((write) => write.file),
      writes.filter((write) => write.content === null).map((write) => write.file),
    )
    try {
      unwrap<null>(this.#options.engine.restoreFiles(this.#options.host.root, JSON.stringify(writes)))
    } catch (error) {
      if (error instanceof ApiError) throw new ApiError(error.code, `${direction} "${entry.label}" failed: ${error.message}`)
      throw error
    }
    finish?.()
    this.#options.host.filesChanged?.(entry.changes.map((change) => change.file))
    if (direction === 'undo') history.undone()
    else history.redone()
    return { files: entry.changes.map((c) => c.file), history: history.state() }
  }
}

/** A default history label when the caller sends none. */
function describe(op: Json): string {
  const name = typeof op['expectedName'] === 'string' ? `<${op['expectedName']}>` : 'element'
  const prop = typeof op['prop'] === 'string' ? op['prop'] : 'prop'
  switch (op['op']) {
    case 'updateProp':
      return op['value'] === null ? `Remove ${prop}` : `Set ${prop}`
    case 'setText':
      return `Set text of ${name}`
    case 'createFile':
      return `Create ${typeof op['file'] === 'string' ? op['file'] : 'a file'}`
    case 'insert':
    case 'insertChild':
      return 'Insert element'
    case 'remove':
      return `Remove ${name}`
    case 'replaceElement':
      return `Replace ${name}`
    case 'move':
    case 'moveNode':
      return `Move ${name}`
    case 'bindQuery':
      return `Bind ${name} to ${typeof op['optionsFn'] === 'string' ? op['optionsFn'] : 'a query'}`
    case 'insertElement':
      return 'Insert item'
    case 'removeElement':
      return 'Remove item'
    case 'moveElement':
      return 'Move item'
    case 'setProperty':
      return `Set ${prop}`
    case 'removeProperty':
      return `Remove ${prop}`
    case 'setCallArgument':
    case 'insertCall':
    case 'removeCall':
      return 'Edit rule'
    default:
      return 'Edit'
  }
}

function isLocator(value: string): boolean {
  return /^.+#[^#]+#(0|[1-9]\d*)(\.(0|[1-9]\d*))*$/.test(value)
}

export function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
