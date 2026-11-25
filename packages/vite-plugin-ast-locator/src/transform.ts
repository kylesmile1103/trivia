// Phase 1: stamp `data-ast-node="<file>#<component>#<path>"` on every JSX opening element.
// The engine computes the locators (one algorithm for stamping and resolving, CLAUDE.md
// rule 3); this file only decides which modules qualify and splices the attributes in.

import path from 'node:path'

import MagicString, { type SourceMap } from 'magic-string'

import type { Insertion } from '@trivia/dev-service'

/** Module ids offered to the transform hook (its filter); `moduleFile` re-checks each one. */
export const JSX_ID = /\.[jt]sx(?:$|\?)/
export const NODE_MODULES = /[\\/]node_modules[\\/]/
export const VIRTUAL_ID = /^\0/

// Query params that only bust caches. Any other query names a derived module (`?raw`,
// `?url`, `?worker`, …) whose code is not the file's JSX.
const CACHE_PARAMS = new Set(['t', 'v'])

/**
 * The project-relative, forward-slash path of a module id, or `null` when the module must not
 * be annotated: virtual, inside `node_modules`, outside every root, not `.tsx`/`.jsx`, or
 * carrying a query other than a cache buster. `roots` are absolute (the config root and its
 * real path, since Vite resolves ids through symlinks).
 */
export function moduleFile(id: string, roots: readonly string[]): string | null {
  if (VIRTUAL_ID.test(id) || NODE_MODULES.test(id)) return null
  const q = id.indexOf('?')
  const file = q === -1 ? id : id.slice(0, q)
  if (q !== -1) {
    for (const key of new URLSearchParams(id.slice(q + 1)).keys()) {
      if (!CACHE_PARAMS.has(key)) return null
    }
  }
  if (!/\.[jt]sx$/.test(file) || !path.isAbsolute(file)) return null
  for (const root of roots) {
    const rel = path.relative(root, file)
    if (rel !== '' && !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`)) {
      return rel.split(path.sep).join('/')
    }
  }
  return null
}

export interface Annotated {
  code: string
  map: SourceMap
}

/**
 * Apply the engine's insertions for `file` (project-relative) to `code`. `source` names the
 * original in the source map. Returns `null` when there is no JSX to stamp; throws whatever
 * `annotate` throws (a syntax error, typically).
 */
export function annotateModule(
  code: string,
  file: string,
  source: string,
  annotate: (code: string, file: string) => Insertion[],
): Annotated | null {
  const insertions = annotate(code, file)
  if (insertions.length === 0) return null
  const s = new MagicString(code)
  // Offsets are UTF-16 code units, the same unit as MagicString's string indices.
  for (const { offset, text } of insertions) s.appendLeft(offset, text)
  return {
    code: s.toString(),
    map: s.generateMap({ source, includeContent: true, hires: 'boundary' }),
  }
}

/** True for the engine's syntax-error failure, which Vite's own transform reports better. */
export function isSyntaxError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('cannot parse ')
}
