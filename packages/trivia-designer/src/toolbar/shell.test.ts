import { describe, expect, it } from 'vitest'

import { isMac } from '@/lib/env'
import { formatShortcut, isTypingTarget } from '@/lib/keyboard'
import { describeFailure } from '@/lib/session'
import { ApiError } from '@/bridge/client'
import { commandFor } from '@/toolbar/shortcuts'
import { ZOOM_MAX, ZOOM_MIN, clampZoom, formatZoom, stepZoom } from '@/toolbar/zoom'

describe('zoom', () => {
  it('steps through the stops and snaps off-stop values', () => {
    expect(stepZoom(1, 1)).toBe(1.25)
    expect(stepZoom(1, -1)).toBe(0.75)
    expect(stepZoom(0.8, 1)).toBe(1)
    expect(stepZoom(0.8, -1)).toBe(0.75)
    expect(stepZoom(0.7499999, 1)).toBe(1)
  })

  it('stays within 25–200%', () => {
    expect(stepZoom(ZOOM_MAX, 1)).toBe(ZOOM_MAX)
    expect(stepZoom(ZOOM_MIN, -1)).toBe(ZOOM_MIN)
    expect(clampZoom(5)).toBe(ZOOM_MAX)
    expect(clampZoom(0.01)).toBe(ZOOM_MIN)
    expect(clampZoom(Number.NaN)).toBe(1)
    expect(formatZoom(0.25)).toBe('25%')
  })
})

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

describe('describeFailure', () => {
  const url = 'http://localhost:4400/@trivia/api/health'
  const nonJson = (status: number) =>
    new ApiError({ code: 'internal', message: `engine returned non-JSON (HTTP ${status}); is vite-plugin-ast-locator installed in the app?` }, status)

  it('blames the proxied dev server when the proxy answers 5xx without JSON', () => {
    // Vite's proxy answers 502 with an empty body when the target refuses the connection.
    expect(describeFailure(nonJson(502), url)).toEqual({
      url,
      kind: 'proxy',
      status: 502,
      message: "HTTP 502 from the designer's proxy instead of an engine response",
    })
  })

  it('blames a missing plugin when the dev server answers with something else', () => {
    expect(describeFailure(nonJson(200), url).kind).toBe('plugin')
    expect(describeFailure(nonJson(404), url).kind).toBe('plugin')
  })

  it('reports the designer itself when the request never completed', () => {
    expect(describeFailure(new ApiError({ code: 'io_error', message: 'engine unreachable' }, 0), url).kind).toBe('designer')
  })

  it('passes engine errors through', () => {
    const failure = describeFailure(new ApiError({ code: 'forbidden', message: 'refusing a request' }, 403), url)
    expect(failure).toEqual({ url, kind: 'engine', status: 403, message: 'refusing a request' })
  })
})
