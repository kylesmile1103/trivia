// Validation in layers (LLD-01 section 5, FR-BP-05). Pure, never throws. Each layer sees only
// the documents no earlier layer found an error in, so one mistake is reported once, where it
// is, rather than again by every layer that trips over it.
import type { Blueprint } from '../store.js'
import type { Diagnostic } from '../types/diagnostics.js'
import type { LayerCheck, ValidationContext } from './context.js'
import { checkReferences } from './references.js'

export type { LayerCheck, ValidationContext } from './context.js'

/** Layers 1 and 2: what reading found (JSON, schema) and the references. A write needs both clean. */
export function validateStructure(blueprint: Blueprint): Diagnostic[] {
  return [...Object.values(blueprint.docs).flatMap((entry) => entry.diagnostics), ...checkReferences(blueprint)]
}

const failedDocs = (diagnostics: readonly Diagnostic[]) =>
  new Set(diagnostics.filter((d) => d.severity === 'error').map((d) => d.doc))

/** Every layer: the structure, then the manifests, the contract and the expressions from `ctx`. */
export function validate(blueprint: Blueprint, ctx: ValidationContext = {}): Diagnostic[] {
  const out = validateStructure(blueprint)
  const failed = failedDocs(out)
  const layers: Array<[string, LayerCheck | undefined]> = [
    ['manifests', ctx.manifests],
    ['contract', ctx.contract],
    ['expressions', ctx.expressions],
  ]
  for (const [name, check] of layers) {
    if (!check) continue
    const docs = Object.fromEntries(Object.entries(blueprint.docs).filter(([file, entry]) => entry.doc !== null && !failed.has(file)))
    let found: Diagnostic[]
    try {
      found = check({ exists: blueprint.exists, docs })
    } catch (error) {
      found = [{
        code: 'check_failed', severity: 'error', doc: '', pointer: '',
        message: `The ${name} check failed: ${error instanceof Error ? error.message : String(error)}`,
      }]
    }
    out.push(...found)
    for (const doc of failedDocs(found)) failed.add(doc)
  }
  return out
}
