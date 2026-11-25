import fs from 'node:fs'
import path from 'node:path'

import { ApiError, type DevHost, type EngineBinding, type PreviewHost, type RouteEntry, unwrap } from '@trivia/dev-service'
import ts from 'typescript'

import { APP_DIRECTORIES, PREVIEW_GROUP, projectPath } from './paths.js'

const PREVIEW_SEGMENT = '%5F_blueprint'

export function appDirectory(root: string): typeof APP_DIRECTORIES[number] | undefined {
  return APP_DIRECTORIES.find((dir) => {
    const absolute = path.join(root, dir)
    return fs.statSync(absolute, { throwIfNoEntry: false })?.isDirectory() && projectPath(root, fs.realpathSync(absolute)) !== null
  })
}

export function createNextHost(root: string, engine: EngineBinding, paths: { uiDir?: string; importBase?: string } = {}): DevHost {
  const app = appDirectory(root)
  const compiler = compilerOptions(root)
  const resolve = (specifier: string, importer: string) =>
    ts.resolveModuleName(specifier, path.join(root, importer), compiler, ts.sys).resolvedModule
  const importBase = paths.importBase ?? componentAlias(root) ?? '@/components/ui'
  const button = resolve(`${importBase}/button`, 'next.config.ts')
  const buttonFile = button && projectPath(root, button.resolvedFileName)
  const defaultUi = ['src/components/ui', 'components/ui'].find((dir) => fs.existsSync(path.join(root, dir)))
  return {
    root,
    kind: 'next',
    uiDir: paths.uiDir ?? (buttonFile ? path.posix.dirname(buttonFile) : defaultUi ?? 'src/components/ui'),
    importBase,
    resolveModule: async (specifier, importer) => {
      const result = resolve(specifier, importer)
      if (!result || result.isExternalLibraryImport || /\.d\.[cm]?ts$/.test(result.resolvedFileName)) return null
      const real = await fs.promises.realpath(result.resolvedFileName).catch(() => null)
      return real && projectPath(root, real) !== null ? projectPath(root, result.resolvedFileName) : null
    },
    readRoutes: () => readRoutes(root),
    preview: diskPreviews(root, app, engine),
    ...(app ? { trackFileWrites: trackRouteDirectories(root, app) } : {}),
    allowedHosts: [],
  }
}

/** Turbopack can keep serving a deleted page while its newly created route folder is empty. */
function trackRouteDirectories(root: string, app: string): NonNullable<DevHost['trackFileWrites']> {
  const created = new Set<string>()
  const parents = (file: string): string[] => {
    if (!file.startsWith(`${app}/`) || !/\/page\.[jt]sx$/.test(file) || file !== path.posix.normalize(file) || file.includes('\\')) return []
    const dirs: string[] = []
    for (let dir = path.posix.dirname(file); dir !== app; dir = path.posix.dirname(dir)) dirs.push(dir)
    return dirs
  }
  return (creating, removing) => {
    const missing = creating.flatMap(parents).filter((dir) => !fs.existsSync(path.join(root, dir)))
    return () => {
      for (const dir of missing) {
        if (fs.existsSync(path.join(root, dir))) created.add(dir)
      }
      for (const dir of removing.flatMap(parents)) {
        if (!created.has(dir)) continue
        const absolute = path.join(root, dir)
        try {
          if (projectPath(root, fs.realpathSync(absolute)) === null) continue
          fs.rmdirSync(absolute)
          created.delete(dir)
        } catch {
          // Keep directories the user populated. The native history write already succeeded.
        }
      }
    }
  }
}

function componentAlias(root: string): string | undefined {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'components.json'), 'utf8')) as { aliases?: { ui?: unknown } }
    return typeof config.aliases?.ui === 'string' ? config.aliases.ui : undefined
  } catch {
    return undefined
  }
}

function compilerOptions(root: string): ts.CompilerOptions {
  const base = { allowJs: true, moduleResolution: ts.ModuleResolutionKind.Bundler }
  const config = ['tsconfig.json', 'jsconfig.json'].map((name) => path.join(root, name)).find((file) => fs.existsSync(file))
  if (!config) return base
  const settings = ts.readConfigFile(config, ts.sys.readFile)
  if (settings.error) return base // Next reports malformed project config on startup.
  return ts.parseJsonConfigFileContent(settings.config, ts.sys, root, base, config).options
}

