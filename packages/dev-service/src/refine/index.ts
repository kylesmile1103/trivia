// The Refine adapter (docs/product.md): reads Refine + shadcn pages through the engine's value
// descriptions and the contract manifest, and plans their edits as engine ops. It knows Refine;
// the engine does not. The HTTP routes (/refine/*) and the MCP tools use it.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { pageDocPath, type AppDoc, type Blueprint } from '@trivia/blueprint'
import { projectFacts, relativeModule, restyleModule, targetFor, type EjectPage, type EmittedModule, type ResourceRegistration, type RouteRegistration } from '@trivia/blueprint-compiler'
import type { TriviaManifest } from '@trivia/contract-sync'

import type { AppRoute } from '../api/service.js'
import { ApiError } from '../engine.js'
import type { DevHost, PreviewHost } from '../host.js'
import { type ColumnContext, columnFor, fieldShape, humanize } from './columns.js'
import { type PageDrift, pageDrift } from './drift.js'
import { type FormStyle, defaultValue, formFieldFor, kebab } from './fields.js'
import { type ControlElement, type FormPage, type OutlineNode, bodyFields, formPages } from './form.js'
import {
  type EnumSites,
  type OpaqueSite,
  type OptionItem,
  type OptionSite,
  arrayOps,
  isReadable,
  isStale,
  itemOps,
  opaqueWarning,
  optionEdits,
  readableSite,
  removedValues,
  shiftLocator,
  siblingLocator,
  siteName,
  splitLocator,
  values,
} from './options.js'
import { alignOps, hasDiff, ruleDiff } from './rules.js'
import { PAGE_KINDS, type PageKind, type ScaffoldContext, generateRefinePage, supportedKinds } from './scaffold.js'
import { type ColumnInfo, type ListPage, type Mention, type ScopeValues, type UnreadPage, type ValueDesc, contractResource, fieldInfo, listPages, refineName } from './page.js'

export type { DriftCode, DriftFix, DriftIssue, PageDrift } from './drift.js'
export type { FormFieldInfo, FormPage } from './form.js'
export type { PageKind } from './scaffold.js'
export type { ChainCall, ColumnInfo, FieldInfo, ListPage, Mention, UnreadPage } from './page.js'

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
   * Bring a field in line with the contract in place (drift fixes): its enum options (the
   * `z.enum([…])` array, the `<SelectItem>`s, a default naming a removed value; slice 3), its
   * zod rule's bounds, and `.optional()`/`.nullable()` where the contract no longer allows them
   * (slice 5).
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
  /** Bring a column's filter options in line with the contract in place (drift fixes, slice 3). */
  | { action: 'align'; column: string }

