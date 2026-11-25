// The app's routes, read from its source: every page a URL reaches, with the component that
// renders it and that component's module. Read statically like everything else here (the engine's
// outline, inspect and value descriptions), so it works before the app runs and names files.
//
// - React Router: `<Route>` trees (inside `<Routes>` or alone, as for createRoutesFromElements),
//   and route objects (`createBrowserRouter([...])` and kin, `useRoutes([...])`). A page under a
//   splat route (`settings/*`) whose component renders its own `<Routes>`/`useRoutes` has those
//   routes joined onto the splat's base, as React Router resolves descendant routes.
// - TanStack Router: file-based routes (`createFileRoute("/posts/$id")`) and code-based ones
//   (`createRoute({ getParentRoute, path })`).
//
// A pathless layout is not a page (its children are); neither is a route beside an index child
// that serves the same URL. Paths keep their router's own param syntax (`:id`, `$id`).

import fsp from 'node:fs/promises'
import path from 'node:path'

import type { ValueDesc } from '../refine/page.js'
import { joinPath, normalizePath, routeParams, tanstackPath, withoutSplat } from './paths.js'

export interface RouteEntry {
  /** The URL pattern, in its router's syntax: `/customers/edit/:id`, `/posts/$postId`. */
  path: string
  /** What a URL needs filled in, in order; a splat is `*`. */
  params: string[]
  /** An index route: it serves its parent's URL. */
  index: boolean
  /** It ends in a splat: it serves every URL below it. */
  catchAll: boolean
  router: 'react-router' | 'tanstack-router'
  /** The component it renders, as named where the route is declared; null for a lazy route module. */
  component: string | null
  /** That component's module (project-relative), or null when it comes from a package or can't be resolved. */
  file: string | null
  /** Where the route is declared. */
  declared: { file: string; line: number }
  /** The `<Route>` element's locator, for a route declared in JSX; else null. */
  locator: string | null
}

export interface RoutesHost {
  /** Absolute project root; files are relative to it. */
  root: string
  outline(file: string): unknown
  inspect(locator: string): unknown
  describeValues(file: string): unknown
  /** `specifier` imported from `importer`, as the app's bundler resolves it: a project-relative file, or null. */
  resolve(specifier: string, importer: string): Promise<string | null>
}

interface OutlineNode {
  locator: string
  name: string
  line: number
  children: OutlineNode[]
}

interface Attribute {
  name: string
  kind: string
  source: string
  value: unknown
}

interface ScopeValues {
  scope: string
  bindings: Array<{ name: string; via: string[]; line: number; value: ValueDesc }>
  calls: Array<{ callee: string; line: number; args: ValueDesc[] }>
}

/** One React Router route as declared, before paths are joined. */
interface RouteNode {
  path: string | null
  index: boolean
  component: string | null
  /** A `lazy: () => import("…")` route's module specifier. */
  lazy: string | null
  children: RouteNode[]
  declared: { file: string; line: number }
  locator: string | null
}

/** A TanStack `createRoute`/`createRootRoute` binding. */
interface CodeRoute {
  file: string
  name: string
  /** The binding `getParentRoute` returns; null for the root. */
  parent: string | null
  /** Its `path`; null for a pathless (`id`) route. */
  path: string | null
  component: string | null
  line: number
}

