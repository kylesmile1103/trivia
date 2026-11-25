import path from 'node:path'

/** App-relative locator path. The loader may run in a workspace with a wider bundler root. */
export function stampFile(resourcePath: string, root: string): string | null {
  const relative = path.relative(root, resourcePath)
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) return null
  const file = relative.split(path.sep).join('/')
  if (!/\.[jt]sx$/.test(file) || file.split('/').includes('node_modules') || /^(?:src\/)?app\/\(blueprint-preview\)\//.test(file)) return null
  return file
}
