import fs from 'node:fs'
import path from 'node:path'

import { ApiError, type DevHost, type EngineBinding, type PreviewHost, unwrap } from '@trivia/dev-service'
import ts from 'typescript'

import { APP_DIRECTORIES, PREVIEW_GROUP, projectPath } from './paths.js'

const PREVIEW_SEGMENT = '%5F_blueprint'

export function appDirectory(root: string): typeof APP_DIRECTORIES[number] | undefined {
  return APP_DIRECTORIES.find((dir) => fs.statSync(path.join(root, dir), { throwIfNoEntry: false })?.isDirectory())
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
    readRoutes: async () => [],
    preview: diskPreviews(root, app, engine),
    allowedHosts: [],
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
  const directories = new Set<string>()
  let closed = false
  return {
    publish(id, { code }) {
      if (!app || closed) throw new ApiError('unsupported', 'An active App Router host is required for previews')
      if (!/^[a-f0-9]{16}$/.test(id)) throw new ApiError('invalid_op', 'Invalid preview id')
      const group = path.posix.join(app, PREVIEW_GROUP)
      const segment = path.posix.join(group, PREVIEW_SEGMENT)
      const folder = path.posix.join(segment, `refine-${id}`)
      const file = path.posix.join(folder, 'page.tsx')
      const missing = [group, segment, folder].filter((dir) => !fs.existsSync(path.join(root, dir)))
      unwrap(engine.restoreFiles(root, JSON.stringify([{ file, expected: files.get(file) ?? null, content: code }])))
      files.set(file, code)
      for (const dir of missing) directories.add(dir)
      return `/__blueprint/refine-${id}`
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
      for (const directory of [...directories].reverse()) {
        try {
          fs.rmdirSync(path.join(root, directory))
        } catch (error) {
          if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) errors.push(error)
        }
      }
      directories.clear()
      if (errors.length > 0) throw new AggregateError(errors, 'could not remove every Trivia preview')
    },
  }
}
