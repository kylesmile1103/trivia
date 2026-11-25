// Value ops: setProp, setBinding, setStyle, setControl (T015).
import type { OpOf } from '../types/ops.js'
import { refuse, type Draft } from './draft.js'

const pending = (op: string): never => refuse('invalid_op', `${op} is not implemented yet (T015)`)

export function setProp(_draft: Draft, op: OpOf<'setProp'>): void {
  pending(op.op)
}
export function setBinding(_draft: Draft, op: OpOf<'setBinding'>): void {
  pending(op.op)
}
export function setStyle(_draft: Draft, op: OpOf<'setStyle'>): void {
  pending(op.op)
}
export function setControl(_draft: Draft, op: OpOf<'setControl'>): void {
  pending(op.op)
}
