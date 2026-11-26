import { describe, expect, it } from 'vitest'

import { History } from '../src/api/history.js'

describe('History', () => {
  const entry = (label: string) => ({ label, changes: [{ file: 'a.tsx', before: '', after: label }] })

  it('caps the undo stack, dropping the oldest entries', () => {
    const history = new History(3)
    for (const label of ['1', '2', '3', '4', '5']) history.record(entry(label))
    const labels: string[] = []
    while (history.nextUndo) {
      labels.push(history.nextUndo.label)
      history.undone()
    }
    expect(labels).toEqual(['5', '4', '3'])
    expect(history.state()).toEqual({ canUndo: false, canRedo: true, undoLabel: null, redoLabel: '3', lastWriteAt: expect.any(Number) })
  })

  it('notes when a write last landed: a recorded edit, an undo or a redo', () => {
    let now = 1_000
    const history = new History(100, () => now)
    expect(history.state().lastWriteAt).toBeNull()
    history.undone() // nothing to undo: nothing was written
    expect(history.state().lastWriteAt).toBeNull()
    now = 2_000
    history.record(entry('a'))
    expect(history.state().lastWriteAt).toBe(2_000)
    now = 3_000
    history.undone()
    expect(history.state().lastWriteAt).toBe(3_000)
    now = 4_000
    history.redone()
    expect(history.state().lastWriteAt).toBe(4_000)
    now = 5_000
    history.redone() // nothing to redo
    expect(history.state().lastWriteAt).toBe(4_000)
  })

  it('defaults to 100 entries', () => {
    const history = new History()
    for (let i = 0; i < 150; i++) history.record(entry(String(i)))
    let n = 0
    while (history.nextUndo) {
      history.undone()
      n++
    }
    expect(n).toBe(100)
  })
})
