// Locator strings as the designer sees them: `<file>#<component>#<i.j.k>` (docs/api.md). The
// engine owns the algorithm (crates/trivia_oxc_engine/src/locator.rs); this module only takes
// the strings apart, the same way (split from the right: file paths may contain `#`).

export interface ParsedLocator {
  file: string
  scope: string
  path: number[]
}

export function parseLocator(locator: string): ParsedLocator | null {
  const last = locator.lastIndexOf('#')
  const mid = last > 0 ? locator.lastIndexOf('#', last - 1) : -1
  if (mid <= 0) return null
  const segments = locator.slice(last + 1).split('.')
  const path = segments.map(Number)
  if (segments.some((s) => !/^\d+$/.test(s))) return null
  return { file: locator.slice(0, mid), scope: locator.slice(mid + 1, last), path }
}

/** The project-relative file part of a locator ("" when malformed). */
export function locatorFile(locator: string): string {
  return parseLocator(locator)?.file ?? ''
}

/** True when `file` lies inside the project-relative directory `dir`. */
export function isInDir(file: string, dir: string): boolean {
  const d = dir.replace(/\/+$/, '')
  return d !== '' && (file === d || file.startsWith(`${d}/`))
}

/** Definition-site locators of the component library (health.uiDir) are not edit targets. */
export function isLibraryLocator(locator: string, uiDir: string): boolean {
  return isInDir(locatorFile(locator), uiDir)
}

/** A component root (JSX with no JSX ancestor): one path segment. */
export function isRootLocator(locator: string): boolean {
  const p = parseLocator(locator)
  return p !== null && p.path.length === 1
}

/** True when `inner` is `outer` or lies in its subtree (same file and component). */
export function isSameOrInside(inner: string, outer: string): boolean {
  if (inner === outer) return true
  const a = parseLocator(inner)
  const b = parseLocator(outer)
  if (!a || !b || a.file !== b.file || a.scope !== b.scope || a.path.length <= b.path.length) return false
  return b.path.every((seg, i) => a.path[i] === seg)
}
