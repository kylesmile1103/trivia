// The Refine adapter (docs/product.md): reads Refine + shadcn pages through the engine's value
// descriptions and the contract manifest, and plans their edits as engine ops. It knows Refine;
// the engine does not. The HTTP routes (/refine/*) and the MCP tools use it.

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import type { TriviaManifest } from '@trivia/contract-sync'

import { ApiError } from '../engine.js'
import { type ColumnContext, columnFor, humanize } from './columns.js'
import { type PageDrift, pageDrift } from './drift.js'
import { formFieldFor, kebab } from './fields.js'
import { type FormPage, type OutlineNode, bodyFields, formPages } from './form.js'
import { PAGE_KINDS, type PageKind, pageFiles, supportedKinds } from './scaffold.js'
import { type ListPage, type ScopeValues, type ValueDesc, contractResource, fieldInfo, listPages, refineName } from './page.js'

export type { DriftCode, DriftFix, DriftIssue, PageDrift } from './drift.js'
export type { FormFieldInfo, FormPage } from './form.js'
export type { PageKind } from './scaffold.js'
export type { ColumnInfo, FieldInfo, ListPage } from './page.js'

/** A Refine page Trivia can edit: a list (columns) or a form (fields). */
export type Page = ListPage | FormPage

/** A change to a form page's fields. */
export type FieldChange =
  | { action: 'add'; field: string; index?: number; label?: string }
  | { action: 'remove'; field: string }
  | { action: 'move'; field: string; index: number }
  /** Re-generate a field from the contract where it is now, keeping its label (drift fixes). */
  | { action: 'rebuild'; field: string }

/** `changes` for a form from a request body, checked. */
export function parseFieldChanges(value: unknown): FieldChange[] {
  const bad = () =>
    new ApiError(
      'invalid_op',
      'changes must be a non-empty array of { action: "add", field, index?, label? }, { action: "remove", field }, { action: "move", field, index } or { action: "rebuild", field }',
    )
  if (!Array.isArray(value) || value.length === 0) throw bad()
  return value.map((c: unknown) => {
    if (typeof c !== 'object' || c === null) throw bad()
    const { action, field, index, label } = c as Record<string, unknown>
    const isIndex = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0
    if (typeof field !== 'string' || field === '') throw bad()
    if (action === 'add' && (index === undefined || isIndex(index)) && (label === undefined || typeof label === 'string')) {
      return { action, field, ...(index !== undefined ? { index: index as number } : {}), ...(label !== undefined ? { label: label as string } : {}) }
    }
    if (action === 'remove' || action === 'rebuild') return { action, field }
    if (action === 'move' && isIndex(index)) return { action, field, index: index as number }
    throw bad()
  })
}

/** A change to a list page's columns. */
export type ColumnChange =
  | { action: 'add'; field: string; index?: number; label?: string }
  | { action: 'remove'; column: string }
  | { action: 'move'; column: string; index: number }
  /** Re-generate a column from the contract where it is now, keeping its label (drift fixes). */
  | { action: 'rebuild'; column: string }

/** `changes` from a request body, checked. */
export function parseColumnChanges(value: unknown): ColumnChange[] {
  const bad = () =>
    new ApiError(
      'invalid_op',
      'changes must be a non-empty array of { action: "add", field, index?, label? }, { action: "remove", column }, { action: "move", column, index } or { action: "rebuild", column }',
    )
  if (!Array.isArray(value) || value.length === 0) throw bad()
  return value.map((c: unknown) => {
    if (typeof c !== 'object' || c === null) throw bad()
    const { action, field, column, index, label } = c as Record<string, unknown>
    const isIndex = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0
    if (action === 'add' && typeof field === 'string' && (index === undefined || isIndex(index)) && (label === undefined || typeof label === 'string')) {
      return { action, field, ...(index !== undefined ? { index: index as number } : {}), ...(label !== undefined ? { label: label as string } : {}) }
    }
    if ((action === 'remove' || action === 'rebuild') && typeof column === 'string') return { action, column }
    if (action === 'move' && typeof column === 'string' && isIndex(index)) return { action, column, index: index as number }
    throw bad()
  })
}

