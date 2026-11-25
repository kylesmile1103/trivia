// The blueprint store (LLD-01 section 7): the only code that touches the files. Reading always
// goes to disk, so a hand edit shows up as a new rev on the next read. Loading is a pure
// function over the files' text, so everything above it is testable without a disk.
import fs from 'node:fs/promises'
import path from 'node:path'

import { apply, type ApplyOptions, type ApplyResult, type FileWrite } from './apply/index.js'
import { ulidSource } from './ids.js'
import { compareBytes, revOfText, type BlueprintDoc } from './serialize.js'
import type { AppDoc } from './types/app.js'
import type { ApplyError, Diagnostic } from './types/diagnostics.js'
import type { ModelDoc } from './types/model.js'
import { APP_DOC, MODEL_DOC } from './types/ops.js'
import type { PageDoc } from './types/page.js'
import { checkSchema } from './validate/schema.js'

interface Loaded<K extends string, D> {
  /** The path under the blueprint directory, with `/` separators. */
  path: string
  kind: K
  /** The file's bytes as read: the `before` of a later write. */
  text: string
  /** sha256 of those bytes. Equals rev(doc) for a file in canonical form. */
  rev: string
  /** The parsed JSON, when it parsed. */
  value?: unknown
  /** The document, when it passed the schema; null otherwise. */
  doc: D | null
  /** What reading the file found: malformed JSON, schema violations, an unknown file. */
  diagnostics: Diagnostic[]
}
export type AppEntry = Loaded<'app', AppDoc>
export type PageEntry = Loaded<'page', PageDoc>
export type ModelEntry = Loaded<'model', ModelDoc>
export type UnknownEntry = Loaded<'unknown', never>
export type DocEntry = AppEntry | PageEntry | ModelEntry | UnknownEntry

export interface Blueprint {
  /** Whether the directory exists. `createPage` or `setApp` creates it (LLD-04). */
  exists: boolean
  /** Every file of the blueprint, keyed by path, in bytewise path order. */
  docs: Record<string, DocEntry>
}

const PAGE_FILE = /^pages\/[^/]+\.page\.json$/

export function kindOf(file: string): DocEntry['kind'] {
  if (file === APP_DOC) return 'app'
  if (file === MODEL_DOC) return 'model'
  return PAGE_FILE.test(file) ? 'page' : 'unknown'
}

const diagnostic = (code: string, doc: string, message: string, severity: Diagnostic['severity'] = 'error'): Diagnostic =>
  ({ code, severity, doc, pointer: '', message })

/** Loads one file. Never throws: what is wrong with it is in its diagnostics. */
export function loadDocument(file: string, text: string): DocEntry {
  const base = { path: file, text, rev: revOfText(text), doc: null, diagnostics: [] as Diagnostic[] }
  const kind = kindOf(file)
  if (kind === 'unknown') {
    return { ...base, kind, diagnostics: [diagnostic('unknown_document', file, `${file} is not a page document (pages/<Name>.page.json)`, 'warning')] }
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    return { ...base, kind, diagnostics: [diagnostic('invalid_json', file, `Not valid JSON: ${(error as Error).message}`)] } as DocEntry
  }
  const checked = checkSchema(kind, value, file)
  return { ...base, kind, value, doc: checked.doc, diagnostics: checked.diagnostics } as DocEntry
}

/** Loads a blueprint from its files' text, keyed by path under the blueprint directory. */
export function loadBlueprint(files: Readonly<Record<string, string>>, exists = true): Blueprint {
  const docs: Record<string, DocEntry> = {}
  for (const file of Object.keys(files).sort(compareBytes)) docs[file] = loadDocument(file, files[file] as string)
  return { exists, docs }
}

async function readIfFile(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'EISDIR') return null
    throw error
  }
}

/**
 * The blueprint's files under `dir`: the app and model documents and everything in `pages/`.
 * The lock and `manifests/` belong to other features (LLD-05, LLD-02). Null when `dir` is
 * missing.
 */
export async function readBlueprintFiles(dir: string): Promise<Record<string, string> | null> {
  try {
    if (!(await fs.stat(dir)).isDirectory()) return null
  } catch {
    return null
  }
  const files: Record<string, string> = {}
  for (const name of [APP_DOC, MODEL_DOC]) {
    const text = await readIfFile(path.join(dir, name))
    if (text !== null) files[name] = text
  }
  let entries: string[] = []
  try {
    entries = await fs.readdir(path.join(dir, 'pages'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  for (const name of entries) {
    const text = await readIfFile(path.join(dir, 'pages', name))
    if (text !== null) files[`pages/${name}`] = text
  }
  return files
}

export interface StoreOptions extends Partial<ApplyOptions> {
  /** The blueprint directory, `<root>/blueprint` by default (LLD-01 section 1). */
  dir: string
}

/** The LLD's `ApplyResult & { writes }`, or the refusal: nothing to write. */
export type StoreApplyOutcome =
  | { ok: true; result: ApplyResult; writes: FileWrite[] }
  | { ok: false; error: ApplyError }

export interface BlueprintStore {
  read(): Promise<Blueprint>
  /**
   * Applies a batch to the documents as they are on disk now and returns the writes without
   * performing them. The caller writes them atomically and records one history entry; each
   * write's `before` is what it must still find, or the write is stale.
   */
  apply(ops: readonly unknown[]): Promise<StoreApplyOutcome>
}

export function createStore(options: StoreOptions): BlueprintStore {
  const ids = options.ids ?? ulidSource()
  const read = async (): Promise<Blueprint> => {
    const files = await readBlueprintFiles(options.dir)
    return files === null ? { exists: false, docs: {} } : loadBlueprint(files)
  }
  return {
    read,
    async apply(ops) {
      const applyOptions: ApplyOptions = { ids }
      if (options.expressions) applyOptions.expressions = options.expressions
      if (options.ctx) applyOptions.ctx = options.ctx
      const outcome = apply(await read(), ops, applyOptions)
      return outcome.ok ? { ok: true, result: outcome.result, writes: outcome.writes } : outcome
    },
  }
}

export type { BlueprintDoc }
