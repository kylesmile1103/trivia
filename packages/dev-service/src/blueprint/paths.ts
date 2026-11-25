import fs from 'node:fs'
import path from 'node:path'

import { ApiError } from '../engine.js'

export function outsideRoot(file: string): ApiError {
  return new ApiError('path_outside_root', `"${file}" must stay inside the blueprint directory (symlinks are refused)`)
}

/** Project-relative, normalized directory. The project root itself is too broad. */
export function resolveBlueprintDir(root: string, dir = 'blueprint'): string {
  const relative = path.relative(root, path.resolve(root, dir)).split(path.sep).join('/')
  checkedPath(path.resolve(root), relative)
  return relative
}

/** Walk existing ancestors, including the leaf, without following symlinks. */
export function checkedPath(root: string, file: string): string {
  const parts = file.split('/')
  if (/[\\:\0]/.test(file) || parts.some((part) => part === '' || part === '..' || part === '.')) {
    throw outsideRoot(file)
  }
  let current = root
  for (const part of parts) {
    current = path.join(current, part)
    const stat = fs.lstatSync(current, { throwIfNoEntry: false })
    if (stat?.isSymbolicLink()) throw outsideRoot(file)
    if (!stat) break
  }
  return path.join(root, ...parts)
}
