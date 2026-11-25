// The Refine adapter (docs/product.md): reads Refine + shadcn pages through the engine's value
// descriptions and the contract manifest, and plans their edits as engine ops. It knows Refine;
// the engine does not. The HTTP routes (/refine/*) and the MCP tools use it.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { projectFacts, relativeModule, resourceOps, restyleModule, routeOps, type EjectPage, type EmittedModule, type RouteRegistration } from '@trivia/blueprint-compiler'
import type { TriviaManifest } from '@trivia/contract-sync'

import type { AppRoute } from '../api/service.js'
import { ApiError } from '../engine.js'
import type { DevHost, PreviewHost } from '../host.js'
import { type ColumnContext, columnFor, humanize } from './columns.js'
import { type PageDrift, pageDrift } from './drift.js'
import { type FormStyle, formFieldFor, kebab } from './fields.js'
import { type ControlElement, type FormPage, type OutlineNode, bodyFields, formPages } from './form.js'
import { alignOps, hasDiff, ruleDiff } from './rules.js'
import { PAGE_KINDS, type PageKind, type ScaffoldContext, generateRefinePage, supportedKinds } from './scaffold.js'
import { type ListPage, type Mention, type ScopeValues, type ValueDesc, contractResource, fieldInfo, listPages, refineName } from './page.js'

export type { DriftCode, DriftFix, DriftIssue, PageDrift } from './drift.js'
export type { FormFieldInfo, FormPage } from './form.js'
export type { PageKind } from './scaffold.js'
export type { ChainCall, ColumnInfo, FieldInfo, ListPage, Mention } from './page.js'

/** A Refine page Trivia can edit: a list (columns) or a form (fields). */
export type Page = ListPage | FormPage

/** A change to a form page's fields. */
export type FieldChange =
  | { action: 'add'; field: string; index?: number; label?: string }
  | { action: 'remove'; field: string }
  | { action: 'move'; field: string; index: number }
  /** Re-generate a field from the contract where it is now, keeping its label (drift fixes). */
  | { action: 'rebuild'; field: string }
  /**
   * Bring a field's zod rule in line with the contract in place: its bounds, and `.optional()`/
   * `.nullable()` where the contract no longer allows them (drift fixes, slice 5).
   */
  | { action: 'align'; field: string }

/** `changes` for a form from a request body, checked. */
export function parseFieldChanges(value: unknown): FieldChange[] {
  const bad = () =>
    new ApiError(
      'invalid_op',
      'changes must be a non-empty array of { action: "add", field, index?, label? }, { action: "remove", field }, { action: "move", field, index }, { action: "rebuild", field } or { action: "align", field }',
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
    if (action === 'remove' || action === 'rebuild' || action === 'align') return { action, field }
    if (action === 'move' && isIndex(index)) return { action, field, index: index as number }
    throw bad()
  })
}

/** A preview or eject request from a request body, checked. */
export function parsePreviewRequest(body: Record<string, unknown>): PreviewRequest & { locator?: string } {
  const { resource, kind, hide, title, file, locator } = body
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string')
  const optional = (v: unknown) => v === undefined || (typeof v === 'string' && v !== '')
  if (
    typeof resource !== 'string' ||
    resource === '' ||
    !PAGE_KINDS.includes(kind as PageKind) ||
    (hide !== undefined && !strings(hide)) ||
    !optional(title) ||
    !optional(file) ||
    !optional(locator)
  ) {
    throw new ApiError(
      'invalid_op',
      'body must be { resource: string, kind: "list" | "create" | "edit" | "show", hide?: string[], title?: string, file?: string, locator?: string }',
    )
  }
  return {
    resource,
    kind: kind as PageKind,
    ...(hide ? { hide: hide as string[] } : {}),
    ...(title ? { title: title as string } : {}),
    ...(file ? { file: file as string } : {}),
    ...(locator ? { locator: locator as string } : {}),
  }
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

/** A page the inferencer asks for (docs/product.md, slice 6). */
export interface PreviewRequest {
  /** The Refine resource (`customers`) or the contract's (`Customer`). */
  resource: string
  kind: PageKind
  /** Contract fields to leave out. */
  hide?: string[]
  /** The view header's title. */
  title?: string
  /** Where eject writes it (project-relative, under src/); default: next to the other pages. */
  file?: string
}

/** A page generated from the contract for the inferencer to preview and eject. */
export interface InferredPage {
  /** The contract resource (`Customer`) and its Refine name (`customers`). */
  resource: string
  name: string
  kind: PageKind
  /** The component the file exports (`CustomerList`) and its import path. */
  component: string
  importPath: string
  /** Where eject writes it, and whether a file is there already (eject then refuses). */
  file: string
  exists: boolean
  /** The route Refine conventionally gives it. */
  route: string
  /** The module the inferencer imports to render it: this code, compiled by Vite. */
  module: string
  code: string
}

/** Where the plugin serves previews (`/@trivia/preview/<id>.tsx`). */
export const PREVIEW_PREFIX = '/@trivia/preview/'

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
  /** What the plan leaves for the developer to check, e.g. code that still names a removed field. */
  warnings?: string[]
}

