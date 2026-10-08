import { describe, expect, it } from 'vitest'

import { isMac } from '@/shared/lib/env'
import { formatShortcut, isTypingTarget } from '@/shared/lib/keyboard'

import { commandFor } from './shortcuts'

/** A keydown as the browser would report it, from a target with the given tag. */
function key(init: Partial<KeyboardEvent> & { key: string }, target: object = { tagName: 'BODY', getAttribute: () => null }): KeyboardEvent {
  const mod = isMac ? { metaKey: true } : { ctrlKey: true }
  const { primary, ...rest } = init as Partial<KeyboardEvent> & { key: string; primary?: boolean }
  return {
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    code: '',
    defaultPrevented: false,
    isComposing: false,
    target,
    ...(primary ? mod : {}),
    ...rest,
  } as unknown as KeyboardEvent
}

const textInput = { tagName: 'INPUT', type: 'text', isContentEditable: false, getAttribute: () => null }

describe('shortcuts', () => {
  it('maps the history and zoom shortcuts', () => {
    const primary = { primary: true } as Partial<KeyboardEvent>
    expect(commandFor(key({ key: 'z', ...primary }))).toBe('undo')
    expect(commandFor(key({ key: 'Z', shiftKey: true, ...primary }))).toBe('redo')
    expect(commandFor(key({ key: 'y', ...primary }))).toBe('redo')
    expect(commandFor(key({ key: '=', ...primary }))).toBe('zoomIn')
    expect(commandFor(key({ key: '+', shiftKey: true, ...primary }))).toBe('zoomIn')
    expect(commandFor(key({ key: '-', ...primary }))).toBe('zoomOut')
    expect(commandFor(key({ key: '0', ...primary }))).toBe('zoomReset')
    expect(commandFor(key({ key: '!', code: 'Digit1', shiftKey: true }))).toBe('zoomFit')
    expect(commandFor(key({ key: '/' }))).toBe('search')
    expect(commandFor(key({ key: 'z' }))).toBeNull()
  })

  it('leaves undo to text fields while typing (from any realm), but still zooms', () => {
    const primary = { primary: true } as Partial<KeyboardEvent>
    expect(commandFor(key({ key: 'z', ...primary }, textInput))).toBeNull()
    expect(commandFor(key({ key: '/' }, textInput))).toBeNull()
    expect(commandFor(key({ key: '=', ...primary }, textInput))).toBe('zoomIn')
  })

  it('ignores events another handler took, IME composition, and Alt chords', () => {
    const primary = { primary: true } as Partial<KeyboardEvent>
    expect(commandFor(key({ key: 'z', defaultPrevented: true, ...primary }))).toBeNull()
    expect(commandFor(key({ key: 'z', isComposing: true, ...primary }))).toBeNull()
    expect(commandFor(key({ key: 'z', altKey: true, ...primary }))).toBeNull()
  })

  it('recognizes typing targets by tag, not instanceof', () => {
    expect(isTypingTarget(textInput as unknown as EventTarget)).toBe(true)
    expect(isTypingTarget({ ...textInput, type: 'checkbox' } as unknown as EventTarget)).toBe(false)
    expect(isTypingTarget({ tagName: 'TEXTAREA' } as unknown as EventTarget)).toBe(true)
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)).toBe(true)
    expect(isTypingTarget({ tagName: 'BUTTON', getAttribute: () => null } as unknown as EventTarget)).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })

  it('formats shortcuts for the platform', () => {
    expect(formatShortcut('mod+shift+z')).toBe(isMac ? '⇧⌘Z' : 'Ctrl+Shift+Z')
    expect(formatShortcut('mod+=')).toBe(isMac ? '⌘+' : 'Ctrl++')
    expect(formatShortcut('shift+1')).toBe(isMac ? '⇧1' : 'Shift+1')
  })
})
