// Gesture plumbing shared by the numeric controls: a draft value while the user scrubs,
// previewed as CSS, committed (converted to Tailwind) on release.

import { useState } from 'react'

import { formatNumber, remString } from '../tailwind'
import { type Declarations, PANEL_THEME, useEditor } from './editor'

/**
 * px → the CSS the preview uses and the converter reads back: rem on the spacing scale's
 * half-step grid (what Tailwind itself emits, so `24` → `1.5rem` → `p-6`), exact px otherwise
 * (`13` → `13px` → `p-[13px]`).
 */
export function lengthCss(px: number): string {
  const steps = Math.abs(px) / PANEL_THEME.spacingPx
  const onGrid = Math.abs(steps * 2 - Math.round(steps * 2)) < 1e-6 && steps <= PANEL_THEME.spacingMax
  return onGrid ? remString(px) : `${formatNumber(px)}px`
}

/** Exact px, for scales the panel never maps lengths onto (radius, font size). */
export function pxCss(px: number): string {
  return `${formatNumber(px)}px`
}

export interface Gesture {
  /** The value being scrubbed, or null between gestures. */
  draft: number | null
  change(value: number): void
  commit(value: number): void
  commitText(text: string): void
  cancel(): void
}

/**
 * @param toStyle the declarations one value stands for (`v => ({ 'padding-inline': v })`)
 * @param label   history label prefix ("Padding X")
 * @param toCss   how a number becomes a CSS value
 */
export function useGesture(toStyle: (css: string) => Declarations, label: string, toCss: (n: number) => string = lengthCss): Gesture {
  const editor = useEditor()
  const [draft, setDraft] = useState<number | null>(null)
  return {
    draft,
    change(value) {
      setDraft(value)
      editor.preview(toStyle(toCss(value)))
    },
    commit(value) {
      setDraft(null)
      editor.commitStyle(toStyle(toCss(value)), label)
    },
    commitText(text) {
      setDraft(null)
      editor.commitStyle(toStyle(text), label)
    },
    cancel() {
      setDraft(null)
      editor.preview(null)
    },
  }
}