/** What the adapter needs from the engine service. */
export interface RefineHost {
  root: string
  kind: DevHost['kind']
  /** shadcn's ui folder (project-relative) and its import prefix: `src/components/ui`, `@/components/ui`. */
  uiDir: string
  importBase: string
  preview: PreviewHost
  routes(): Promise<AppRoute[]>
  describeValues(file: string): unknown
  manifest(): Promise<{ manifest: unknown; drift?: unknown }>
  /** The JSX trees of a file (engine outline). */
  outline(file: string): unknown[]
  /** An element's details (engine inspect): its attributes are what the adapter reads. */
  inspect(locator: string): unknown
  /** The value at a value path (engine describeValue). */
  describeValue?(path: string): unknown
  /** Where a file names `name` (engine mentions). */
  mentions?(file: string, name: string): Mention[]
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
  /** The pages the inferencer asked to preview, by module id. */
  readonly #previews = new Map<string, () => Promise<{ code: string; blueprint?: EmittedModule }>>()

  async compileProject() {
    const app = await this.#app()
    const project = await this.#scaffoldContext('')
    const entrySource = app ? fs.readFileSync(path.join(this.#host.root, app.file), 'utf8') : ''
    const { root, uiDir } = this.#host
    const modules = (dir: string, prefix: string | null): string[] => {
      if (!prefix || dir.startsWith('..')) return []
      const base = path.join(root, dir)
      try {
        return fs.readdirSync(base, { withFileTypes: true, recursive: true })
          .filter((entry) => entry.isFile() && /\.(?:tsx?|jsx?)$/.test(entry.name))
          .map((entry) => prefix + '/' + path.relative(base, path.join(entry.parentPath, entry.name))
            .split(path.sep).join('/').replace(/\.(?:tsx?|jsx?)$/, ''))
      } catch {
        return []
      }
    }
    const installed = [
      ...modules(uiDir, project.ui),
      ...modules(path.posix.join(path.posix.dirname(uiDir), 'refine-ui'), project.refineUi),
    ]
    return { project, entrySource, installed }
  }

  async blueprintRouteAnchor(file?: string): Promise<{ file: string; target: string } | null> {
    const app = await this.#app()
    if (!app || (file !== undefined && file !== app.file)) return null
    const anchor = this.#routeAnchor(app)
    return anchor ? { file: app.file, target: anchor.parent + '.' + anchor.index } : null
  }

  blueprintPreview(id: string, build: () => Promise<EmittedModule>): void {
    this.#previews.set(id, async () => {
      const blueprint = await build()
      return { code: blueprint.code + '\nexport default ' + blueprint.component + '\n', blueprint }
    })
  }

