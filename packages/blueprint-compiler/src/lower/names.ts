/** A module's generated locals, allocated once in deterministic lowering order. */
export class Names {
  readonly #used: Set<string>

  constructor(reserved: Iterable<string> = []) {
    this.#used = new Set(reserved)
  }

  take(preferred: string): string {
    let name = preferred
    for (let suffix = 2; this.#used.has(name); suffix++) name = preferred + suffix
    this.#used.add(name)
    return name
  }
}
