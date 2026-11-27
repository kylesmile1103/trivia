// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'

import { HMR_READY, hasProbe, isConnected, whenConnected } from './vite-hmr'

type ProbeWindow = Window & typeof globalThis & { __TRIVIA_HMR__?: { ready: boolean } | null }

const frames: HTMLIFrameElement[] = []
afterEach(() => {
  for (const frame of frames.splice(0)) frame.remove()
})

/** A frame's window, with the plugin's probe as it is before its answer (`ready: false`) or after. */
function frameWindow(probe?: { ready: boolean } | null): ProbeWindow {
  const frame = document.createElement('iframe')
  document.body.append(frame)
  frames.push(frame)
  const win = frame.contentWindow as ProbeWindow
  if (probe !== undefined) win.__TRIVIA_HMR__ = probe
  return win
}

/** What the probe does on its answer (vite-plugin-ast-locator/src/hmr-probe.ts). */
function answer(win: ProbeWindow): void {
  win.__TRIVIA_HMR__!.ready = true
  win.dispatchEvent(new win.Event(HMR_READY))
}

describe('the Vite HMR probe the canvas relies on', () => {
  it('tells a page with the probe from one without', () => {
    expect(hasProbe(frameWindow({ ready: false }))).toBe(true)
    expect(hasProbe(frameWindow({ ready: true }))).toBe(true)
    expect(hasProbe(frameWindow())).toBe(false)
    expect(hasProbe(frameWindow(null))).toBe(false)
    expect(isConnected(frameWindow({ ready: false }))).toBe(false)
    expect(isConnected(frameWindow({ ready: true }))).toBe(true)
    expect(isConnected(frameWindow())).toBe(false)
  })

  it('calls back at once when the socket has answered already', () => {
    const onConnected = vi.fn()
    const stop = whenConnected(frameWindow({ ready: true }), onConnected)
    expect(onConnected).toHaveBeenCalledTimes(1)
    stop()
  })

  it('calls back once, on the probe’s event, when the answer comes later', () => {
    const win = frameWindow({ ready: false })
    const onConnected = vi.fn()
    whenConnected(win, onConnected)
    expect(onConnected).not.toHaveBeenCalled()
    answer(win)
    expect(onConnected).toHaveBeenCalledTimes(1)
    win.dispatchEvent(new win.Event(HMR_READY))
    expect(onConnected).toHaveBeenCalledTimes(1)
  })

  it('stops waiting when asked', () => {
    const win = frameWindow({ ready: false })
    const onConnected = vi.fn()
    const stop = whenConnected(win, onConnected)
    stop()
    answer(win)
    expect(onConnected).not.toHaveBeenCalled()
  })
})