  async previewSource(id: string): Promise<EmittedModule | undefined> {
    return id.startsWith('blueprint-') ? (await this.#previews.get(id)?.())?.blueprint : undefined
  }

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
    if (!app) {
      const where = this.#host.kind === 'vite' ? 'under src/' : 'in the project'
      throw new ApiError('unsupported', `no file ${where} renders <Refine resources={[…]}>: Trivia adds pages to an existing Refine app`)
    }
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

    const { root } = this.#host
    const nextRoutes = this.#host.kind === 'next' ? await this.#host.routes() : undefined
    const project = await this.#scaffoldContext(name, nextRoutes)
    const files = wanted.map((kind) => generateRefinePage({ resource, kind, project }))
    const claimed = new Set(nextRoutes?.map((route) => routePattern(route.path)))
    for (const file of files) {
      if (claimed.has(routePattern(file.route))) throw new ApiError('conflict', `${file.route} already has an App Router page`)
    }
    for (const f of files) {
      if (fs.existsSync(path.join(root, f.file))) throw new ApiError('conflict', `${f.file} already exists; Trivia doesn't overwrite files`)
    }
    const style = this.#host.kind === 'vite'
      ? projectFacts({ entrySource: fs.readFileSync(path.join(root, app.file), 'utf8') }).style : null
    const ops: Plan['ops'] = files.map((f) => ({
      op: 'createFile', file: f.file, content: style ? restyleModule(f.content, style) : f.content,
    }))

    ops.push(...this.#registrationOps(app, files.map((file) => ({ ...file, resource: name }))))
    return { ops, label: `Add ${wanted.join(', ')} ${wanted.length === 1 ? 'page' : 'pages'} for ${humanize(name)}` }
  }

  async planBlueprintRegistrations(pages: readonly EjectPage[], contract: TriviaManifest | null): Promise<Plan['ops']> {
    if (!pages.length) return []
    const app = await this.#app()
    if (!app) throw new ApiError('unsupported', 'The app needs a Refine resources array and React Router routes to eject pages.')
    const files = pages.map(({ page, module }): RouteRegistration => {
      if (page.kind === 'custom') return { ...module, importPath: relativeModule(app.file, module.file) }
      const resource = contractResource(contract, page.resource, null)
      if (!resource) throw new ApiError('invalid_result', 'No contract resource named ' + page.resource)
      return { ...module, kind: page.kind, resource: refineName(resource) }
    })
    return this.#registrationOps(app, files)
  }

  #registrationOps(app: AppShell, files: readonly RouteRegistration[]): Plan['ops'] {
    const byResource = new Map<string, Partial<Record<PageKind, string>>>()
    for (const file of files) {
      if (file.kind === undefined || file.resource === undefined) continue
      const routes = byResource.get(file.resource) ?? {}
      routes[file.kind] = file.route
      byResource.set(file.resource, routes)
    }
    const ops: Plan['ops'] = []
    if (byResource.size && app.resources?.kind !== 'array') {
      throw new ApiError('unsupported', 'The Refine resources prop must hold an array literal.')
    }
    for (const [name, routes] of byResource) {
      const entry = entryOf(app.resources, name)
      if (entry?.kind === 'object') {
        for (const kind of PAGE_KINDS) {
          const route = routes[kind]
          const existing = entry.properties.find(({ key }) => key === kind)
          if (!existing || route === undefined) continue
          if (existing.value.kind !== 'string' || existing.value.value !== route) {
            throw new ApiError('conflict', name + ' already registers a different ' + kind + ' page.')
          }
          delete routes[kind]
        }
      }
      ops.push(...resourceOps(app.resourcesPath, name, routes, entry !== undefined))
    }
    if (this.#host.kind === 'vite') {
      const anchor = this.#routeAnchor(app)
      if (!anchor) throw new ApiError('unsupported', app.file + ' has no React Router route to register the new pages beside.')
      ops.push(...routeOps(files, anchor))
    }
    return ops
  }

