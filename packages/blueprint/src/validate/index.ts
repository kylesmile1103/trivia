// Validation in layers (LLD-01 section 5, FR-BP-05). Pure, never throws. Each layer skips the
// documents an earlier layer found errors in.
import type { Blueprint } from '../store.js'
import type { Diagnostic } from '../types/diagnostics.js'
import { checkReferences } from './references.js'

/** Layers 1 and 2: what reading found (JSON, schema) and the references. A write needs both clean. */
export function validateStructure(blueprint: Blueprint): Diagnostic[] {
  return [...Object.values(blueprint.docs).flatMap((entry) => entry.diagnostics), ...checkReferences(blueprint)]
}
