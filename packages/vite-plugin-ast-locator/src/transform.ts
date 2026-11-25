// Phase 1: stamp `data-ast-node="<file>#<component>#<path>"` on every JSX opening element.
// The engine computes the locators (one algorithm for stamping and resolving, CLAUDE.md
// rule 3); this file only decides which Vite modules qualify.

import path from 'node:path'

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
  return relativeToRoots(file, roots)
}

/** The forward-slash path of absolute `file` from the first of `roots` it is under, or `null`. */
export function relativeToRoots(file: string, roots: readonly string[]): string | null {
  for (const root of roots) {
    const rel = path.relative(root, file)
    if (rel !== '' && !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`)) {
      return rel.split(path.sep).join('/')
    }
  }
  return null
}
