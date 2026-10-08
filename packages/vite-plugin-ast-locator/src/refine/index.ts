// The Refine adapter (docs/product.md): reads Refine + shadcn pages through the engine's value
// descriptions and the contract manifest, and plans their edits as engine ops. It knows Refine;
// the engine does not. The HTTP routes (/refine/*) and the MCP tools use it.

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import type { TriviaManifest } from '@trivia/contract-sync'

import { ApiError } from '../engine.js'
import { type ColumnContext, columnFor, humanize } from './columns.js'
import { type ListPage, type ScopeValues, contractResource, listPages } from './page.js'

export type { ColumnInfo, FieldInfo, ListPage } from './page.js'

/** A change to a list page's columns. */
export type ColumnChange =
  | { action: 'add'; field: string; index?: number; label?: string }
  | { action: 'remove'; column: string }
  | { action: 'move'; column: string; index: number }

/** `changes` from a request body, checked. */
export function parseColumnChanges(value: unknown): ColumnChange[] {
  const bad = () =>
    new ApiError(
      'invalid_op',
      'changes must be a non-empty array of { action: "add", field, index?, label? }, { action: "remove", column } or { action: "move", column, index }',
    )
  if (!Array.isArray(value) || value.length === 0) throw bad()
  return value.map((c: unknown) => {
    if (typeof c !== 'object' || c === null) throw bad()
    const { action, field, column, index, label } = c as Record<string, unknown>
    const isIndex = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0
    if (action === 'add' && typeof field === 'string' && (index === undefined || isIndex(index)) && (label === undefined || typeof label === 'string')) {
      return { action, field, ...(index !== undefined ? { index: index as number } : {}), ...(label !== undefined ? { label: label as string } : {}) }
    }
    if (action === 'remove' && typeof column === 'string') return { action, column }
    if (action === 'move' && typeof column === 'string' && isIndex(index)) return { action, column, index: index as number }
    throw bad()
  })
}

export interface Plan {
  ops: Array<Record<string, unknown>>
  label: string
}

/** What the adapter needs from the engine service. */
export interface RefineHost {
  root: string
  /** shadcn's ui folder (project-relative) and its import prefix: `src/components/ui`, `@/components/ui`. */
  uiDir: string
  importBase: string
  describeValues(file: string): unknown
  manifest(): Promise<{ manifest: unknown }>
}

/** Most files a page scan reads. */
const MAX_SCAN = 2000
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build'])

export class RefineAdapter {
  readonly #host: RefineHost

  constructor(host: RefineHost) {
    this.#host = host
  }

