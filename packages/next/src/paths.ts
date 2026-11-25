import path from 'node:path'

export const APP_DIRECTORIES = ['app', 'src/app'] as const
export const PREVIEW_GROUP = '(blueprint-preview)'

export function projectPath(root: string, absolute: string): string | null {
  const relative = path.relative(root, absolute)
  return path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)
    ? null
    : relative.split(path.sep).join('/')
}

/** App-relative locator path. The loader may run in a workspace with a wider bundler root. */
export function stampFile(resourcePath: string, root: string): string | null {
  const file = projectPath(root, resourcePath)
  if (file === null) return null
  if (!/\.[jt]sx$/.test(file) || file.split('/').includes('node_modules') || /^(?:src\/)?app\/\(blueprint-preview\)\//.test(file)) return null
  return file
}
