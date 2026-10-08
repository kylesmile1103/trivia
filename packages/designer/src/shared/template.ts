// What the palette inserts and the canvas drops: the contract between the two features.

import type { ImportSpec } from '@/shared/engine/types'

/** One insertable element: what a palette item writes into the user's source. */
export interface Template {
  /** Primary component, e.g. "Card". */
  component: string
  label: string
  /** Exactly one JSX element, unindented (the engine indents it). */
  snippet: string
  imports: ImportSpec[]
}

/** dataTransfer type carrying a JSON `Template` (set by the palette, read by the canvas on drop). */
export const TEMPLATE_MIME = 'application/x-trivia-template'
