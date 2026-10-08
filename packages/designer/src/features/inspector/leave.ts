// Leaving an element with an edit in progress.
//
// A canvas click selects the clicked node on pointerdown, and the inspector re-renders for it
// before the browser moves focus: the field being typed in is unmounted, and React never
// delivers its blur. So a field holding an uncommitted value decides when it unmounts, the way
// Figma behaves when you type a value and click another layer:
//
// - Fields that commit on blur (prop text setters, the style panel's number fields, slider key
//   changes still settling) commit what they hold to the element they were editing: its old
//   locator and expectedName. commit.ts applies that edit without moving the selection back.
// - Fields that apply only on Enter ("Add classes", "Add prop") never write a half-typed value
//   on the way out; a toast says what was not applied.
// - A field that unmounts while its element is still selected was not left: the source changed
//   under it (the value became an expression, the element is gone, the file no longer parses).
//   Writing then could overwrite the user's code, so nothing is written; a toast says so.

import { toast } from 'sonner'

import { designer } from '@/shared/state/store'

/** True when the selection has moved off `locator`: a field unmounting now is being left. */
export function selectionLeft(locator: string): boolean {
  return designer.getState().selected !== locator
}

/** Tell the user an edit they made was dropped, and why. */
export function notApplied(what: string, why: string): void {
  toast.warning(`${what} not applied`, { description: why })
}

/** Why an edit was dropped when its element is still selected (see the header). */
export const SOURCE_CHANGED = 'The element changed in source while you were editing.'