/** Route trees of one file: a `<Routes>`, a `useRoutes` call, a router's route array. */
interface RouteTree {
  file: string
  nodes: RouteNode[]
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build'])
const SOURCE = /\.(tsx|jsx|ts|js)$/
const MARKERS = /<Route[\s>]|<Routes[\s>]|create(Browser|Hash|Memory)Router|useRoutes|createFileRoute|createLazyFileRoute|createRoute\(|createRootRoute/
const ROUTER_FACTORIES = new Set(['createBrowserRouter', 'createHashRouter', 'createMemoryRouter'])
/** How deep descendant routes nest across files; past it a page is listed without them. */
const MAX_NESTING = 8

const EXTENSIONS = ['', '.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts', '/index.jsx', '/index.js']

/**
 * A resolver for hosts without the app's bundler: relative specifiers, and `@/` as `src/` (the
 * shadcn and Vite convention). The plugin uses Vite's own resolver instead.
 */
export function fileResolver(root: string): RoutesHost['resolve'] {
  return async (specifier, importer) => {
    const base = specifier.startsWith('@/')
      ? `src/${specifier.slice(2)}`
      : specifier.startsWith('.')
        ? path.posix.join(path.posix.dirname(importer), specifier)
        : null
    if (base === null) return null
    const realRoot = await fsp.realpath(root)
    for (const candidate of EXTENSIONS.map((e) => base + e)) {
      if (path.isAbsolute(candidate) || candidate === '..' || candidate.startsWith('../')) return null
      const file = await fsp.realpath(path.join(realRoot, candidate)).catch(() => null)
      if (file === null) continue
      const relative = path.relative(realRoot, file)
      if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) continue
      const stat = await fsp.stat(file).catch(() => null)
      if (stat?.isFile()) return candidate
    }
    return null
  }
}

export async function discoverRoutes(host: RoutesHost): Promise<RouteEntry[]> {
  const files = await routeFiles(host.root)
  const finder = new RouteFinder(host)
  for (const [file, text] of files) finder.read(file, text)
  return [...(await finder.reactRouterEntries()), ...(await finder.tanstackEntries())]
}

/** Project-relative source files under src/ that may declare routes, with their text. */
async function routeFiles(root: string): Promise<Array<[string, string]>> {
  const out: Array<[string, string]> = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries: Array<{ name: string; isDirectory(): boolean }>
    try {
      entries = await fsp.readdir(path.join(root, dir), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = path.posix.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < 8 && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) await walk(rel, depth + 1)
      } else if (SOURCE.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        const text = await fsp.readFile(path.join(root, rel), 'utf8').catch(() => '')
        if (MARKERS.test(text)) out.push([rel, text])
      }
    }
  }
  await walk('src', 0)
  return out
}

class RouteFinder {
  readonly #host: RoutesHost
  readonly #texts = new Map<string, string>()
  readonly #trees: RouteTree[] = []
  readonly #fileRoutes: Array<{ file: string; id: string; line: number; lazy: boolean }> = []
  readonly #codeRoutes: CodeRoute[] = []
  readonly #values = new Map<string, ScopeValues[]>()

  constructor(host: RoutesHost) {
    this.#host = host
  }