function diskPreviews(root: string, app: string | undefined, engine: EngineBinding): PreviewHost {
  const files = new Map<string, string>()
  const directories = new Map<string, string>()
  let closed = false
  const folderOf = (name: string) => {
    if (!app || closed) throw new ApiError('unsupported', 'An active App Router host is required for previews')
    return path.posix.join(app, PREVIEW_GROUP, PREVIEW_SEGMENT, name)
  }

  const removeDirectories = (errors: unknown[]) => {
    for (const [directory, expected] of [...directories].reverse()) {
      try {
        const real = fs.realpathSync(path.join(root, directory))
        if (real === expected && projectPath(root, real)) {
          fs.rmdirSync(real)
          directories.delete(directory)
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT') directories.delete(directory)
        else if (code !== 'ENOTEMPTY') errors.push(error)
      }
    }
  }

  const replace = (folder: string, desired: ReadonlyMap<string, string>) => {
    const previous = [...files].filter(([file]) => path.posix.dirname(file) === folder)
    const writes = [
      ...previous.filter(([file]) => !desired.has(file)).map(([file, expected]) => ({ file, expected, content: null })),
      ...[...desired].map(([file, content]) => ({ file, expected: files.get(file) ?? null, content })),
    ]
    if (!writes.length) return
    const missing = desired.size ? [path.posix.dirname(path.posix.dirname(folder)), path.posix.dirname(folder), folder]
      .filter((dir) => !fs.existsSync(path.join(root, dir))) : []
    unwrap(engine.restoreFiles(root, JSON.stringify(writes)))
    for (const [file] of previous) files.delete(file)
    for (const [file, content] of desired) files.set(file, content)
    for (const dir of missing) directories.set(dir, fs.realpathSync(path.join(root, dir)))
    const errors: unknown[] = []
    removeDirectories(errors)
    if (errors.length) throw new AggregateError(errors, 'could not remove preview directories')
  }

  return {
    ...(app && { blueprints: true as const }),
    publish(id, { code }) {
      if (!/^[a-f0-9]{16}$/.test(id)) throw new ApiError('invalid_op', 'Invalid preview id')
      const folder = folderOf(`refine-${id}`)
      const file = path.posix.join(folder, 'page.tsx')
      replace(folder, new Map([[file, code]]))
      return `/__blueprint/refine-${id}`
    },
    publishBlueprint(name, modules) {
      if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) throw new ApiError('invalid_op', 'Invalid draft preview name')
      const folder = folderOf(name)
      const desired = new Map(modules.map(({ file, code }) => {
        const name = path.posix.basename(file)
        if (file !== folder + '/' + name || !/^(page|compiled|handler|view(?:\.[A-Za-z0-9_$]+)?)\.tsx?$/.test(name)) {
          throw new ApiError('invalid_op', 'Invalid draft preview module')
        }
        return [file, code]
      }))
      if (!desired.has(folder + '/page.tsx') || desired.size !== modules.length) {
        throw new ApiError('invalid_op', 'A draft preview must have one entry and distinct modules')
      }
      replace(folder, desired)
    },
    removeBlueprint(name) {
      if (!app || closed || !/^[A-Z][A-Za-z0-9]*$/.test(name)) return
      replace(folderOf(name), new Map())
    },
    close() {
      closed = true
      const errors: unknown[] = []
      for (const [file, expected] of files) {
        try {
          unwrap(engine.restoreFiles(root, JSON.stringify([{ file, expected, content: null }])))
        } catch (error) {
          errors.push(error)
        }
      }
      files.clear()
      removeDirectories(errors)
      directories.clear()
      if (errors.length > 0) throw new AggregateError(errors, 'could not remove every Trivia preview')
    },
  }
}

/** App Router file conventions. The declared module is the page file, even for re-exports. */
export async function readRoutes(root: string): Promise<RouteEntry[]> {
  const app = appDirectory(root)
  if (!app) return []
  const routes: RouteEntry[] = []
  const walk = async (dir: string, segments: string[]): Promise<void> => {
    const entries = await fs.promises.readdir(path.join(root, dir), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    const file = ['page.tsx', 'page.jsx'].find((name) => entries.some((entry) => entry.isFile() && entry.name === name))
    if (file) {
      const pathname = `/${segments.join('/')}`
      const source = path.posix.join(dir, file)
      routes.push({
        path: pathname,
        params: segments.flatMap((segment) => segment === '*' ? ['*'] : segment.startsWith(':') ? [segment.slice(1)] : []),
        index: segments.length === 0,
        catchAll: segments.includes('*'),
        router: 'next-app-router',
        file: source,
        declared: { file: source, line: 1 },
        component: null,
        locator: null,
      })
    }
    for (const entry of entries) {
      const name = entry.name
      if (!entry.isDirectory() || name === PREVIEW_GROUP || name === 'node_modules' || /^[.@_]/.test(name) || /^\(\.{1,3}\)/.test(name)) continue
      const segment = /^\(.*\)$/.test(name) ? null : urlSegment(name)
      await walk(path.posix.join(dir, name), segment === null ? segments : [...segments, segment])
    }
  }
  await walk(app, [])
  return routes.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}

function urlSegment(name: string): string {
  if (/^\[\.\.\.[^\]]+\]$|^\[\[\.\.\.[^\]]+\]\]$/.test(name)) return '*'
  const dynamic = /^\[([^\]]+)\]$/.exec(name)
  return dynamic?.[1] ? `:${dynamic[1]}` : encodeURIComponent(name.replaceAll('%5F', '_'))
}