/** `changes` from a request body, checked. */
export function parseColumnChanges(value: unknown): ColumnChange[] {
  const bad = () =>
    new ApiError(
      'invalid_op',
      'changes must be a non-empty array of { action: "add", field, index?, label? }, { action: "remove", column }, { action: "move", column, index }, { action: "rebuild", column } or { action: "align", column }',
    )
  if (!Array.isArray(value) || value.length === 0) throw bad()
  return value.map((c: unknown) => {
    if (typeof c !== 'object' || c === null) throw bad()
    const { action, field, column, index, label } = c as Record<string, unknown>
    const isIndex = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0
    if (action === 'add' && typeof field === 'string' && (index === undefined || isIndex(index)) && (label === undefined || typeof label === 'string')) {
      return { action, field, ...(index !== undefined ? { index: index as number } : {}), ...(label !== undefined ? { label: label as string } : {}) }
    }
    if ((action === 'remove' || action === 'rebuild' || action === 'align') && typeof column === 'string') return { action, column }
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

/** A name a value path can take as a `.prop` step. */
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

/** At most this much of a source in a message. */
const clip = (source: string) => (source.length > 60 ? `${source.slice(0, 59)}…` : source)

/** Most files a page scan reads. */
const MAX_SCAN = 2000
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build'])

export class RefineAdapter {
  readonly #host: RefineHost
  /** The pages the inferencer asked to preview, by module id. */
  readonly #previews = new Map<string, () => Promise<{ code: string; blueprint?: EmittedModule }>>()

  async compileProject() {
    const app = await this.#app()
    const routes = this.#host.kind === 'next' ? await this.#host.routes() : undefined
    const project = await this.#scaffoldContext('', routes)
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

  /**
   * The Refine hook calls Trivia finds but cannot read as pages, with why: in `file`, or in every
   * page file under src/. Only calls of hooks the file imports from Refine count (a plain
   * react-hook-form dialog is no Refine page).
   */
  async unread(file?: string): Promise<UnreadPage[]> {
    const manifest = await this.#manifest()
    const out: UnreadPage[] = []
    for (const rel of file ? [file] : await this.#scan()) {
      const text = await fsp.readFile(path.join(this.#host.root, rel), 'utf8').catch(() => '')
      const refine = refineHooks(text)
      if (refine.size === 0) continue
      const found: UnreadPage[] = []
      try {
        this.#pagesOf(rel, manifest, found)
      } catch {
        continue // a file that doesn't parse right now (mid-edit) says nothing
      }
      out.push(...found.filter((u) => refine.has(u.hook)))
    }
    return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
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
    if (!app) throw new ApiError('unsupported', 'The app needs a Refine resources array to eject pages.')
    const files = pages.map(({ page, module }): RouteRegistration => {
      if (page.kind === 'custom') return { ...module, importPath: relativeModule(app.file, module.file) }
      const resource = contractResource(contract, page.resource, null)
      if (!resource) throw new ApiError('invalid_result', 'No contract resource named ' + page.resource)
      return { ...module, kind: page.kind, resource: refineName(resource) }
    })
    return this.#registrationOps(app, files)
  }

  async planBlueprintDecorations(
    doc: AppDoc, blueprint: Blueprint, registrations: readonly EjectPage[], contract: TriviaManifest | null,
  ): Promise<{ beforeRoutes: Plan['ops']; afterRoutes: Plan['ops']; warnings: string[] }> {
    const beforeRoutes: Plan['ops'] = []
    const afterRoutes: Plan['ops'] = []
    const warnings: string[] = []
    const tokens = Object.entries(doc.theme.tokens).sort(([a], [b]) => a < b ? -1 : a === b ? 0 : 1)
    if (!tokens.length && !doc.nav.length) return { beforeRoutes, afterRoutes, warnings }
    const app = await this.#app()
    const newResources = new Set(registrations.flatMap(({ page }) => {
      const resource = page.kind === 'custom' ? null : contractResource(contract, page.resource, null)
      return resource ? [refineName(resource)] : []
    }))
    const labelled = new Set<string>()
    for (const nav of doc.nav) {
      const entry = blueprint.docs[pageDocPath(nav.page)]
      const page = entry?.kind === 'page' ? entry.doc : null
      const resource = page && page.kind !== 'custom' ? contractResource(contract, page.resource, null) : null
      const name = resource && refineName(resource)
      const current = name ? entryOf(app?.resources, name) : undefined
      const meta = current?.kind === 'object' ? current.properties.find(({ key }) => key === 'meta')?.value : undefined
      if (!app || !name || (!current && !newResources.has(name)) || (meta && meta.kind !== 'object')) {
        warnings.push(`Nav label for ${nav.page} needs a Refine resource with literal metadata.`)
        continue
      }
      if (labelled.has(name)) {
        warnings.push(`Refine resource ${name} already has a nav label from another blueprint page.`)
        continue
      }
      labelled.add(name)
      const resourcePath = app.resourcesPath + '[name=' + name + ']'
      const label = JSON.stringify(nav.label)
      afterRoutes.push(meta
        ? { op: 'setProperty', path: resourcePath + '.meta', prop: 'label', value: label }
        : { op: 'setProperty', path: resourcePath, prop: 'meta', value: '{ label: ' + label + ' }' })
      if (nav.icon) warnings.push(`Nav icon for ${nav.page} needs a project icon import.`)
    }
    if (tokens.length) {
      const shape = (locator: string) => this.#host.inspect(locator) as {
        text: string | null; line: number; column: number; attributes: Array<{ name: string; value: unknown }>
      }
      const anchor = app && findNode(this.#host.outline(app.file) as OutlineNode[], (node) =>
        node.name === 'style' && shape(node.locator).attributes.some(({ name, value }) => name === 'id' && value === 'trivia-theme'))
      const details = anchor && shape(anchor.locator)
      const line = details && fs.readFileSync(path.join(this.#host.root, app!.file), 'utf8').split('\n')[details.line - 1]
      const empty = details && /^<style\s+id=(?:"trivia-theme"|'trivia-theme')\s*\/>/.test(line?.slice(details.column - 1) ?? '')
      if (!anchor || !details || (!empty && !/^:root \{ (?:--[a-z0-9-]+: [^{}]*; )+\}$/.test(details.text ?? ''))) {
        warnings.push('Theme tokens need a <style id="trivia-theme" /> anchor in the Refine app.')
      } else if (tokens.some(([, value]) => /[;{}<>\r\n\u2028\u2029]|\/\*/u.test(value))) {
        warnings.push('Theme tokens must contain single CSS values.')
      } else {
        const text = ':root { ' + tokens.map(([name, value]) => `--${name}: ${value};`).join(' ') + ' }'
        beforeRoutes.push({ op: 'setText', target: anchor.locator, expectedName: 'style', text })
      }
    }
    return { beforeRoutes, afterRoutes, warnings }
  }

  #registrationOps(app: AppShell, files: readonly RouteRegistration[]): Plan['ops'] {
    const byResource = new Map<string, Partial<Record<PageKind, string>>>()
    for (const file of files) {
      if (file.kind === undefined || file.resource === undefined) continue
      const routes = byResource.get(file.resource) ?? {}
      routes[file.kind] = file.route
      byResource.set(file.resource, routes)
    }
    const resources: ResourceRegistration[] = []
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
      resources.push({ path: app.resourcesPath, name, routes, exists: entry !== undefined })
    }
    if (this.#host.kind === 'next') return targetFor('next-refine').routeOps({ files, resources })
    const anchor = this.#routeAnchor(app)
    if (!anchor) throw new ApiError('unsupported', app.file + ' has no React Router route to register the new pages beside.')
    return targetFor('vite-refine').routeOps({ files, resources, anchor })
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
      if (page.kind === 'list') {
        fields = resource?.entity?.fields.map(fieldInfo) ?? null
      } else if (resource && page.contract) {
        const body = bodyFields(resource, page.contract.operation)
        fields = body?.map(fieldInfo) ?? null
        required = (body ?? []).filter((f) => f.required).map((f) => f.name)
      }
      // Where the page writes each contract enum's values, read as the plan that fixes it reads them.
      const enums = new Set((fields ?? []).filter((f) => f.shape === 'enum').map((f) => f.name))
      const sites = new Map<string, EnumSites>()
      if (page.kind === 'list') {
        for (const c of page.columns) {
          const name = c.accessorKey ?? c.key
          if (c.key && name && enums.has(name)) sites.set(c.key, this.#columnSites(c))
        }
      } else {
        const outline = this.#outlineOnce(page.file)
        for (const f of page.fields) if (enums.has(f.name)) sites.set(f.name, this.#fieldSites(page, f.name, outline))
      }
      const drift = pageDrift(
        page,
        { fields, required },
        sites,
        (name) => (page.kind === 'form' ? this.#leftover(page, name).map(({ line, text }) => ({ line, text })) : []),
        (removed, own) => this.#valueMentions(page.file, removed, own),
      )
      if (drift.issues.length > 0) out.push(drift)
    }
    return { spec: state.drift ?? null, pages: out }
  }

  #pagesOf(file: string, manifest: TriviaManifest | null, unread?: UnreadPage[]): Page[] {
    const scopes = this.#host.describeValues(file) as ScopeValues[]
    const forms = formPages(file, scopes, manifest, {
      outline: (f) => this.#host.outline(f) as OutlineNode[],
      attributes: (locator) => ((this.#host.inspect(locator) as { attributes?: unknown[] }).attributes ?? []) as Array<{ name: string; source: string; value: unknown }>,
    }, unread)
    return [...listPages(file, scopes, manifest, unread), ...forms].sort((a, b) => a.line - b.line)
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
    let container = page.container
    /**
     * Shift by `by` every tracked locator (controls, their parents, the container) at or after
     * (an insert) or after (a removal) the slot `at` names, and everything inside them.
     */
    const renumber = (at: string, by: 1 | -1) => {
      const shift = (loc: string) => shiftLocator(loc, at, by)
      controls = controls.map((c) => ({ ...c, locator: shift(c.locator), parent: c.parent && { ...c.parent, locator: shift(c.parent.locator) } }))
      if (container) container = { ...container, locator: shift(container.locator) }
    }
    const sibling = siblingLocator
    const split = splitLocator
    // Read from the files as they are on disk: the plan is applied after it is made.
    const outline = this.#outlineOnce(file)
    // Fields an earlier change in this plan added, removed, rebuilt or aligned: their option
    // sites were read before that change.
    const touched = new Set<string>()
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
          touched.add(field.name)
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
          const isEnum = field !== undefined && fieldShape(field) === 'enum'
          const noRule = () =>
            new ApiError('node_not_found', `${page.component} has no \`${change.field}\` rule from the contract to align (it has ${page.fields.map((f) => f.name).join(', ')})`)
          // An enum field's options may be in its control alone.
          if (!info || !field || (!info.rule && !isEnum)) throw noRule()
          if (touched.has(change.field)) {
            throw new ApiError('conflict', `\`${change.field}\` changed earlier in this plan; align it in a plan of its own`)
          }
          touched.add(change.field)
          const label = info.label ?? humanize(change.field)
          // Its enum options, where the form writes them (⚑ docs/product.md, slice 3).
          const contract = (field.enum ?? []).filter((v): v is string => typeof v === 'string')
          const sites: EnumSites = isEnum ? this.#fieldSites(page, change.field, outline) : {}
          const stale = [sites.rule, sites.items].filter(isReadable).filter((site) => isStale(site, contract))
          const blocked = stale.find((site) => site.state === 'blocked')
          if (blocked) {
            throw new ApiError('unsupported', `${siteName(label, blocked)} cannot be edited in place (${blocked.why}); rebuild the field instead`)
          }
          const diff = info.rule ? ruleDiff(info.ruleChain, field) : null
          const ruleOps = page.schemaPath && hasDiff(diff) && IDENTIFIER.test(change.field) ? alignOps(`${page.schemaPath}.${change.field}`, info.ruleChain!, diff) : []
          if (stale.length === 0) {
            // Nothing to do for options: the rule alone, as before.
            if (!info.rule) throw noRule()
            if (!page.schemaPath || !diff || !IDENTIFIER.test(change.field)) {
              throw new ApiError('unsupported', `\`${change.field}\`'s rule \`${info.rule.slice(0, 60)}\` is not a zod chain Trivia can edit in place; rebuild the field instead`)
            }
            if (!hasDiff(diff)) {
              const opaque = [sites.rule, sites.items].filter((site): site is OpaqueSite => site?.state === 'opaque')
              if (opaque.length > 0 && ![sites.rule, sites.items].some(isReadable)) {
                throw new ApiError('unsupported', `${opaque.map((site) => `the ${label} ${site.what}`).join(' and ')} ${opaque.length === 1 ? 'is' : 'are'} not a literal list Trivia can edit in place`)
              }
              throw new ApiError('conflict', `\`${change.field}\`'s rule already matches the contract`)
            }
          }
          const rule = stale.find((site) => site.kind === 'rule')
          const items = stale.find((site) => site.kind === 'items')
          if (rule) ops.push(...arrayOps(rule, optionEdits(values(rule), contract)))
          ops.push(...ruleOps)
          const { removed, own } = removedValues(stale, contract, sites.default)
          // A default that names a removed value no longer type-checks: the generator's instead.
          if (sites.default && removed.includes(sites.default.value) && page.defaultsPath) {
            ops.push({ op: 'setProperty', path: page.defaultsPath, prop: change.field, value: defaultValue(field) })
          }
          if (items) {
            const control = controls.find((c) => c.name === change.field)
            if (!control) throw new ApiError('internal', `${page.component}'s \`${change.field}\` control is no longer tracked`)
            ops.push(...itemOps(items, optionEdits(values(items), contract), control.locator, renumber))
          }
          if (stale.length > 0) {
            for (const { value, references } of this.#valueMentions(page.file, removed, own)) {
              warnings.push(`${page.file} still names "${value}" outside the ${label} options: ${references.map((m) => `line ${m.line} (${m.text})`).join('; ')}`)
            }
            for (const site of [sites.rule, sites.items]) if (site?.state === 'opaque') warnings.push(opaqueWarning(page.file, label, site))
            labels.push(`Update the ${label} options from the contract`)
          }
          if (ruleOps.length > 0) labels.push(`Update the ${label} rule from the contract`)
          break
        }
        case 'remove': {
          const control = controls.find((c) => c.name === change.field)
          if (!control && !schema.has(change.field) && !defaults.has(change.field)) {
            throw new ApiError('node_not_found', `${page.component} has no \`${change.field}\` field (it has ${page.fields.map((f) => f.name).join(', ')})`)
          }
          touched.add(change.field)
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
          throw new ApiError('invalid_op', `unknown field change ${JSON.stringify(change)} (add, remove, move, rebuild or align)`)
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
   * Where `file` still names each of the `removed` enum values outside the lines `own` (the
   * options an `align` removes, a default it rewrites): string literals and object keys
   * (`=== "suspended"`, `{ suspended: "destructive" }`). They break or go dead when the value goes.
   */
  #valueMentions(file: string, removed: readonly string[], own: ReadonlySet<number>): Array<{ value: string; references: Array<{ line: number; text: string }> }> {
    return removed.flatMap((value) => {
      let found: Mention[]
      try {
        found = this.#host.mentions?.(file, value) ?? []
      } catch {
        found = []
      }
      const references = found
        .filter((m) => (m.kind === 'string' || m.kind === 'key') && !own.has(m.line))
        .filter((m, i, all) => all.findIndex((n) => n.line === m.line) === i)
        .map(({ line, text }) => ({ line, text }))
      return references.length > 0 ? [{ value, references }] : []
    })
  }

  /** `file`'s outline, read the first time it is asked for. */
  #outlineOnce(file: string): () => OutlineNode[] {
    let outline: OutlineNode[] | null = null
    return () => (outline ??= this.#host.outline(file) as OutlineNode[])
  }

  /** The value at `at`, or what kept it from being read: not there, or not one value (`unsupported`). */
  #readValue(at: string): ValueDesc | 'absent' | 'ambiguous' {
    try {
      return this.#host.describeValue!(at) as ValueDesc
    } catch (error) {
      return error instanceof ApiError && error.code === 'unsupported' ? 'ambiguous' : 'absent'
    }
  }

  /** Where a list column writes its enum's values (options.ts): its header's `DataTableFilterCombobox options={[…]}`. */
  #columnSites(column: ColumnInfo): EnumSites {
    const absent: OptionSite = { kind: 'column', state: 'absent' }
    if (!this.#host.describeValue) return { column: absent }
    // By path, not from the header's excerpt: a long header is read whole.
    const at = `${column.path}.header<DataTableFilterCombobox>.options`
    const options = this.#readValue(at)
    if (options === 'absent') return { column: absent }
    const opaque = (what: string): EnumSites => ({ column: { kind: 'column', state: 'opaque', what } })
    if (options === 'ambiguous') return opaque('filter `options` (its header has more than one <DataTableFilterCombobox>)')
    if (options.kind !== 'array') return opaque(`filter \`options={${options.kind === 'identifier' ? options.name : '…'}}\``)
    const items: OptionItem[] = []
    for (const el of options.elements) {
      const value = el.kind === 'object' ? el.properties.find((p) => p.key === 'value')?.value : undefined
      if (value?.kind !== 'string') return opaque('filter `options={[…]}`')
      items.push({ value: value.value, line: el.line })
    }
    return { column: readableSite('column', at, items) }
  }

  /**
   * Where a form writes field `name`'s enum values (options.ts): the array in its `z.enum([…])`
   * rule and its control's `<SelectItem>`s; and its default, when that is a string.
   */
  #fieldSites(page: FormPage, name: string, outline: () => OutlineNode[]): EnumSites {
    const info = page.fields.find((f) => f.name === name)
    if (!info || !this.#host.describeValue) return {}
    const sites: EnumSites = {}

    if (info.rule === null) sites.rule = { kind: 'rule', state: 'absent' }
    else {
      const opaque: OptionSite = { kind: 'rule', state: 'opaque', what: `rule \`${clip(info.rule)}\`` }
      const at = `${page.schemaPath}.${name}`
      const array = info.ruleChain?.[0]?.name === 'z.enum' && page.schemaPath && IDENTIFIER.test(name) ? this.#readValue(at) : 'ambiguous'
      if (array === 'absent') sites.rule = { kind: 'rule', state: 'absent' }
      else if (array === 'ambiguous' || array.kind !== 'array' || !array.elements.every((e) => e.kind === 'string')) sites.rule = opaque
      else sites.rule = readableSite('rule', at, array.elements.map((e) => ({ value: (e as { value: string }).value, line: e.line })))
    }

    const control = info.control
    const node = control && findNode(outline(), (n) => n.locator === control.locator)
    if (!control || !node) sites.items = { kind: 'items', state: 'absent' }
    else {
      const found: OutlineNode[] = []
      const walk = (nodes: OutlineNode[]) => {
        for (const n of nodes) {
          if (n.name === 'SelectItem') found.push(n)
          else walk(n.children)
        }
      }
      walk(node.children)
      const read = found.map((n) => {
        const attributes = ((this.#host.inspect(n.locator) as { attributes?: Array<{ name: string | null; value: unknown; source: string }> }).attributes ?? [])
        return { node: n, value: attributes.find((a) => a.name === 'value') }
      })
      const odd = read.find((r) => typeof r.value?.value !== 'string')
      if (found.length === 0) sites.items = { kind: 'items', state: 'opaque', what: `control \`<${info.widget ?? control.element}>\`` }
      else if (odd) sites.items = { kind: 'items', state: 'opaque', what: `control's \`<SelectItem${odd.value ? ` value={${clip(odd.value.source)}}` : ''}>\`` }
      else {
        sites.items = readableSite('items', control.locator, read.map((r) => ({ value: r.value!.value as string, line: r.node.line, locator: r.node.locator, direct: r.node.isDirect })))
      }
    }

    if (page.defaultsPath && info.hasDefault && IDENTIFIER.test(name)) {
      const value = this.#readValue(`${page.defaultsPath}.${name}`)
      sites.default = typeof value === 'object' && value.kind === 'string' ? { value: value.value, line: info.defaultLine ?? value.line } : null
    }
    return sites
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
    const hasRefineUi = ['views', 'data-table'].some((library) =>
      fs.existsSync(path.join(root, parentDir, 'refine-ui', library)))
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
    const warnings: string[] = []
    // Columns an earlier change in this plan added, removed, rebuilt or aligned (by path): their
    // options were read before that change.
    const touched = new Set<string>()
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
          touched.add(`${page.columnsPath}[id=${field.name}]`)
          ops.push({ op: 'insertElement', path: page.columnsPath, index: at, value: column.value, imports: column.imports })
          labels.push(`Add column ${label}`)
          break
        }
        case 'remove': {
          const column = find(change.column)
          touched.add(column.path)
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
        case 'align': {
          // The filter's options, in place (⚑ docs/product.md, slice 3).
          const column = find(change.column)
          const info = page.columns.find((c) => c.path === column.path)
          if (!info || touched.has(column.path)) {
            throw new ApiError('conflict', `column \`${change.column}\` changed earlier in this plan; align it in a plan of its own`)
          }
          touched.add(column.path)
          const field = resource?.entity?.fields.find((f) => f.name === (info.accessorKey ?? info.key))
          if (!field || fieldShape(field) !== 'enum') {
            throw new ApiError('unsupported', `column \`${change.column}\` shows no enum field of the contract, so it has no options to align`)
          }
          const contract = (field.enum ?? []).filter((v): v is string => typeof v === 'string')
          const site = this.#columnSites(info).column
          if (site?.state === 'opaque') throw new ApiError('unsupported', `the ${column.label} ${site.what} is not a literal list Trivia can edit in place`)
          if (!isReadable(site)) throw new ApiError('unsupported', `column ${column.label}'s header has no <DataTableFilterCombobox options={[…]}> to align`)
          if (!isStale(site, contract)) throw new ApiError('conflict', `the ${column.label} filter options already match the contract`)
          if (site.state === 'blocked') {
            throw new ApiError('unsupported', `${siteName(column.label, site)} cannot be edited in place (${site.why}); rebuild the column instead`)
          }
          ops.push(...arrayOps(site, optionEdits(values(site), contract)))
          const { removed, own } = removedValues([site], contract)
          for (const { value, references } of this.#valueMentions(page.file, removed, own)) {
            warnings.push(`${page.file} still names "${value}" outside the ${column.label} options: ${references.map((m) => `line ${m.line} (${m.text})`).join('; ')}`)
          }
          labels.push(`Update the ${column.label} filter options from the contract`)
          break
        }
        default:
          throw new ApiError('invalid_op', `unknown column change ${JSON.stringify(change)} (add, remove, move, rebuild or align)`)
      }
    }
    for (const change of changes) step(change)
    return { ops, label: labels.join('; '), ...(warnings.length > 0 ? { warnings } : {}) }
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
  if (!example && fs.existsSync(path.join(root, app, '(app)', 'layout.tsx'))) return app + '/(app)'
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

/** The page hooks `text` imports from Refine: `useTable` from react-table, `useForm` from react-hook-form. */
function refineHooks(text: string): Set<UnreadPage['hook']> {
  const hooks = new Set<UnreadPage['hook']>()
  for (const [, names, from] of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']@refinedev\/react-(table|hook-form)["']/g)) {
    const imported = names!.split(',').map((n) => n.trim().split(/\s+as\s+/)[0])
    if (from === 'table' && imported.includes('useTable')) hooks.add('useTable')
    if (from === 'hook-form' && imported.includes('useForm')) hooks.add('useForm')
  }
  return hooks
}
