// Logic ops: setState, removeState, setQuery, removeQuery, setActions (T016).
import type { OpOf } from '../types/ops.js'
import { refuse, type Draft } from './draft.js'

const pending = (op: string): never => refuse('invalid_op', `${op} is not implemented yet (T016)`)

export function setState(_draft: Draft, op: OpOf<'setState'>): void {
  pending(op.op)
}
export function removeState(_draft: Draft, op: OpOf<'removeState'>): void {
  pending(op.op)
}
export function setQuery(_draft: Draft, op: OpOf<'setQuery'>): void {
  pending(op.op)
}
export function removeQuery(_draft: Draft, op: OpOf<'removeQuery'>): void {
  pending(op.op)
}
export function setActions(_draft: Draft, op: OpOf<'setActions'>): void {
  pending(op.op)
}
