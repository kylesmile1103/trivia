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
    expect(history.state()).toEqual({ canUndo: false, canRedo: true, undoLabel: null, redoLabel: '3' })
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
