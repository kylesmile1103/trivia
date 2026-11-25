// Screenshots for agents (trivia_screenshot, docs/mcp.md). The plugin has no browser; the
// designer does. So a request waits here until an open designer, which long-polls
// GET /screenshot/next, takes it, renders the canvas to a PNG and POSTs it back.

import { randomUUID } from 'node:crypto'

import { ApiError } from '../engine.js'

export interface Screenshot {
  /** PNG, base64 (no data: prefix). */
  png: string
  width: number
  height: number
}

interface Pending {
  id: string
  resolve(shot: Screenshot): void
  reject(error: ApiError): void
  taken: boolean
}

export class ScreenshotRelay {
  readonly #pending: Pending[] = []
  readonly #waiters: Array<(request: { id: string }) => void> = []

  /** A screenshot from the open designer, or an error when none answers within `timeoutMs`. */
  request(timeoutMs: number): Promise<Screenshot> {
    return new Promise<Screenshot>((resolve, reject) => {
      const pending: Pending = { id: randomUUID(), resolve, reject, taken: false }
      const timer = setTimeout(() => {
        this.#remove(pending)
        reject(
          new ApiError(
            'unsupported',
            pending.taken
              ? 'the designer took the screenshot request but sent nothing back in time'
              : 'no Trivia designer is open to take the screenshot: ask the user to open it (its canvas is what gets captured)',
          ),
        )
      }, timeoutMs)
      pending.resolve = (shot) => {
        clearTimeout(timer)
        resolve(shot)
      }
      pending.reject = (error) => {
        clearTimeout(timer)
        reject(error)
      }
      this.#pending.push(pending)
      this.#hand()
    })
  }

  /**
   * The designer's long-poll: the next request's id, or null when none came within `timeoutMs`.
   * When `signal` aborts (the designer closed or reloaded), it stops waiting at once: a request
   * handed to a designer that is gone would go unanswered.
   */
  next(timeoutMs: number, signal?: AbortSignal): Promise<{ id: string | null }> {
    return new Promise((resolve) => {
      const done = (request: { id: string | null }) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', leave)
        const at = this.#waiters.indexOf(waiter)
        if (at >= 0) this.#waiters.splice(at, 1)
        resolve(request)
      }
      const leave = () => done({ id: null })
      const timer = setTimeout(leave, timeoutMs)
      const waiter = (request: { id: string }) => done(request)
      if (signal?.aborted) return leave()
      signal?.addEventListener('abort', leave, { once: true })
      this.#waiters.push(waiter)
      this.#hand()
    })
  }

  /** The designer's answer to request `id`: a screenshot, or why it couldn't take one. */
  fulfill(id: string, answer: { png: string; width: number; height: number } | { error: string }): void {
    const pending = this.#pending.find((p) => p.id === id)
    if (!pending) throw new ApiError('invalid_op', `no screenshot request ${id} is waiting (it may have timed out)`)
    this.#remove(pending)
    if ('error' in answer) pending.reject(new ApiError('unsupported', `the designer couldn't take the screenshot: ${answer.error}`))
    else pending.resolve(answer)
  }

  /** Give waiting requests to waiting designers, oldest first. */
  #hand(): void {
    while (this.#waiters.length > 0) {
      const pending = this.#pending.find((p) => !p.taken)
      if (!pending) return
      pending.taken = true
      this.#waiters.shift()?.({ id: pending.id })
    }
  }

  #remove(pending: Pending): void {
    const at = this.#pending.indexOf(pending)
    if (at >= 0) this.#pending.splice(at, 1)
  }
}
