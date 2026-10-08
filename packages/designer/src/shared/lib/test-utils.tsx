// jsdom helpers for component tests (test files that start with
// `// @vitest-environment jsdom`). Only tests import this module; the app never does.

import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'

import { TooltipProvider } from '@/shared/ui/tooltip'

// React warns about updates outside act() unless it knows it runs under a test runner.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
// Radix measures with ResizeObserver, which jsdom lacks.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

export interface Mounted {
  host: HTMLElement
  render(ui: ReactNode): Promise<void>
  unmount(): Promise<void>
}

/** Render `ui` (inside the TooltipProvider the designer shell provides) into a fresh host. */
export async function mount(ui: ReactNode): Promise<Mounted> {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const render = async (next: ReactNode) => {
    await act(async () => root.render(<TooltipProvider>{next}</TooltipProvider>))
  }
  await render(ui)
  let mounted = true
  return {
    host,
    render,
    unmount: async () => {
      if (!mounted) return
      mounted = false
      await act(async () => root.unmount())
      host.remove()
    },
  }
}

/** Let pending promises, effects and timers up to `ms` run. */
export async function settle(ms = 0): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, i === 0 ? ms : 0))
    })
  }
}

/** Type into a React-controlled input: set the value natively, then fire `input`. */
export async function typeInto(input: HTMLInputElement, text: string): Promise<void> {
  await act(async () => {
    input.focus()
  })
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** Fire a keydown on `target` (it bubbles to the window, like a real key) and return it. */
export async function press(target: Element, init: KeyboardEventInit): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  await act(async () => {
    target.dispatchEvent(event)
  })
  return event
}

/** `query` in `root`, or a failed test naming what was missing. */
export function find<T extends Element = HTMLElement>(root: ParentNode, query: string): T {
  const el = root.querySelector<T>(query)
  if (el === null) throw new Error(`nothing matches ${query}`)
  return el
}