/** A contract resource, and which of its Refine pages exist. */
export interface ResourcePages {
  /** The manifest resource (`Customer`). */
  resource: string
  /** Its Refine resource name (`customers`). */
  name: string
  /** Pages registered for it in `<Refine resources>`. */
  existing: PageKind[]
  /** Pages its contract operations support. */
  possible: PageKind[]
}

/** Where the app registers resources and routes. */
interface AppShell {
  file: string
  scope: string
  resourcesPath: string
  resources: ValueDesc | undefined
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
  manifest(): Promise<{ manifest: unknown; drift?: unknown }>
  /** The JSX trees of a file (engine outline). */
  outline(file: string): unknown[]
  /** An element's details (engine inspect): its attributes are what the adapter reads. */
  inspect(locator: string): unknown
  /** The value at a value path (engine describeValue). */
  describeValue?(path: string): unknown
}

/** The `<Refine resources>` entry named `name`. */
function entryOf(resources: ValueDesc | undefined, name: string): ValueDesc | undefined {
  if (resources?.kind !== 'array') return undefined
  return resources.elements.find((e) => e.kind === 'object' && e.properties.some((p) => p.key === 'name' && p.value.kind === 'string' && p.value.value === name))
}

/** The page kinds a resource entry registers (`list: "/customers"`…). */
function registered(resources: ValueDesc | undefined, name: string): PageKind[] {
  const entry = entryOf(resources, name)
  if (entry?.kind !== 'object') return []
  return PAGE_KINDS.filter((k) => entry.properties.some((p) => p.key === k))
}

function findNode(nodes: OutlineNode[], test: (n: OutlineNode) => boolean): OutlineNode | null {
  for (const n of nodes) {
    if (test(n)) return n
    const inner = findNode(n.children, test)
    if (inner) return inner
  }
  return null
}

/** Most files a page scan reads. */
const MAX_SCAN = 2000
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build'])

export class RefineAdapter {
  readonly #host: RefineHost

  constructor(host: RefineHost) {
    this.#host = host
  }

  /** The pages of one file: lists and forms. */
  async page(file: string): Promise<Page[]> {
    if (!file) throw new ApiError('invalid_op', 'missing file (project-relative, e.g. src/pages/customers/list.tsx)')
    return this.#pagesOf(file, await this.#manifest())
  }

