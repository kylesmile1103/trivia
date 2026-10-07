// Drag-and-drop templates for components found in the user's src/components/ui.
// Implemented by the shell/registry workstream; this is the contract.

import type { ComponentSchema, ImportSpec } from '@/bridge/types'

export interface Template {
  /** Primary component, e.g. "Card". */
  component: string
  label: string
  /** Exactly one JSX element, unindented (the engine indents it). */
  snippet: string
  imports: ImportSpec[]
}

export function templatesFor(components: ComponentSchema[]): Template[] {
  return components.map((c) => ({
    component: c.name,
    label: c.name,
    snippet: c.acceptsChildren ? `<${c.name}>${c.name}</${c.name}>` : `<${c.name} />`,
    imports: [{ name: c.name, source: c.importSource }],
  }))
}