  /** Each `<Refine resources>` action that names a path: its resource, the action and the path. */
  async resourceRoutes(): Promise<Array<{ resource: string; action: string; path: string }>> {
    const resources = (await this.#app())?.resources
    if (resources?.kind !== 'array') return []
    return resources.elements.flatMap((r) => {
      if (r.kind !== 'object') return []
      const name = r.properties.find((p) => p.key === 'name')?.value
      if (name?.kind !== 'string') return []
      return ['list', 'create', 'edit', 'show', 'clone'].flatMap((action) => {
        const value = r.properties.find((p) => p.key === action)?.value
        return value?.kind === 'string' ? [{ resource: name.value, action, path: value.value }] : []
      })
    })
  }

  /** The file and component rendering `<Refine resources>`. */
  async #app(): Promise<AppShell | null> {
    const { root, kind } = this.#host
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
          if (!entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name) && entry.name !== '(blueprint-preview)' && (kind === 'next' || rel.split('/').length < 4)) await walk(rel)
        } else if ((kind !== 'next' || entry.isFile()) && /\.(tsx|jsx)$/.test(entry.name)) {
          const text = await fsp.readFile(path.join(root, rel), 'utf8').catch(() => '')
          if (/<Refine[\s>]/.test(text) && /resources=\{/.test(text)) candidates.push(rel)
        }
      }
    }
    await walk(kind === 'next' ? '.' : 'src')
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
    const last = resourceRoutes.at(-1) ?? routes.find((route) => route.path === '*')
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
      const drift = pageDrift(page, { fields, required }, sources, (name) =>
        page.kind === 'form' ? this.#leftover(page, name).map(({ line, text }) => ({ line, text })) : [],
      )
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
    const style = await this.#styleFor(page)
    const context = { ui: this.#host.importBase, idPrefix: kebab(resource?.name ?? page.resource?.name ?? 'field'), textarea: this.#hasUi('textarea'), style }

    // The form's controls as the changes so far leave them. A control's locator is its position
    // among its parent's children, so each insert, removal or move renumbers the elements after
    // it, and everything inside them (a field in a later grid row): tracked here by index-path
    // prefix, so a later change in the same plan names the right element.
    type Control = { name: string; locator: string; element: ControlElement; direct: boolean; parent: { locator: string; name: string } | null }
    let controls: Control[] = page.fields.flatMap((f) => (f.control ? [{ name: f.name, ...f.control }] : []))
    const split = (loc: string) => {
      const at = loc.lastIndexOf('#') + 1
      return { head: loc.slice(0, at), path: loc.slice(at).split('.').map(Number) }
    }
    let container = page.container
    /**
     * Shift by `by` every tracked locator (controls, their parents, the container) at or after
     * (an insert) or after (a removal) the slot `at` names, and everything inside them.
     */
    const renumber = (at: string, by: 1 | -1) => {
      const { head, path } = split(at)
      const depth = path.length - 1
      const from = path[depth]! + (by === -1 ? 1 : 0)
      const shift = (loc: string): string => {
        const l = split(loc)
        const inside = l.head === head && l.path.length > depth && path.slice(0, depth).every((seg, i) => l.path[i] === seg)
        if (!inside || l.path[depth]! < from) return loc
        const moved = [...l.path]
        moved[depth] = moved[depth]! + by
        return head + moved.join('.')
      }
      controls = controls.map((c) => ({ ...c, locator: shift(c.locator), parent: c.parent && { ...c.parent, locator: shift(c.parent.locator) } }))
      if (container) container = { ...container, locator: shift(container.locator) }
    }
    const sibling = (loc: string, placement: 'before' | 'after') => {
      const { head, path } = split(loc)
      return head + [...path.slice(0, -1), path.at(-1)! + (placement === 'after' ? 1 : 0)].join('.')
    }
    /**
     * Where a new field goes without an index (⚑ docs/product.md, slice 5): after the nearest
     * field before it in the contract, inside that field's own wrapper; else before the nearest
     * one after it; else after the last field. Guarded (non-direct) fields are never anchors.
     */
    const anchorFor = (name: string): { target: Control; placement: 'before' | 'after' } | null => {
      const order = (body ?? []).map((f) => f.name)
      const usable = controls.filter((c) => c.direct)
      const at = order.indexOf(name)
      for (let i = at - 1; i >= 0; i -= 1) {
        const target = usable.find((c) => c.name === order[i])
        if (target) return { target, placement: 'after' }
      }
      for (let i = at + 1; i < order.length; i += 1) {
        const target = usable.find((c) => c.name === order[i])
        if (target) return { target, placement: 'before' }
      }
      const last = usable.at(-1)
      return last ? { target: last, placement: 'after' } : null
    }
    const schema = new Set(page.fields.filter((f) => f.rule !== null).map((f) => f.name))
    const defaults = new Set(page.fields.filter((f) => f.hasDefault).map((f) => f.name))
    const ops: Plan['ops'] = []
    const labels: string[] = []
    const warnings: string[] = []
    // A rebuild removes and re-adds a field: its other mentions still have a field to name.
    const rebuilding = new Set<string>()
    /** Where a rebuilt field goes back: the slot it was removed from, at its place in the form's order. */
    type Slot = { parent: { locator: string; name: string }; index: number; order: number }
    const step = (change: FieldChange, slot?: Slot): void => {
      switch (change.action) {
        case 'rebuild': {
          // Resolved here, against the form as it now is: a fix computed earlier may hold an
          // index that edits since have made stale.
          const order = controls.findIndex((c) => c.name === change.field)
          const control = controls[order]
          if (!control) throw new ApiError('node_not_found', `${page.component} renders no \`${change.field}\` field to rebuild`)
          const label = page.fields.find((f) => f.name === change.field)?.label ?? undefined
          rebuilding.add(change.field)
          step({ action: 'remove', field: change.field })
          rebuilding.delete(change.field)
          const again: FieldChange = { action: 'add', field: change.field, ...(label ? { label } : {}) }
          step(again, control.parent ? { parent: control.parent, index: split(control.locator).path.at(-1)!, order } : undefined)
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
          if (change.index !== undefined && change.index > controls.length) {
            throw new ApiError('invalid_op', `index ${change.index} is out of range: ${page.component} has ${controls.length} fields`)
          }
          const anchor =
            change.index === undefined
              ? anchorFor(field.name)
              : change.index < controls.length
                ? { target: controls[change.index]!, placement: 'before' as const }
                : controls.length > 0
                  ? { target: controls[controls.length - 1]!, placement: 'after' as const }
                  : null
          const added: Control = { name: field.name, locator: '', element: snippet.element, direct: true, parent: null }
          if (slot) {
            // Back where it was, inside the same wrapper.
            ops.push({ op: 'insertChild', parent: slot.parent.locator, expectedName: slot.parent.name, index: slot.index, snippet: snippet.controller, imports: snippet.imports })
            added.locator = `${slot.parent.locator}.${slot.index}`
            added.parent = slot.parent
            renumber(added.locator, 1)
            controls.splice(slot.order, 0, added)
          } else if (!anchor) {
            if (!container) throw new ApiError('unsupported', `${page.component} has no <FieldGroup> or <form> to put a field in`)
            ops.push({ op: 'insertChild', parent: container.locator, expectedName: container.name, index: 0, snippet: snippet.controller, imports: snippet.imports })
            added.locator = `${container.locator}.0`
            added.parent = container
            renumber(added.locator, 1)
            controls = [added, ...controls]
          } else {
            const { target, placement } = anchor
            ops.push({ op: 'insert', target: target.locator, expectedName: target.element, placement, snippet: snippet.controller, imports: snippet.imports })
            added.locator = sibling(target.locator, placement)
            added.parent = target.parent
            renumber(added.locator, 1)
            const at = controls.indexOf(controls.find((c) => c.name === target.name)!)
            controls.splice(placement === 'before' ? at : at + 1, 0, added)
          }
          labels.push(`Add field ${label}`)
          break
        }
        case 'align': {
          const info = page.fields.find((f) => f.name === change.field)
          const field = body?.find((f) => f.name === change.field)
          if (!info?.rule || !field) {
            throw new ApiError('node_not_found', `${page.component} has no \`${change.field}\` rule from the contract to align (it has ${page.fields.map((f) => f.name).join(', ')})`)
          }
          const diff = ruleDiff(info.ruleChain, field)
          if (!page.schemaPath || !diff || !/^[A-Za-z_$][\w$]*$/.test(change.field)) {
            throw new ApiError('unsupported', `\`${change.field}\`'s rule \`${info.rule.slice(0, 60)}\` is not a zod chain Trivia can edit in place; rebuild the field instead`)
          }
          if (!hasDiff(diff)) throw new ApiError('conflict', `\`${change.field}\`'s rule already matches the contract`)
          ops.push(...alignOps(`${page.schemaPath}.${change.field}`, info.ruleChain!, diff))
          labels.push(`Update the ${info.label ?? humanize(change.field)} rule from the contract`)
          break
        }
        case 'remove': {
          const control = controls.find((c) => c.name === change.field)
          if (!control && !schema.has(change.field) && !defaults.has(change.field)) {
            throw new ApiError('node_not_found', `${page.component} has no \`${change.field}\` field (it has ${page.fields.map((f) => f.name).join(', ')})`)
          }
          const left = rebuilding.has(change.field) ? [] : this.#leftover(page, change.field)
          if (left.length > 0) {
            warnings.push(`${page.file} still mentions \`${change.field}\` outside its field: ${left.map((m) => `line ${m.line} (${m.text})`).join('; ')}`)
          }
          if (control) {
            ops.push({ op: 'remove', target: control.locator, expectedName: control.element })
            controls = controls.filter((c) => c !== control)
            renumber(control.locator, -1)
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
          ops.push({ op: 'move', source: moved.locator, expectedName: moved.element, target: target.locator, expectedTargetName: target.element, placement })
          // Out of its slot, then in next to the target, wherever that now is.
          controls.splice(from, 1)
          renumber(moved.locator, -1)
          const into = sibling(controls.find((c) => c.name === target.name)!.locator, placement)
          renumber(into, 1)
          controls.splice(change.index, 0, { ...moved, locator: into })
          labels.push(`Move field ${humanize(change.field)}`)
          break
        }
        default:
          throw new ApiError('invalid_op', `unknown field change ${JSON.stringify(change)} (add, remove, move or rebuild)`)
      }
    }
    for (const change of changes) step(change)
    return { ops, label: labels.join('; '), ...(warnings.length > 0 ? { warnings } : {}) }
  }

  /**
   * Where a form's file still names `name` outside the field's own pieces (its schema key, its
   * default, its control's `name="…"`): code that breaks or stops working when the field goes.
   */
  #leftover(page: FormPage, name: string): Mention[] {
    const info = page.fields.find((f) => f.name === name)
    const own = new Set([info?.ruleLine, info?.defaultLine].filter((l): l is number => l !== null && l !== undefined))
    try {
      return (this.#host.mentions?.(page.file, name) ?? []).filter((m) => !(m.kind === 'key' && own.has(m.line)))
    } catch {
      return []
    }
  }

  /**
   * The style a new field in `page` is written in (⚑ docs/product.md, slice 5): the one its
   * fields use; for an empty form, the project's, as long as a `<Form>` provider is there for
   * `FormField` to use.
   */
  async #styleFor(page: FormPage): Promise<FormStyle> {
    if (page.style) return page.style
    const project = await this.#projectStyle()
    return project === 'form' && !page.provider ? 'field' : project
  }

  /** The style most of the project's forms use; with none, the shadcn component it has (`field` first). */
  async #projectStyle(): Promise<FormStyle> {
    let field = 0
    let form = 0
    for (const p of await this.pages()) {
      if (p.kind !== 'form' || p.style === null) continue
      if (p.style === 'form') form += 1
      else field += 1
    }
    if (field !== form) return form > field ? 'form' : 'field'
    if (this.#hasUi('field')) return 'field'
    return this.#hasUi('form') ? 'form' : 'field'
  }

  /**
   * A page generated from the contract, as the inferencer previews it: the same generator as
   * `planPages`, with the request's options. Registers the request so that `previewModule`
   * can serve its code under `module` (docs/product.md, slice 6).
   */
  async preview(request: PreviewRequest): Promise<InferredPage> {
    const page = await this.#inferred(request)
    // Keyed by the contract's name: `customers` and `Customer` are one page.
    const key = normalized({ ...request, resource: page.resource })
    const id = createHash('sha256').update(JSON.stringify(key)).digest('hex').slice(0, 16)
    const module = await this.#host.preview.publish(id, page)
    this.#previews.set(id, () => this.#inferred(key))
    return { ...page, module }
  }

  /**
   * The code of the preview module `id` (`PREVIEW_PREFIX` + id + `.tsx`), generated afresh from
   * the contract as it now is; null for an id no preview registered. When the contract can no
   * longer give the page, the module throws why, for the inferencer to show.
   */
  async previewModule(id: string): Promise<string | null> {
    const request = this.#previews.get(id)
    if (!request) return null
    let code: string
    try {
      code = (await request()).code
    } catch (error) {
      return `throw new Error(${JSON.stringify(error instanceof Error ? error.message : String(error))});\n`
    }
    // The one line the preview has beyond the file Eject writes: Tailwind finds classes in files
    // on disk, and this page isn't one yet.
    return this.#tailwindEntry() === null ? code : `${code}\nimport "${PREVIEW_PREFIX}${id}.css";\n`
  }

  /**
   * The stylesheet of preview `id`: the utilities its classes need, built by the app's Tailwind
   * (v4) with the app's theme, since Tailwind doesn't see a page that isn't on disk. Null for an
   * unknown preview or an app without Tailwind v4.
   */
  async previewStyles(id: string): Promise<string | null> {
    const request = this.#previews.get(id)
    const entry = this.#tailwindEntry()
    if (!request || entry === null) return null
    let code = ''
    try {
      code = (await request()).code
    } catch {
      // The module says why; no classes to add.
    }
    const classes = [...new Set([...code.matchAll(/className=(["'])(.*?)\1/g)].flatMap((m) => m[2]!.split(/\s+/)).filter((c) => c !== '' && !/["\\]/.test(c)))]
    const reference = path.join(this.#host.root, entry).split(path.sep).join('/')
    return `@reference "${reference}";\n@import "tailwindcss/utilities.css" layer(utilities) source(none);\n@source inline("${classes.join(' ')}");\n`
  }

  #tailwind: string | null | undefined
  /** The app's Tailwind v4 entry stylesheet (the CSS under src/ that imports "tailwindcss"), project-relative. */
  #tailwindEntry(): string | null {
    if (this.#tailwind !== undefined) return this.#tailwind
    const found: string[] = []
    const walk = (dir: string, depth: number) => {
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(path.join(this.#host.root, dir), { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const rel = path.posix.join(dir, entry.name)
        if (entry.isDirectory() && depth < 3 && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) walk(rel, depth + 1)
        else if (entry.isFile() && entry.name.endsWith('.css') && /@import\s+["']tailwindcss["']/.test(fs.readFileSync(path.join(this.#host.root, rel), 'utf8'))) found.push(rel)
      }
    }
    walk('src', 0)
    this.#tailwind = found.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))[0] ?? null
    return this.#tailwind
  }

  /**
   * The ops that eject an inferred page: write its file and, given the inferencer's own
   * locator, put the page's component where the inferencer was (one undo entry).
   */
  async planEject(request: PreviewRequest & { locator?: string }): Promise<Plan> {
    const page = await this.#inferred(request)
    if (page.exists) throw new ApiError('conflict', `${page.file} already exists; Trivia doesn't overwrite files (pass another ejectPath)`)
    const ops: Plan['ops'] = [{ op: 'createFile', file: page.file, content: page.code }]
    const warnings: string[] = []
    const element = `<${page.component} />`
    if (request.locator) {
      const name = (this.#host.inspect(request.locator) as { name?: string }).name
      const spec = this.#host.kind === 'next'
        ? { name: page.component, default: true, source: relativeImport(request.locator, page.file) }
        : { name: page.component, source: page.importPath }
      ops.push({ op: 'replaceElement', target: request.locator, ...(name ? { expectedName: name } : {}), snippet: element, imports: [spec] })
    } else if (this.#host.kind === 'vite') {
      warnings.push(`Trivia doesn't know where the inferencer is rendered: replace it with ${element} (import { ${page.component} } from "${page.importPath}")`)
    }
    return { ops, label: `Eject ${page.component} to ${page.file}`, ...(warnings.length > 0 ? { warnings } : {}) }
  }

  async #inferred(request: PreviewRequest): Promise<Omit<InferredPage, 'module'>> {
    if (!PAGE_KINDS.includes(request.kind)) throw new ApiError('invalid_op', `unknown page kind \`${request.kind}\` (list, create, edit or show)`)
    const manifest = await this.#manifest()
    const resource = contractResource(manifest, request.resource, null)
    if (!resource) {
      throw new ApiError(
        'node_not_found',
        `the contract has no resource \`${request.resource}\` (it has ${manifest?.resources.map((r) => `${r.name} (${refineName(r)})`).join(', ') ?? 'none: run contract-sync'})`,
      )
    }
    if (!supportedKinds(resource).includes(request.kind)) {
      throw new ApiError('unsupported', `${resource.name}'s contract has no operation for a ${request.kind} page`)
    }
    const nextRoutes = this.#host.kind === 'next' ? await this.#host.routes() : undefined
    const project = await this.#scaffoldContext(refineName(resource), nextRoutes)
    const page = generateRefinePage({
      resource, kind: request.kind, project,
      options: { ...(request.hide && { hideFields: request.hide }), ...(request.title && { title: request.title }) },
    })
    let { file, importPath } = page
    if (request.file !== undefined) {
      if (!/^src\/(?:[\w.@-]+\/)*[\w.@-]+\.tsx$/.test(request.file) || request.file.split('/').some((p) => p === '..' || p === '.')) {
        throw new ApiError('invalid_op', `ejectPath must be a .tsx file under src/, e.g. src/pages/${refineName(resource)}/${request.kind}.tsx (got ${request.file})`)
      }
      file = request.file
      importPath = `${this.#srcImport()}/${file.slice('src/'.length, -'.tsx'.length)}`
    }
    return {
      resource: resource.name,
      name: refineName(resource),
      kind: request.kind,
      component: page.component,
      importPath,
      file,
      exists: fs.existsSync(path.join(this.#host.root, file)) ||
        (request.file === undefined && (nextRoutes?.some((route) => routePattern(route.path) === routePattern(page.route)) ?? false)),
      route: page.route,
      code: page.content,
    }
  }

  /** Where the project keeps what generated pages import (shadcn layout: ui/ and refine-ui/ side by side). */
  async #scaffoldContext(name: string, nextRoutes?: AppRoute[]): Promise<ScaffoldContext> {
    const { root, uiDir, importBase } = this.#host
    const parentDir = path.posix.dirname(uiDir)
    const parentImport = importBase.slice(0, importBase.lastIndexOf('/'))
    const hasRefineUi = fs.existsSync(path.join(root, parentDir, 'refine-ui', 'views'))
    const pagesDir = nextRoutes ? nextPagesDir(root, name, nextRoutes) : await this.#pagesDir()
    return {
      ui: importBase,
      refineUi: hasRefineUi ? `${parentImport}/refine-ui` : null,
      typesImport: (await this.#manifest())?.modules.types?.importPath ?? '@/api/generated/types.gen',
      pagesDir,
      ...(nextRoutes ? { appRouter: true } : {}),
      pagesImport: `${this.#srcImport()}/${pagesDir.split('/').slice(1).join('/')}`,
      textarea: this.#hasUi('textarea'),
      style: await this.#projectStyle(),
    }
  }

  /** The import prefix of `src/` (`@`), from shadcn's ui alias (`@/components/ui`). */
  #srcImport(): string {
    const parentImport = this.#host.importBase.slice(0, this.#host.importBase.lastIndexOf('/'))
    return parentImport.slice(0, parentImport.lastIndexOf('/')) || '@'
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

  /** True when the project has shadcn's `name` component (`ui/name.tsx`). */
  #hasUi(name: string): boolean {
    return fs.existsSync(path.join(this.#host.root, this.#host.uiDir, `${name}.tsx`))
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
          if (!entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name) && !skip.has(rel) && entry.name !== '(blueprint-preview)') await walk(rel)
        } else if ((this.#host.kind !== 'next' || entry.isFile()) && /\.(tsx|jsx)$/.test(entry.name)) {
          read += 1
          const text = await fsp.readFile(path.join(root, rel), 'utf8').catch(() => '')
          if (/from\s+["']@refinedev\/react-(table|hook-form)["']/.test(text)) found.push(rel)
        }
      }
    }
    await walk(this.#host.kind === 'next' ? '.' : 'src')
    return found
  }
}

/** A request with its options in one spelling, so equal requests share a module id. */
function normalized(request: PreviewRequest): PreviewRequest {
  return {
    resource: request.resource,
    kind: request.kind,
    ...(request.hide && request.hide.length > 0 ? { hide: [...new Set(request.hide)].sort() } : {}),
    ...(request.title ? { title: request.title } : {}),
    ...(request.file ? { file: request.file } : {}),
  }
}

/** A different dynamic parameter name still claims the same Next URL pattern. */
function routePattern(pathname: string): string {
  return pathname.replace(/\/:[^/]+/g, '/:')
}

function nextPagesDir(root: string, name: string, routes: AppRoute[]): string {
  const app = ['app', 'src/app'].find((dir) => fs.statSync(path.join(root, dir), { throwIfNoEntry: false })?.isDirectory())
  if (!app) throw new ApiError('unsupported', 'A Next App Router directory is required to add pages')
  const example = routes.find((route) => route.resource?.name === name)?.file ??
    routes.find((route) => route.resource !== null)?.file
  const dirs = [app]
  for (const segment of example?.slice(app.length + 1).split('/') ?? []) {
    if (!/^\(.*\)$/.test(segment)) break
    dirs.push(segment)
  }
  return dirs.join('/')
}

function relativeImport(locator: string, file: string): string {
  const source = locator.slice(0, locator.lastIndexOf('#', locator.lastIndexOf('#') - 1))
  const relative = path.posix.relative(path.posix.dirname(source), file.replace(/\.tsx$/, ''))
  return relative.startsWith('.') ? relative : `./${relative}`
}