  /** The list pages of one file. */
  async page(file: string): Promise<ListPage[]> {
    if (!file) throw new ApiError('invalid_op', 'missing file (project-relative, e.g. src/pages/customers/list.tsx)')
    return listPages(file, this.#host.describeValues(file) as ScopeValues[], await this.#manifest())
  }

  /** Every list page under src/ (files that import @refinedev/react-table). */
  async pages(): Promise<ListPage[]> {
    const manifest = await this.#manifest()
    const out: ListPage[] = []
    for (const file of await this.#scan()) {
      try {
        out.push(...listPages(file, this.#host.describeValues(file) as ScopeValues[], manifest))
      } catch {
        // A file that doesn't parse right now (mid-edit) is skipped, not fatal for the list.
      }
    }
    return out
  }

  /** The ops for one column change on the list page in `file` (its `component`, when it has several). */
  async planColumns(file: string, component: string | undefined, changes: ColumnChange[]): Promise<Plan> {
    if (changes.length === 0) throw new ApiError('invalid_op', 'changes must not be empty')
    const pages = await this.page(file)
    const page = component ? pages.find((p) => p.component === component) : pages[0]
    if (!page) {
      throw new ApiError(
        'node_not_found',
        component ? `${file} has no list page in \`${component}\`` : `${file} has no Refine list page (a component calling useTable with columns)`,
      )
    }
    if (!component && pages.length > 1) {
      throw new ApiError('invalid_op', `${file} has ${pages.length} list pages (${pages.map((p) => p.component).join(', ')}); pass component`)
    }
    const manifest = await this.#manifest()
    const resource = contractResource(manifest, page.contract?.resource ?? null, page.rowType)
    const ops: Plan['ops'] = []
    const labels: string[] = []
    // The columns as the changes so far leave them, so a later change can name a column an
    // earlier one added (add `kycStatus`, then move it).
    const columns: Array<{ keys: string[]; path: string; label: string }> = page.columns.map((c) => ({
      keys: [c.key, c.accessorKey].filter((k): k is string => k !== null),
      path: c.path,
      label: c.label ?? c.key ?? 'column',
    }))
    const find = (key: string) => {
      const column = columns.find((c) => c.keys.includes(key))
      if (!column) {
        const keys = columns.map((c) => c.keys[0] ?? '(no id)').join(', ')
        throw new ApiError('node_not_found', `${page.component} has no column \`${key}\` (it has ${keys})`)
      }
      return column
    }
    const shown = (name: string) => columns.some((c) => c.keys.includes(name))
    for (const change of changes) {
      switch (change.action) {
        case 'add': {
          const field = resource?.entity?.fields.find((f) => f.name === change.field)
          if (!field) {
            const known = resource?.entity?.fields.map((f) => f.name).join(', ')
            throw new ApiError(
              'invalid_op',
              resource
                ? `${resource.name} has no field \`${change.field}\` (it has ${known})`
                : `${page.component} shows no contract resource, so there are no fields to add (run contract-sync, or set refineCoreProps.resource)`,
            )
          }
          if (shown(field.name)) throw new ApiError('conflict', `${page.component} already shows \`${field.name}\``)
          const label = change.label ?? humanize(field.name)
          const column = columnFor(field, this.#context(), label)
          const at = change.index ?? columns.length
          if (at > columns.length) throw new ApiError('invalid_op', `index ${at} is out of range: ${page.component} has ${columns.length} columns`)
          columns.splice(at, 0, { keys: [field.name], path: `${page.columnsPath}[id=${field.name}]`, label })
          ops.push({
            op: 'insertElement',
            path: page.columnsPath,
            ...(change.index !== undefined ? { index: change.index } : {}),
            value: column.value,
            imports: column.imports,
          })
          labels.push(`Add column ${label}`)
          break
        }
        case 'remove': {
          const column = find(change.column)
          columns.splice(columns.indexOf(column), 1)
          ops.push({ op: 'removeElement', path: column.path })
          labels.push(`Remove column ${column.label}`)
          break
        }
        case 'move': {
          const column = find(change.column)
          if (change.index >= columns.length) {
            throw new ApiError('invalid_op', `index ${change.index} is out of range: ${page.component} has ${columns.length} columns`)
          }
          columns.splice(columns.indexOf(column), 1)
          columns.splice(change.index, 0, column)
          ops.push({ op: 'moveElement', path: column.path, index: change.index })
          labels.push(`Move column ${column.label}`)
          break
        }
        default:
          throw new ApiError('invalid_op', `unknown column change ${JSON.stringify(change)} (add, remove or move)`)
      }
    }
    return { ops, label: labels.join('; ') }
  }

  /** Where this project keeps Badge and refine-ui's data table (shadcn layout: ui/ and refine-ui/ side by side). */
  #context(): ColumnContext {
    const { root, uiDir, importBase } = this.#host
    const parentDir = path.posix.dirname(uiDir)
    const parentImport = importBase.slice(0, importBase.lastIndexOf('/'))
    const hasTable = fs.existsSync(path.join(root, parentDir, 'refine-ui', 'data-table', 'data-table-filter.tsx'))
    return { badge: `${importBase}/badge`, dataTable: hasTable ? `${parentImport}/refine-ui/data-table` : null }
  }

  async #manifest(): Promise<TriviaManifest | null> {
    try {
      return ((await this.#host.manifest()).manifest as TriviaManifest | null) ?? null
    } catch {
      return null
    }
  }

  async #scan(): Promise<string[]> {
    const { root, uiDir } = this.#host
    // shadcn's and refine-ui's own components hold no pages.
    const skip = new Set([uiDir, path.posix.join(path.posix.dirname(uiDir), 'refine-ui')])
    const found: string[] = []
    let read = 0
    const walk = async (dir: string): Promise<void> => {
      let entries: fs.Dirent[]
      try {
        entries = await fsp.readdir(path.join(root, dir), { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (read >= MAX_SCAN) return
        const rel = path.posix.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name) && !skip.has(rel)) await walk(rel)
        } else if (/\.(tsx|jsx)$/.test(entry.name)) {
          read += 1
          const text = await fsp.readFile(path.join(root, rel), 'utf8').catch(() => '')
          if (/from\s+["']@refinedev\/react-table["']/.test(text) && text.includes('useTable')) found.push(rel)
        }
      }
    }
    await walk('src')
    return found
  }
}