  /** Every Refine page under src/ (files that import @refinedev/react-table or react-hook-form). */
  async pages(): Promise<Page[]> {
    const manifest = await this.#manifest()
    const out: Page[] = []
    for (const file of await this.#scan()) {
      try {
        out.push(...this.#pagesOf(file, manifest))
      } catch {
        // A file that doesn't parse right now (mid-edit) is skipped, not fatal for the list.
      }
    }
    return out
  }

  /** Every contract resource with the Refine pages it has and could have (docs/product.md, slice 4). */
  async resources(): Promise<ResourcePages[]> {
    const manifest = await this.#manifest()
    if (!manifest) return []
    const app = await this.#app()
    return manifest.resources.map((r) => {
      const name = refineName(r)
      return { resource: r.name, name, existing: app ? registered(app.resources, name) : [], possible: supportedKinds(r) }
    })
  }

  /**
   * The ops that add `kinds` (default: every kind the contract supports that is not there yet)
   * of pages for a contract resource: the page files, its `<Refine resources>` entry, and routes.
   */
  async planPages(resourceName: string, kinds?: PageKind[]): Promise<Plan> {
    const manifest = await this.#manifest()
    const resource = contractResource(manifest, resourceName, null)
    if (!resource) {
      throw new ApiError('node_not_found', `the contract has no resource \`${resourceName}\` (it has ${manifest?.resources.map((r) => r.name).join(', ') ?? 'none: run contract-sync'})`)
    }
    const app = await this.#app()
    if (!app) throw new ApiError('unsupported', 'no file under src/ renders <Refine resources={[…]}>: Trivia adds pages to an existing Refine app')
    const name = refineName(resource)
    const existing = registered(app.resources, name)
    const supported = supportedKinds(resource)
    const wanted = (kinds ?? supported.filter((k) => !existing.includes(k))).filter((k, i, all) => all.indexOf(k) === i)
    for (const kind of wanted) {
      if (!PAGE_KINDS.includes(kind)) throw new ApiError('invalid_op', `unknown page kind \`${kind}\` (list, create, edit or show)`)
      if (!supported.includes(kind)) throw new ApiError('unsupported', `${resource.name}'s contract has no operation for a ${kind} page`)
      if (existing.includes(kind)) throw new ApiError('conflict', `${name} already has a ${kind} page`)
    }
    if (wanted.length === 0) throw new ApiError('conflict', `${name} already has every page its contract supports (${existing.join(', ')})`)

    const { root, uiDir, importBase } = this.#host
    const parentDir = path.posix.dirname(uiDir)
    const parentImport = importBase.slice(0, importBase.lastIndexOf('/'))
    const hasRefineUi = fs.existsSync(path.join(root, parentDir, 'refine-ui', 'views'))
    const pagesDir = await this.#pagesDir()
    const srcImport = parentImport.slice(0, parentImport.lastIndexOf('/')) || '@'
    const files = pageFiles(resource, wanted, {
      ui: importBase,
      refineUi: hasRefineUi ? `${parentImport}/refine-ui` : null,
      typesImport: manifest!.modules.types?.importPath ?? '@/api/generated/types.gen',
      pagesDir,
      pagesImport: `${srcImport}/${pagesDir.split('/').slice(1).join('/')}`,
    })
    for (const f of files) {
      if (fs.existsSync(path.join(root, f.file))) throw new ApiError('conflict', `${f.file} already exists; Trivia doesn't overwrite files`)
    }
    const ops: Plan['ops'] = files.map((f) => ({ op: 'createFile', file: f.file, content: f.content }))

    // The resource entry: new keys on the existing one, or a new entry.
    const routes = Object.fromEntries(files.map((f) => [f.kind, f.route]))
    if (entryOf(app.resources, name)) {
      for (const kind of PAGE_KINDS.filter((k) => routes[k])) {
        ops.push({ op: 'setProperty', path: `${app.resourcesPath}[name=${name}]`, prop: kind, value: JSON.stringify(routes[kind]) })
      }
    } else {
      const keys = [`name: ${JSON.stringify(name)}`, ...PAGE_KINDS.filter((k) => routes[k]).map((k) => `${k}: ${JSON.stringify(routes[k])}`)]
      ops.push({ op: 'insertElement', path: app.resourcesPath, value: `{\n  ${keys.join(',\n  ')},\n}` })
    }

    // The routes: before the catch-all among the resource routes, else after the last of them.
    const anchor = this.#routeAnchor(app)
    if (!anchor) throw new ApiError('unsupported', `${app.file} has no <Route path="…"> to put the new routes next to`)
    files.forEach((f, i) => {
      // Before the catch-all, each insert pushes it one further; after the last route, each new
      // one is the next anchor. Either way the i-th insert names slot index + i.
      ops.push({
        op: 'insert',
        target: `${anchor.parent}.${anchor.index + i}`,
        expectedName: 'Route',
        placement: anchor.placement,
        snippet: `<Route path="${f.route}" element={<${f.component} />} />`,
        imports: [{ name: f.component, source: f.importPath }],
      })
    })
    return { ops, label: `Add ${wanted.join(', ')} ${wanted.length === 1 ? 'page' : 'pages'} for ${humanize(name)}` }
  }

  /** The file and component rendering `<Refine resources>`. */
  async #app(): Promise<AppShell | null> {
    const { root } = this.#host
    const candidates: string[] = []
    const walk = async (dir: string): Promise<void> => {
      let entries: fs.Dirent[]
      try {
        entries = await fsp.readdir(path.join(root, dir), { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const rel = path.posix.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name) && rel.split('/').length < 4) await walk(rel)
        } else if (/\.(tsx|jsx)$/.test(entry.name)) {
          const text = await fsp.readFile(path.join(root, rel), 'utf8').catch(() => '')
          if (/<Refine[\s>]/.test(text) && /resources=\{/.test(text)) candidates.push(rel)
        }
      }
    }
    await walk('src')
    for (const file of candidates.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))) {
      const refine = findNode(this.#host.outline(file) as OutlineNode[], (n) => n.name === 'Refine')
      if (!refine) continue
      const scope = refine.locator.split('#').at(-2)!
      const resourcesPath = `${file}#${scope}#<Refine>.resources`
      let resources: ValueDesc | undefined
      try {
        resources = this.#host.describeValue?.(resourcesPath) as ValueDesc | undefined
      } catch {
        resources = undefined
      }
      return { file, scope, resourcesPath, resources }
    }
    return null
  }

  /** Where new routes go: before `<Route path="*">` next to the resource routes, else after the last route with a path. */
  #routeAnchor(app: AppShell): { parent: string; index: number; placement: 'before' | 'after' } | null {
    const outline = this.#host.outline(app.file) as OutlineNode[]
    const routes: Array<{ locator: string; path: string }> = []
    const walk = (nodes: OutlineNode[]) => {
      for (const n of nodes) {
        if (n.name === 'Route') {
          const attrs = ((this.#host.inspect(n.locator) as { attributes?: Array<{ name: string; value: unknown }> }).attributes ?? [])
          const p = attrs.find((a) => a.name === 'path')?.value
          if (typeof p === 'string') routes.push({ locator: n.locator, path: p })
        }
        walk(n.children)
      }
    }
    walk(outline)
    const resourceRoutes = routes.filter((r) => r.path.startsWith('/'))
    const last = resourceRoutes.at(-1)
    if (!last) return null
    const parent = last.locator.slice(0, last.locator.lastIndexOf('.'))
    const slot = (loc: string) => Number(loc.slice(loc.lastIndexOf('.') + 1))
    const catchAll = routes.find((r) => r.path === '*' && r.locator.slice(0, r.locator.lastIndexOf('.')) === parent)
    return catchAll ? { parent, index: slot(catchAll.locator), placement: 'before' } : { parent, index: slot(last.locator), placement: 'after' }
  }

  /** The folder pages live in: next to the existing list pages, else src/pages. */
  async #pagesDir(): Promise<string> {
    const lists = (await this.pages()).filter((p) => p.kind === 'list')
    const dir = lists[0]?.file.split('/').slice(0, -2).join('/')
    return dir || 'src/pages'
  }

  /**
   * Where the pages are out of step with the contract (docs/product.md, slice 3), with fixes,
   * and whether the spec itself changed since the last sync (`spec`: then sync first).
   */
  async drift(): Promise<{ spec: unknown; pages: PageDrift[] }> {
    const state = await this.#host.manifest().catch(() => ({ manifest: null, drift: null }))
    const manifest = (state.manifest as TriviaManifest | null) ?? null
    const out: PageDrift[] = []
    for (const page of await this.pages()) {
      const resource = page.contract ? contractResource(manifest, page.contract.resource, null) : null
      let fields = null
      let required: string[] = []
      const sources = new Map<string, string>()
      if (page.kind === 'list') {
        fields = resource?.entity?.fields.map(fieldInfo) ?? null
        for (const c of page.columns) if (c.key && c.headerSource) sources.set(c.key, c.headerSource)
      } else if (resource && page.contract) {
        const body = bodyFields(resource, page.contract.operation)
        fields = body?.map(fieldInfo) ?? null
        required = (body ?? []).filter((f) => f.required).map((f) => f.name)
        for (const f of page.fields) if (f.renderSource) sources.set(f.name, f.renderSource)
      }
      const drift = pageDrift(page, { fields, required }, sources)
      if (drift.issues.length > 0) out.push(drift)
    }
    return { spec: state.drift ?? null, pages: out }
  }

  #pagesOf(file: string, manifest: TriviaManifest | null): Page[] {
    const scopes = this.#host.describeValues(file) as ScopeValues[]
    const forms = formPages(file, scopes, manifest, {
      outline: (f) => this.#host.outline(f) as OutlineNode[],
      attributes: (locator) => ((this.#host.inspect(locator) as { attributes?: unknown[] }).attributes ?? []) as Array<{ name: string; source: string; value: unknown }>,
    })
    return [...listPages(file, scopes, manifest), ...forms].sort((a, b) => a.line - b.line)
  }

  /** The ops for changes to the fields of the form page in `file`. */
  async planFields(file: string, component: string | undefined, changes: FieldChange[]): Promise<Plan> {
    if (changes.length === 0) throw new ApiError('invalid_op', 'changes must not be empty')
    const forms = (await this.page(file)).filter((p): p is FormPage => p.kind === 'form')
    const page = component ? forms.find((p) => p.component === component) : forms[0]
    if (!page) {
      throw new ApiError(
        'node_not_found',
        component ? `${file} has no form in \`${component}\`` : `${file} has no Refine form (a component calling useForm with a zodResolver)`,
      )
    }
    if (!component && forms.length > 1) {
      throw new ApiError('invalid_op', `${file} has ${forms.length} forms (${forms.map((p) => p.component).join(', ')}); pass component`)
    }
    const manifest = await this.#manifest()
    const resource = contractResource(manifest, page.contract?.resource ?? page.resource?.name ?? null, null)
    const body = resource && page.contract ? bodyFields(resource, page.contract.operation) : null
    const context = { ui: this.#host.importBase, idPrefix: kebab(resource?.name ?? page.resource?.name ?? 'field') }

    // The form's Controllers as the changes so far leave them. A Controller's locator is its
    // position among its parent's children, so each insert, removal or move renumbers the ones
    // after it: tracked here so a later change in the same plan names the right element.
    type Control = { name: string; locator: string }
    let controls: Control[] = page.fields.flatMap((f) => (f.control ? [{ name: f.name, locator: f.control.locator }] : []))
    const parent = (loc: string) => loc.slice(0, loc.lastIndexOf('.'))
    const slot = (loc: string) => Number(loc.slice(loc.lastIndexOf('.') + 1))
    const at = (loc: string, i: number) => `${parent(loc)}.${i}`
    const siblings = controls.every((c) => parent(c.locator) === parent(controls[0]!.locator))
    if (changes.length > 1 && !siblings) {
      throw new ApiError('unsupported', `${page.component}'s Controllers are not all in one parent; make one change at a time`)
    }
    const shift = (from: number, by: number) => {
      controls = controls.map((c) => (slot(c.locator) >= from ? { ...c, locator: at(c.locator, slot(c.locator) + by) } : c))
    }
    const schema = new Set(page.fields.filter((f) => f.rule !== null).map((f) => f.name))
    const defaults = new Set(page.fields.filter((f) => f.hasDefault).map((f) => f.name))
    const ops: Plan['ops'] = []
    const labels: string[] = []
    const step = (change: FieldChange): void => {
      switch (change.action) {
        case 'rebuild': {
          // Resolved here, against the form as it now is: a fix computed earlier may hold an
          // index that edits since have made stale.
          const index = controls.findIndex((c) => c.name === change.field)
          if (index < 0) throw new ApiError('node_not_found', `${page.component} renders no \`${change.field}\` field to rebuild`)
          const label = page.fields.find((f) => f.name === change.field)?.label ?? undefined
          step({ action: 'remove', field: change.field })
          step({ action: 'add', field: change.field, index, ...(label ? { label } : {}) })
          labels.splice(-2, 2, `Rebuild field ${label ?? humanize(change.field)}`)
          break
        }
        case 'add': {
          const field = body?.find((f) => f.name === change.field)
          if (!field) {
            throw new ApiError(
              'invalid_op',
              body
                ? `the ${page.contract?.operation} body of ${resource?.name} has no field \`${change.field}\` (it has ${body.map((f) => f.name).join(', ')})`
                : `${page.component} sends no contract request body, so there are no fields to add (run contract-sync, or set refineCoreProps.resource and action)`,
            )
          }
          if (schema.has(field.name) || controls.some((c) => c.name === field.name)) {
            throw new ApiError('conflict', `${page.component} already has a \`${field.name}\` field`)
          }
          const label = change.label ?? humanize(field.name)
          const snippet = formFieldFor(field, context, label)
          if (page.schemaPath) ops.push({ op: 'setProperty', path: page.schemaPath, prop: field.name, value: snippet.rule })
          if (page.defaultsPath) ops.push({ op: 'setProperty', path: page.defaultsPath, prop: field.name, value: snippet.defaultValue })
          schema.add(field.name)
          defaults.add(field.name)
          const index = change.index ?? controls.length
          if (index > controls.length) throw new ApiError('invalid_op', `index ${index} is out of range: ${page.component} has ${controls.length} fields`)
          if (controls.length === 0) {
            if (!page.container) throw new ApiError('unsupported', `${page.component} has no <FieldGroup> or <form> to put a field in`)
            ops.push({ op: 'insertChild', parent: page.container.locator, expectedName: page.container.name, index: 0, snippet: snippet.controller, imports: snippet.imports })
            controls = [{ name: field.name, locator: `${page.container.locator}.0` }]
          } else if (index < controls.length) {
            const before = controls[index]!
            ops.push({ op: 'insert', target: before.locator, expectedName: 'Controller', placement: 'before', snippet: snippet.controller, imports: snippet.imports })
            shift(slot(before.locator), 1)
            controls.splice(index, 0, { name: field.name, locator: at(before.locator, slot(before.locator) - 1) })
          } else {
            const last = controls[controls.length - 1]!
            ops.push({ op: 'insert', target: last.locator, expectedName: 'Controller', placement: 'after', snippet: snippet.controller, imports: snippet.imports })
            shift(slot(last.locator) + 1, 1)
            controls.push({ name: field.name, locator: at(last.locator, slot(last.locator) + 1) })
          }
          labels.push(`Add field ${label}`)
          break
        }
        case 'remove': {
          const control = controls.find((c) => c.name === change.field)
          if (!control && !schema.has(change.field) && !defaults.has(change.field)) {
            throw new ApiError('node_not_found', `${page.component} has no \`${change.field}\` field (it has ${page.fields.map((f) => f.name).join(', ')})`)
          }
          if (control) {
            ops.push({ op: 'remove', target: control.locator, expectedName: 'Controller' })
            controls = controls.filter((c) => c !== control)
            shift(slot(control.locator) + 1, -1)
          }
          if (defaults.delete(change.field) && page.defaultsPath) ops.push({ op: 'removeProperty', path: page.defaultsPath, prop: change.field })
          if (schema.delete(change.field) && page.schemaPath) ops.push({ op: 'removeProperty', path: page.schemaPath, prop: change.field })
          labels.push(`Remove field ${humanize(change.field)}`)
          break
        }
        case 'move': {
          const from = controls.findIndex((c) => c.name === change.field)
          if (from < 0) throw new ApiError('node_not_found', `${page.component} renders no \`${change.field}\` field to move`)
          if (change.index >= controls.length) throw new ApiError('invalid_op', `index ${change.index} is out of range: ${page.component} has ${controls.length} fields`)
          if (change.index === from) break
          const moved = controls[from]!
          const target = controls[change.index]!
          const placement = change.index < from ? 'before' : 'after'
          ops.push({ op: 'move', source: moved.locator, expectedName: 'Controller', target: target.locator, expectedTargetName: 'Controller', placement })
          // Out of its slot, then into the target's (before) or the one after it (after).
          const out = slot(moved.locator)
          controls.splice(from, 1)
          shift(out + 1, -1)
          const t = slot(controls[placement === 'before' ? change.index : change.index - 1]!.locator)
          const into = placement === 'before' ? t : t + 1
          shift(into, 1)
          controls.splice(change.index, 0, { ...moved, locator: at(moved.locator, into) })
          labels.push(`Move field ${humanize(change.field)}`)
          break
        }
        default:
          throw new ApiError('invalid_op', `unknown field change ${JSON.stringify(change)} (add, remove, move or rebuild)`)
      }
    }
    for (const change of changes) step(change)
    return { ops, label: labels.join('; ') }
  }

  /** The ops for one column change on the list page in `file` (its `component`, when it has several). */
  async planColumns(file: string, component: string | undefined, changes: ColumnChange[]): Promise<Plan> {
    if (changes.length === 0) throw new ApiError('invalid_op', 'changes must not be empty')
    const pages = (await this.page(file)).filter((p): p is ListPage => p.kind === 'list')
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
    const columns: Array<{ keys: string[]; path: string; label: string; data: boolean }> = page.columns.map((c) => ({
      keys: [c.key, c.accessorKey].filter((k): k is string => k !== null),
      path: c.path,
      label: c.label ?? c.key ?? 'column',
      data: c.field !== null,
    }))
    // Without an index, a new column goes after the last one showing a field: before trailing
    // columns such as row actions.
    const after = () => {
      let i = columns.length
      while (i > 0 && !columns[i - 1]!.data) i -= 1
      return i === 0 ? columns.length : i
    }
    const find = (key: string) => {
      const column = columns.find((c) => c.keys.includes(key))
      if (!column) {
        const keys = columns.map((c) => c.keys[0] ?? '(no id)').join(', ')
        throw new ApiError('node_not_found', `${page.component} has no column \`${key}\` (it has ${keys})`)
      }
      return column
    }
    const shown = (name: string) => columns.some((c) => c.keys.includes(name))
    const step = (change: ColumnChange): void => {
      switch (change.action) {
        case 'rebuild': {
          // Resolved here, against the page as it now is (see planFields).
          const column = find(change.column)
          const index = columns.indexOf(column)
          const field = page.columns.find((c) => c.path === column.path)?.accessorKey ?? change.column
          const label = column.label
          step({ action: 'remove', column: change.column })
          step({ action: 'add', field, index, label })
          labels.splice(-2, 2, `Rebuild column ${label}`)
          break
        }
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
          const at = change.index ?? after()
          if (at > columns.length) throw new ApiError('invalid_op', `index ${at} is out of range: ${page.component} has ${columns.length} columns`)
          columns.splice(at, 0, { keys: [field.name], path: `${page.columnsPath}[id=${field.name}]`, label, data: true })
          ops.push({ op: 'insertElement', path: page.columnsPath, index: at, value: column.value, imports: column.imports })
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
          throw new ApiError('invalid_op', `unknown column change ${JSON.stringify(change)} (add, remove, move or rebuild)`)
      }
    }
    for (const change of changes) step(change)
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
          if (/from\s+["']@refinedev\/react-(table|hook-form)["']/.test(text)) found.push(rel)
        }
      }
    }
    await walk('src')
    return found
  }
}
