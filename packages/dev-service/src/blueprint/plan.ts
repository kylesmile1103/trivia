import { pageDocPath, revOfText } from '@trivia/blueprint'
import { LOCK_FILE, planCompiledEject, prepareEject, readLock, serializeLock, type Lock } from '@trivia/blueprint-compiler'
import { z } from 'zod'

import type { EngineService, Json } from '../api/service.js'
import { ApiError } from '../engine.js'
import { compilerError, type RegistryItem } from './preview.js'
import { readBytes, type BlueprintWorkspace } from './store.js'

export interface EjectPlan {
  ops: Array<Json & { op: string }>
  files: string[]
  requires: RegistryItem[]
  warnings: string[]
  lock: Lock
  label: string
}

const pages = z.array(z.string().min(1))
export const planInput = z.strictObject({ pages: pages.optional() })
export const ejectedInput = z.strictObject({ pages, entry: z.string().min(1) })
export const ejectInput = planInput.extend({ label: z.string().trim().min(1) })

export async function planEject(request: z.infer<typeof planInput>, service: EngineService): Promise<EjectPlan> {
  const { blueprint, context } = await service.blueprintInputs()
  const workspace = service.blueprint
  const before = workspace.readDocumentText(LOCK_FILE)
  try {
    const baseline = readLock(before)
    const prepared = prepareEject(blueprint, request.pages, context, baseline)
    const files = new Map<string, string>()
    for (const { module } of prepared) {
      for (const file of [module.file, module.handler?.file]) {
        if (!file) continue
        const bytes = readBytes(workspace.root, file)
        if (bytes !== null) files.set(file, bytes.toString('utf8'))
      }
    }
    const health = service.health()
    const routes = await service.routes()
    const { registrations, ops, ...plan } = planCompiledEject(prepared, { compiler: health.version, files, routes }, baseline)
    const registration = await service.refine.planBlueprintRegistrations(registrations, context.contract ?? null)
    const file = workspace.dir + '/' + LOCK_FILE
    const content = serializeLock(plan.lock)
    const lock = before === null ? { op: 'createFile', file, content } : { op: 'replaceFile', file, content, expectedHash: revOfText(before) }
    return {
      ...plan,
      ops: [...ops, ...registration as EjectPlan['ops'], lock],
    }
  } catch (error) {
    return compilerError(error)
  }
}

/** The lock travels in the source transaction. Recheck the draft guards while holding its queue. */
export function validateEjectLock(workspace: BlueprintWorkspace, ops: readonly Json[]): void {
  const lockOps = ops.filter((op) => typeof op.file === 'string' && op.file.split('/').at(-1) === LOCK_FILE)
  if (!lockOps.length) return
  const [lock] = lockOps
  if (!lock || lockOps.length !== 1 || ops.at(-1) !== lock || lock.file !== workspace.dir + '/' + LOCK_FILE ||
      (lock.op !== 'createFile' && lock.op !== 'replaceFile') || lock.ifMissing || typeof lock.content !== 'string') {
    throw new ApiError('invalid_op', 'The blueprint lock must be the last operation of an eject batch.')
  }
  try {
    const before = readLock(workspace.readDocumentText(LOCK_FILE))
    const after = readLock(lock.content)
    const revs: Record<string, string | null> = {}
    for (const name of Object.keys(before.pages)) {
      if (!Object.hasOwn(after.pages, name)) throw new ApiError('conflict', 'An eject cannot remove the lock record for ' + name)
    }
    for (const [name, record] of Object.entries(after.pages)) {
      const source = ops.find((op) => op !== lock && op.file === record.file && (op.op === 'createFile' || op.op === 'replaceFile'))
      if (!source && JSON.stringify(record) === JSON.stringify(before.pages[name])) continue
      if (typeof source?.content !== 'string' || revOfText(source.content) !== record.hash) throw new ApiError('invalid_op', 'No matching source operation for ' + name)
      const doc = pageDocPath(name)
      const content = workspace.readDocumentText(doc)
      const actual = content === null ? null : revOfText(content)
      if (actual !== record.blueprintRev) revs[doc] = actual
    }
    if (Object.keys(revs).length) throw new ApiError('conflict', 'The blueprint changed since eject was planned.', { revs })
  } catch (error) {
    compilerError(error)
  }
}
