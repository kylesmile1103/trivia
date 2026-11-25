import path from 'node:path'

export const DEFAULT_WEB_DIRECTORY = 'web'

export function checkedWebDirectory(value: string): string {
  const parts = value.split('/')
  if (parts.some((part) => !/^[A-Za-z0-9._ -]+$/.test(part) || part !== part.trim() || part === '.' || part === '..')) {
    throw new Error('Pass a solution-relative web directory with no parent segments.')
  }
  return value
}

export function solutionFromWeb(web: string, manifest: unknown): { root: string; webDirectory: string } | null {
  const marker = (manifest as { trivia?: { solutionRoot?: unknown } } | null)?.trivia?.solutionRoot
  if (marker === undefined) return null
  if (typeof marker !== 'string' || !/^\.\.(?:\/\.\.)*$/.test(marker)) {
    throw new Error('package.json trivia.solutionRoot must point to an ancestor of the web directory.')
  }
  const root = path.resolve(web, marker)
  return { root, webDirectory: checkedWebDirectory(path.relative(root, web).split(path.sep).join('/')) }
}
