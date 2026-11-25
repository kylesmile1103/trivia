// Where the user's component library lives. shadcn's components.json names it by import
// alias (`aliases.ui`, e.g. "@/components/ui"). The engine needs both: a project-relative
// directory for the prop analyzer, and the alias as the import base of inserted components.

import fs from 'node:fs'
import path from 'node:path'

import type { Alias } from 'vite'
import { resolveBlueprintDir } from '@trivia/dev-service'

export interface PathOptions {
  blueprintDir?: string | undefined
  uiDir?: string | undefined
  importBase?: string | undefined
}

export interface ProjectPaths {
  /** Project-relative directory of the component library: forward slashes, no trailing slash. */
  uiDir: string
  /** Module prefix of library imports (`<importBase>/button`). */
  importBase: string
  /** Problems found while resolving, for the dev-server log. */
  blueprintDir: string
  warnings: string[]
}

export const DEFAULT_UI_DIR = 'src/components/ui'
export const DEFAULT_IMPORT_BASE = '@/components/ui'

/** Explicit options win; otherwise components.json, mapped through the project's aliases. */
export function resolveProjectPaths(root: string, aliases: readonly Alias[], options: PathOptions): ProjectPaths {
  const warnings: string[] = []
  const uiAlias = readUiAlias(root, warnings)
  const importBase = options.importBase ?? uiAlias ?? DEFAULT_IMPORT_BASE

  let uiDir = options.uiDir
  if (uiDir === undefined && uiAlias !== undefined) {
    uiDir = aliasToDir(uiAlias, root, aliases) ?? undefined
    if (uiDir === undefined) {
      warnings.push(
        `cannot map components.json aliases.ui "${uiAlias}" to a directory; using ${DEFAULT_UI_DIR} (set the uiDir option)`,
      )
    }
  }
  uiDir = toProjectDir(uiDir ?? DEFAULT_UI_DIR, root)

  if (uiDir === '..' || uiDir.startsWith('../')) {
    warnings.push(`component library directory ${uiDir} is outside the project root; the engine will refuse it`)
  } else if (!fs.existsSync(path.join(root, uiDir))) {
    warnings.push(`component library directory ${uiDir} does not exist; /@trivia/api/components will fail until it does`)
  }
  return { uiDir, importBase, blueprintDir: resolveBlueprintDir(root, options.blueprintDir), warnings }
}

/** `aliases.ui` from components.json; shadcn derives it from `aliases.components` when absent. */
function readUiAlias(root: string, warnings: string[]): string | undefined {
  const file = path.join(root, 'components.json')
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  let config: unknown
  try {
    config = JSON.parse(text)
  } catch (error) {
    warnings.push(`ignoring components.json: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
  const aliases = isRecord(config) ? config['aliases'] : undefined
  if (!isRecord(aliases)) return undefined
  const { ui, components } = aliases
  if (typeof ui === 'string') return ui
  if (typeof components === 'string') return `${components}/ui`
  return undefined
}

/**
 * Map an import specifier to a project-relative directory with Vite's alias semantics (first
 * match wins; a string `find` matches itself or itself plus `/…`). Without a matching alias,
 * `@/x` follows the shadcn convention (`src/x`) and relative specifiers resolve from the root.
 */
export function aliasToDir(spec: string, root: string, aliases: readonly Alias[]): string | null {
  for (const { find, replacement } of aliases) {
    if (typeof find === 'string') {
      if (spec === find || spec.startsWith(`${find}/`)) return toProjectDir(replacement + spec.slice(find.length), root)
    } else if (find.test(spec)) {
      return toProjectDir(spec.replace(find, replacement), root)
    }
  }
  if (spec.startsWith('@/')) return `src/${spec.slice(2)}`
  if (spec.startsWith('./') || spec.startsWith('../')) return toProjectDir(spec, root)
  return null
}

/**
 * `dir` relative to `root`. Either side may be reached through a symlink (Vite's resolved
 * root is a real path; an alias such as `path.resolve(__dirname, 'src')` may not be), so
 * the first pairing that stays inside the root wins.
 */
function toProjectDir(dir: string, root: string): string {
  const target = path.resolve(root, dir)
  let fallback: string | undefined
  for (const base of new Set([root, realpath(root)])) {
    for (const abs of new Set([target, realpath(target)])) {
      const rel = path.relative(base, abs).split(path.sep).join('/') || '.'
      if (rel !== '..' && !rel.startsWith('../') && !path.isAbsolute(rel)) return rel
      fallback ??= rel
    }
  }
  return fallback ?? '.'
}

function realpath(file: string): string {
  try {
    return fs.realpathSync(file)
  } catch {
    return file
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
