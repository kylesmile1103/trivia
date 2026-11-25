/** Runs tasks one at a time, in arrival order. A failed task does not block the next one. */
export class SerialQueue {
  #tail: Promise<unknown> = Promise.resolve()

  run<T>(task: () => T | Promise<T>): Promise<T> {
    const result = this.#tail.then(() => task())
    this.#tail = result.catch(() => undefined)
    return result
  }
}
