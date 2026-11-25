// App ops: setApp, setNav (T017).
import type { OpOf } from '../types/ops.js'
import { refuse, type Draft } from './draft.js'

const pending = (op: string): never => refuse('invalid_op', `${op} is not implemented yet (T017)`)

export function setApp(_draft: Draft, op: OpOf<'setApp'>): void {
  pending(op.op)
}
export function setNav(_draft: Draft, op: OpOf<'setNav'>): void {
  pending(op.op)
}
