// Visual style controls that write native Tailwind classes — never `style={{…}}`.
//
// The panel reads the selected element's user-authored className (parsed by lib/tailwind),
// previews gestures as real CSS through `onPreview`, and on release hands the embedder one
// new className (CSS → Tailwind, merged with tailwind-merge rules). Discrete choices commit
// immediately. See editor.ts for the two-phase model.
//
// Standalone dev harness (no inspector needed):
//   http://localhost:<designer port>/__trivia/src/inspector/style/harness/index.html?locator=<locator>
// It renders the user's app in an iframe, lets you click an element, and wires this panel to
// the real engine through the action bus (see harness/main.tsx).

import { AppearanceSection } from './AppearanceSection'
import { type StyleEditorProps, StyleEditorContext, useStyleEditor } from './editor'
import { LayoutSection } from './LayoutSection'
import { SizeSection } from './SizeSection'
import { BoxSection } from './SpacingControls'
import { TypographySection } from './TypographySection'

export interface StylePanelProps {
  /** Selected node locator. */
  locator: string
  /**
   * Current user-authored className (literal string), or "" when absent. Only render the panel
   * for a literal (or absent) className: a commit replaces the whole attribute value, so an
   * expression like `className={cn(…)}` would be overwritten.
   */
  className: string
  /**
   * Live preview during a gesture: CSS declarations (kebab-case), or null to clear. After a
   * commit the panel sends null once the canvas re-rendered (the store's `revision` moved after
   * HMR, at most 1.5s later), so the element does not flash back while the write lands.
   */
  onPreview(style: Record<string, string> | null): void
  /**
   * Commit: the full new className to write via updateProp. `label` names the edit for history
   * ("Padding p-6"). Returning the dispatch promise lets the panel drop its optimistic value
   * when the write fails (the promise resolves to null/false or rejects).
   */
  onCommit(className: string, label?: string): void | Promise<unknown>
}

export function StylePanel(props: StylePanelProps) {
  // Gesture and mode state belong to one element; a new selection starts fresh.
  return <StylePanelBody key={props.locator} {...props} />
}

function StylePanelBody(props: StyleEditorProps) {
  const editor = useStyleEditor(props)
  return (
    <StyleEditorContext value={editor}>
      <div data-slot="style-panel" className="flex flex-col text-xs">
        <LayoutSection />
        <BoxSection property="padding" />
        <BoxSection property="margin" />
        <SizeSection />
        <AppearanceSection />
        <TypographySection />
        <div className="flex flex-col gap-1.5 px-3 py-3">
          <span className="text-xs font-medium text-foreground">Classes</span>
          <code
            data-testid="style-classname"
            className="block min-h-7 rounded-md bg-muted/60 px-2 py-1.5 font-mono text-[11px] leading-relaxed break-all text-muted-foreground select-text"
          >
            {editor.className.trim() || <span className="italic opacity-70">none</span>}
          </code>
        </div>
      </div>
    </StyleEditorContext>
  )
}
