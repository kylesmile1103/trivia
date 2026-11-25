// The checks this package does not own (LLD-01 section 5, layers 3 to 5), injected so it
// needs neither the engine nor the network. Specs 002 (manifests), 003 (expressions) and the
// contract tooling plug in here.
import type { ModelBaseline } from '../model/baseline.js'
import type { Blueprint } from '../store.js'
import type { Diagnostic } from '../types/diagnostics.js'

export interface ValidationContext {
  /** Advisory comparison with the last successfully generated model (LLD-08). */
  modelBaseline?: ModelBaseline
  /** Layer 3, manifests (LLD-02): node types, props, events and slot content. */
  manifests?: LayerCheck
  /** Layer 4, the contract (trivia.manifest.json): resources, operations, option fields. */
  contract?: LayerCheck
  /** Layer 5, expressions (LLD-03): the `expr_*` codes. */
  expressions?: LayerCheck
  /** Layer 6, App Router constraints that require compiler facts (LLD-12). */
  next?: LayerCheck
}

/**
 * One layer's check. It sees only the documents every earlier layer passed (the others are
 * left out of `docs`), and returns diagnostics. A check that throws is reported as one
 * `check_failed` diagnostic instead of breaking validation.
 */
export type LayerCheck = (blueprint: Blueprint) => Diagnostic[]
