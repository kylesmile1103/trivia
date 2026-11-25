import { modelBaselineSchema, type ModelBaseline } from '@trivia/blueprint'

import { CompileError } from './compile.js'
import { compareBytes } from './print/style.js'

export const LOCK_FILE = 'blueprint.lock.json'

export interface LockedPage {
  file: string
  hash: string
  /** Older lock records contained only file and hash. */
  blueprintRev?: string
  route?: string
  component?: string
  /** Sibling source modules written and guarded with the route entry. */
  additional?: Record<string, string>
}

export interface Lock {
  lockVersion: 1
  compiler?: string
  model?: ModelBaseline
  pages: Record<string, LockedPage>
}

export const emptyLock = (): Lock => ({ lockVersion: 1, pages: {} })

const hash = /^sha256:[a-f0-9]{64}$/
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function readLock(text: string | null): Lock {
  if (text === null) return emptyLock()
  try {
    const value: unknown = JSON.parse(text)
    if (!record(value) || value.lockVersion !== 1 || !record(value.pages)) throw new Error('expected lockVersion 1 and pages')
    if (value.compiler !== undefined && typeof value.compiler !== 'string') throw new Error('invalid compiler version')
    const entries = Object.entries(value.pages).map(([name, page]): [string, LockedPage] => {
      if (!record(page) || typeof page.file !== 'string' || typeof page.hash !== 'string' || !hash.test(page.hash)) {
        throw new Error('invalid page ' + name)
      }
      const { file, hash: content, blueprintRev, route, component, additional } = page
      if (blueprintRev !== undefined && (typeof blueprintRev !== 'string' || !hash.test(blueprintRev))) throw new Error('invalid revision for ' + name)
      if (route !== undefined && typeof route !== 'string') throw new Error('invalid route for ' + name)
      if (component !== undefined && typeof component !== 'string') throw new Error('invalid component for ' + name)
      if (additional !== undefined && (!record(additional) ||
        Object.entries(additional).some(([path, digest]) => path === file || typeof digest !== 'string' || !hash.test(digest)))) {
        throw new Error('invalid sibling modules for ' + name)
      }
      return [name, {
        file, hash: content, ...(blueprintRev !== undefined && { blueprintRev }),
        ...(route !== undefined && { route }), ...(component !== undefined && { component }),
        ...(additional !== undefined && { additional: additional as Record<string, string> }),
      }]
    })
    return {
      lockVersion: 1,
      ...(value.compiler !== undefined && { compiler: value.compiler }),
      ...(value.model !== undefined && { model: modelBaselineSchema.parse(value.model) }),
      pages: Object.fromEntries(entries),
    }
  } catch (error) {
    throw new CompileError('conflict', 'Invalid blueprint lock: ' + (error as Error).message)
  }
}

export function serializeLock(lock: Lock): string {
  return JSON.stringify({
    lockVersion: 1,
    ...(lock.compiler !== undefined && { compiler: lock.compiler }),
    ...(lock.model !== undefined && { model: lock.model }),
    pages: Object.fromEntries(Object.entries(lock.pages).sort(([a], [b]) => compareBytes(a, b))),
  }, null, 2) + '\n'
}
