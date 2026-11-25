import fs from 'node:fs'
import path from 'node:path'

import { ApiError } from '../engine.js'
import type { FileChange } from '../types.js'
import { checkedPath } from './paths.js'

function conflict(file: string): ApiError {
  return new ApiError('conflict', `${file} changed on disk; read it again before editing`)
}

function ioError(error: unknown): ApiError {
  return error instanceof ApiError ? error : new ApiError('io_error', (error as Error).message)
}

function guard(file: string, expected: string | null): number | undefined {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false })
  if (!stat && expected === null) return undefined
  if (!stat || expected === null) throw conflict(file)
  if (!stat.isFile()) throw new ApiError('io_error', `${file} is not a regular file`)
  if (!fs.readFileSync(file).equals(Buffer.from(expected))) throw conflict(file)
  return stat.mode
}

function makeParents(dir: string, created: string[]): void {
  if (fs.existsSync(dir)) return
  makeParents(path.dirname(dir), created)
  fs.mkdirSync(dir)
  created.push(dir)
}

function put(
  root: string, dir: string, { file, before, after }: FileChange, created: string[], stagingDirs: string[],
): void {
  const target = checkedPath(root, `${dir}/${file}`)
  const mode = guard(target, before)
  if (before === after) return
  if (after === null) {
    fs.unlinkSync(target)
    return
  }
  const parent = path.dirname(target)
  makeParents(parent, created)
  const staging = fs.mkdtempSync(path.join(parent, '.trivia-'))
  stagingDirs.push(staging)
  const tmp = path.join(staging, 'document')
  fs.writeFileSync(tmp, after, { flag: 'wx', mode })
  if (mode !== undefined) fs.chmodSync(tmp, mode)
  guard(checkedPath(root, `${dir}/${file}`), before)
  if (before === null) {
    // Unlike a rename, linking a new file cannot replace a racing creation.
    try {
      fs.linkSync(tmp, target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw conflict(file)
      throw error
    }
  } else {
    fs.renameSync(tmp, target)
  }
}

/** Same guarded preflight and rollback as the native source transaction, for UTF-8 documents. */
export function commitDocuments(root: string, dir: string, writes: readonly FileChange[]): void {
  const created: string[] = []
  const staging: string[] = []
  const completed: FileChange[] = []
  try {
    if (new Set(writes.map(({ file }) => file)).size !== writes.length) {
      throw new ApiError('invalid_op', 'a document write batch may name each path only once')
    }
    for (const { file, before } of writes) guard(checkedPath(root, `${dir}/${file}`), before)
    for (const write of writes) {
      put(root, dir, write, created, staging)
      completed.push(write)
    }
    removeStaging(staging)
  } catch (error) {
    const failure = ioError(error)
    for (const { file, before, after } of completed.reverse()) {
      try {
        put(root, dir, { file, before: after, after: before }, created, staging)
      } catch (rollbackError) {
        failure.message += `\nRolling back ${file} failed: ${ioError(rollbackError).message}`
      }
    }
    try {
      removeStaging(staging)
    } catch (cleanupError) {
      failure.message += `\nRemoving staging files failed: ${ioError(cleanupError).message}`
    }
    for (const dir of created.reverse()) {
      try {
        fs.rmdirSync(dir)
      } catch (cleanupError) {
        if (!['ENOENT', 'ENOTEMPTY'].includes((cleanupError as NodeJS.ErrnoException).code ?? '')) {
          failure.message += `\nRemoving ${dir} failed: ${ioError(cleanupError).message}`
        }
      }
    }
    throw failure
  }
}


function removeStaging(staging: string[]): void {
  // Keep the failed path in the list so rollback also retries its cleanup.
  while (staging.length > 0) {
    fs.rmSync(staging[staging.length - 1]!, { recursive: true, force: true })
    staging.pop()
  }
}
