// Placeholder — implemented by the style workstream (Tailwind spacing/layout controls with
// CSS→Tailwind conversion and live preview).

export interface StylePanelProps {
  /** Selected node locator. */
  locator: string
  /** Current user-authored className (literal string), or "" when absent. */
  className: string
  /** Live preview during a gesture: CSS declarations (kebab-case), or null to clear. */
  onPreview(style: Record<string, string> | null): void
  /** Commit: the full new className to write via updateProp. */
  onCommit(className: string): void
}

export function StylePanel(_props: StylePanelProps) {
  return null
}