  read(file: string, text: string): void {
    this.#texts.set(file, text)
    if (/<Routes?[\s>]/.test(text)) this.#jsxTrees(file)
    this.#objectTrees(file)
    for (const match of text.matchAll(/create(Lazy)?FileRoute\(\s*(['"`])([^'"`]+)\2\s*\)/g)) {
      this.#fileRoutes.push({ file, id: match[3]!, line: lineAt(text, match.index), lazy: match[1] !== undefined })
    }
  }

  // -------------------------------------------------------------------------------------------
  // React Router

  #jsxTrees(file: string): void {
    let outline: OutlineNode[]
    try {
      outline = this.#host.outline(file) as OutlineNode[]
    } catch {
      return
    }
    const walk = (nodes: OutlineNode[]): void => {
      for (const n of nodes) {
        if (n.name === 'Routes') this.#trees.push({ file, nodes: n.children.filter((c) => c.name === 'Route').map((c) => this.#jsxRoute(file, c)) })
        else if (n.name === 'Route') this.#trees.push({ file, nodes: [this.#jsxRoute(file, n)] })
        else walk(n.children)
      }
    }
    walk(outline)
  }

  #jsxRoute(file: string, node: OutlineNode): RouteNode {
    let attributes: Attribute[] = []
    try {
      attributes = ((this.#host.inspect(node.locator) as { attributes?: Attribute[] }).attributes ?? [])
    } catch {
      // A route the engine can't inspect still has a place in the tree.
    }
    const attr = (name: string) => attributes.find((a) => a.name === name)
    const pathValue = attr('path')?.value
    return {
      path: typeof pathValue === 'string' ? pathValue : null,
      index: attr('index') !== undefined && attr('index')!.value !== false && attr('index')!.source !== '{false}',
      component: tagName(attr('element')?.source) ?? identifier(attr('Component')?.source),
      lazy: importSpecifier(attr('lazy')?.source),
      children: node.children.filter((c) => c.name === 'Route').map((c) => this.#jsxRoute(file, c)),
      declared: { file, line: node.line },
      locator: node.locator,
    }
  }

  #objectTrees(file: string): void {
    const scopes = this.#scopes(file)
    for (const scope of scopes) {
      const named = (name: string): ValueDesc | undefined =>
        (scope.bindings.find((b) => b.name === name) ?? scopes.find((s) => s.scope === 'module')?.bindings.find((b) => b.name === name))?.value
      const routesOf = (value: ValueDesc | undefined): ValueDesc | undefined => (value?.kind === 'identifier' ? named(value.name) : value)
      for (const binding of scope.bindings) {
        if (binding.via.some((v) => ROUTER_FACTORIES.has(v))) this.#pushObjects(file, routesOf(binding.value))
        if (binding.via.includes('createRoute') || binding.via.includes('createRootRoute')) this.#codeRoute(file, binding)
      }
      for (const call of scope.calls) {
        if (call.callee.split('.').at(-1) === 'useRoutes') this.#pushObjects(file, routesOf(call.args[0]))
      }
    }
  }

  #pushObjects(file: string, value: ValueDesc | undefined): void {
    if (value?.kind === 'array') this.#trees.push({ file, nodes: value.elements.flatMap((e) => this.#objectRoute(file, e)) })
  }

  #objectRoute(file: string, value: ValueDesc): RouteNode[] {
    if (value.kind !== 'object') return []
    const prop = (key: string) => value.properties.find((p) => p.key === key)?.value
    const pathValue = prop('path')
    const index = prop('index')
    const children = prop('children')
    const element = prop('element')
    const Component = prop('Component')
    const lazy = prop('lazy')
    return [
      {
        path: pathValue?.kind === 'string' ? pathValue.value : null,
        index: index?.kind === 'boolean' && index.value,
        component: element && 'source' in element ? tagName(element.source) : Component?.kind === 'identifier' ? Component.name : null,
        lazy: lazy && 'source' in lazy ? importSpecifier(lazy.source) : null,
        children: children?.kind === 'array' ? children.elements.flatMap((c) => this.#objectRoute(file, c)) : [],
        declared: { file, line: value.line },
        locator: null,
      },
    ]
  }

  async reactRouterEntries(): Promise<RouteEntry[]> {
    // Which trees a splat route's page renders: they are that route's descendants, not roots.
    const nested = new Map<RouteNode, RouteTree[]>()
    const reached = new Set<RouteTree>()
    const visit = async (node: RouteNode, file: string): Promise<void> => {
      for (const child of node.children) await visit(child, file)
      if (node.path === null || !node.path.endsWith('*') || node.component === null) return
      const module = await this.#moduleOf(node.component, file)
      const trees = this.#trees.filter((t) => t.file === module && t.file !== file)
      if (trees.length === 0) return
      nested.set(node, trees)
      for (const t of trees) reached.add(t)
    }
    for (const tree of this.#trees) for (const node of tree.nodes) await visit(node, tree.file)

    const entries: RouteEntry[] = []
    const emit = async (nodes: RouteNode[], base: string, depth: number, trail: ReadonlySet<RouteTree>): Promise<void> => {
      for (const node of nodes) {
        const url = node.index ? base : node.path === null ? base : joinPath(base, node.path)
        const below = nested.get(node)
        if (below && depth < MAX_NESTING) {
          for (const tree of below) {
            if (trail.has(tree)) continue
            await emit(tree.nodes, withoutSplat(url), depth + 1, new Set([...trail, tree]))
          }
          continue
        }
        const layout = node.path === null && !node.index
        const servedByIndex = node.children.some((c) => c.index)
        if (!layout && !servedByIndex && (node.component !== null || node.lazy !== null)) {
          const file = node.lazy !== null ? await this.#host.resolve(node.lazy, node.declared.file) : await this.#moduleOf(node.component!, node.declared.file)
          entries.push({
            path: url,
            params: routeParams(url),
            index: node.index,
            catchAll: url.endsWith('*'),
            router: 'react-router',
            component: node.component,
            file,
            declared: node.declared,
            locator: node.locator,
          })
        }
        await emit(node.children, url, depth, trail)
      }
    }
    for (const tree of this.#trees.filter((t) => !reached.has(t))) await emit(tree.nodes, '/', 0, new Set([tree]))
    return unique(entries)
  }

  // -------------------------------------------------------------------------------------------
  // TanStack Router

  #codeRoute(file: string, binding: ScopeValues['bindings'][number]): void {
    const options = binding.value
    if (options.kind !== 'object') return
    const prop = (key: string) => options.properties.find((p) => p.key === key)?.value
    const parentFn = prop('getParentRoute')
    const pathValue = prop('path')
    const component = prop('component')
    this.#codeRoutes.push({
      file,
      name: binding.name,
      parent: parentFn && 'source' in parentFn ? (/=>\s*\(?\s*([\w$]+)/.exec(parentFn.source)?.[1] ?? null) : null,
      path: pathValue?.kind === 'string' ? pathValue.value : binding.via.includes('createRootRoute') ? '/' : null,
      component: component?.kind === 'identifier' ? component.name : null,
      line: binding.line,
    })
  }

  async tanstackEntries(): Promise<RouteEntry[]> {
    const entries: RouteEntry[] = []

    // File-based: a route ID per file. A lazy file (`createLazyFileRoute`) adds the component
    // of the route with its ID; a route with an index child (`/posts/`) serves no page itself.
    const ids = new Set(this.#fileRoutes.filter((r) => !r.lazy).map((r) => r.id))
    for (const route of this.#fileRoutes.filter((r) => !r.lazy)) {
      const last = route.id.split('/').filter(Boolean).at(-1) ?? ''
      if (last.startsWith('_') || /^\(.*\)$/.test(last)) continue // a pathless layout or a group
      if (!route.id.endsWith('/') && ids.has(`${route.id}/`)) continue
      const lazy = this.#fileRoutes.find((r) => r.lazy && r.id === route.id)
      const component = this.#routeComponent(route.file) ?? (lazy ? this.#routeComponent(lazy.file) : null)
      const url = tanstackPath(route.id)
      entries.push({
        path: url,
        params: routeParams(url),
        index: route.id.endsWith('/') && route.id !== '/',
        catchAll: url.endsWith('$'),
        router: 'tanstack-router',
        component,
        file: component === null ? route.file : await this.#moduleOf(component, component === this.#routeComponent(route.file) ? route.file : lazy!.file),
        declared: { file: route.file, line: route.line },
        locator: null,
      })
    }

    // Code-based: each route's URL is its parents' paths joined (an `id` route adds nothing).
    const byName = new Map(this.#codeRoutes.map((r) => [`${r.file}:${r.name}`, r]))
    const urlOf = (route: CodeRoute, depth = 0): string => {
      const parent = route.parent === null ? undefined : byName.get(`${route.file}:${route.parent}`)
      const base = parent && depth < MAX_NESTING ? urlOf(parent, depth + 1) : '/'
      return route.path === null ? base : joinPath(base, route.path)
    }
    const parents = new Set(this.#codeRoutes.map((r) => r.parent))
    for (const route of this.#codeRoutes) {
      if (route.parent === null || route.path === null) continue // the root, or a pathless layout
      const url = urlOf(route)
      const servedByIndex = parents.has(route.name) && this.#codeRoutes.some((r) => r.parent === route.name && r.path === '/')
      if (servedByIndex) continue
      entries.push({
        path: url,
        params: routeParams(url),
        index: route.path === '/' && url !== '/',
        catchAll: url.endsWith('$'),
        router: 'tanstack-router',
        component: route.component,
        file: route.component === null ? route.file : await this.#moduleOf(route.component, route.file),
        declared: { file: route.file, line: route.line },
        locator: null,
      })
    }
    return unique(entries.sort((a, b) => (a.declared.file === b.declared.file ? 0 : a.path.localeCompare(b.path))))
  }

  /** The `component` of a file route's options (`createFileRoute(…)({ component })`). */
  #routeComponent(file: string): string | null {
    for (const scope of this.#scopes(file)) {
      const route = scope.bindings.find((b) => b.name === 'Route')
      if (route?.value.kind !== 'object') continue
      const component = route.value.properties.find((p) => p.key === 'component')?.value
      if (component?.kind === 'identifier') return component.name
    }
    return null
  }

  // -------------------------------------------------------------------------------------------
  // Shared

  #scopes(file: string): ScopeValues[] {
    let scopes = this.#values.get(file)
    if (scopes === undefined) {
      try {
        scopes = this.#host.describeValues(file) as ScopeValues[]
      } catch {
        scopes = []
      }
      this.#values.set(file, scopes)
    }
    return scopes
  }

  /**
   * The module a component used in `file` comes from: its import, a `lazy(() => import(…))`
   * binding, or `file` itself when it is declared there. Null for a package or what can't be found.
   */
  async #moduleOf(component: string, file: string): Promise<string | null> {
    const name = component.split('.')[0]!
    const text = this.#texts.get(file) ?? (await fsp.readFile(path.join(this.#host.root, file), 'utf8').catch(() => ''))
    const imported = importedFrom(text, name)
    if (imported !== null) return this.#host.resolve(imported, file)
    for (const scope of this.#scopes(file)) {
      const binding = scope.bindings.find((b) => b.name === name && b.via.some((v) => v === 'lazy' || v.endsWith('.lazy')))
      const source = binding && 'source' in binding.value ? binding.value.source : null
      const specifier = importSpecifier(source ?? undefined)
      if (specifier !== null) return this.#host.resolve(specifier, file)
    }
    const declared = new RegExp(`(?:function|class|const|let|var)\\s+${escape(name)}\\b`)
    return declared.test(text) ? file : null
  }
}

/** The tag of the first element in JSX source (`<CustomerList />` → CustomerList). */
function tagName(source: string | undefined): string | null {
  return source === undefined ? null : (/^\{?\s*<\s*([A-Za-z_$][\w$.]*)/.exec(source)?.[1] ?? null)
}

function identifier(source: string | undefined): string | null {
  return source === undefined ? null : (/^\{?\s*([A-Za-z_$][\w$.]*)\s*\}?$/.exec(source)?.[1] ?? null)
}

/** The module of a dynamic `import("…")` in `source`. */
function importSpecifier(source: string | undefined): string | null {
  return source === undefined ? null : (/import\(\s*(['"`])([^'"`]+)\1\s*\)/.exec(source)?.[2] ?? null)
}

/** Where `file` imports `name` from (named, default, renamed or namespace import), or null. */
function importedFrom(text: string, name: string): string | null {
  for (const match of text.matchAll(/import\s+(?!type\s)([\s\S]*?)\s+from\s+(['"])([^'"]+)\2/g)) {
    const clause = match[1]!
    const [head, braces] = clause.includes('{') ? [clause.slice(0, clause.indexOf('{')), clause.slice(clause.indexOf('{') + 1, clause.lastIndexOf('}'))] : [clause, '']
    const defaultOrNamespace = head
      .split(',')
      .map((s) => s.trim().replace(/^\*\s+as\s+/, ''))
      .filter(Boolean)
    const named = braces
      .split(',')
      .map((s) => s.trim().replace(/^type\s+/, ''))
      .filter(Boolean)
      .map((s) => s.split(/\s+as\s+/).at(-1)!.trim())
    if (defaultOrNamespace.includes(name) || named.includes(name)) return match[3]!
  }
  return null
}

function lineAt(text: string, offset: number): number {
  return text.slice(0, offset).split('\n').length
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** One entry per URL: the first declared. */
function unique(entries: RouteEntry[]): RouteEntry[] {
  const seen = new Set<string>()
  return entries.filter((e) => {
    const key = normalizePath(e.path)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
