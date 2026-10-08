// Engine details (`GET /inspect`) for locators the canvas draws or drops onto: the JSX tag name
// for labels and `expectedName`, and `isDirect`, which the DOM cannot tell (a node inside
// `{cond && …}` renders like any other). Cached per locator until the next HMR settle, since
// locators are positions and shift with every edit.

import { engine } from '@/shared/engine/client'
import type { NodeDetails } from '@/shared/engine/types'

type Entry = { ok: true; details: NodeDetails } | { ok: false; error: unknown }

export class NodeInfo {
  private readonly done = new Map<string, Entry>()
  private readonly inflight = new Map<string, Promise<NodeDetails>>()
  private generation = 0

  private readonly onResolve: () => void

  /** `onResolve` runs whenever a lookup lands, so views can redraw with the real name. */
  constructor(onResolve: () => void) {
    this.onResolve = onResolve
  }

  /** Cached details, or undefined (and a background lookup) when not known yet. */
  peek(locator: string): NodeDetails | undefined {
    const entry = this.done.get(locator)
    if (!entry) {
      this.load(locator).catch(() => {}) // failures stay cached; `load` callers see them
      return undefined
    }
    return entry.ok ? entry.details : undefined
  }

  load(locator: string): Promise<NodeDetails> {
    const entry = this.done.get(locator)
    if (entry) return entry.ok ? Promise.resolve(entry.details) : Promise.reject(entry.error)
    const pending = this.inflight.get(locator)
    if (pending) return pending
    const generation = this.generation
    const settle = (e: Entry) => {
      if (generation !== this.generation) return
      this.inflight.delete(locator)
      this.done.set(locator, e)
      this.onResolve()
    }
    const request = engine.inspect(locator).then(
      (details) => {
        settle({ ok: true, details })
        return details
      },
      (error: unknown) => {
        settle({ ok: false, error })
        throw error
      },
    )
    this.inflight.set(locator, request)
    return request
  }

  /** Details someone else already fetched (the shell's `store.details`). */
  seed(details: NodeDetails): void {
    this.done.set(details.locator, { ok: true, details })
  }

  clear(): void {
    this.generation++
    this.done.clear()
    this.inflight.clear()
  }
}
