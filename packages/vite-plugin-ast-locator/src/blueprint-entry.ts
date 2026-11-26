// The development route for blueprint previews (docs/blueprint/lld/LLD-05-react-codegen.md, §5):
// a small client entry the plugin injects beside a Refine app's routes, so the canvas can open
// `/__blueprint/<Name>` without touching the app's router file.

/** The entry's file name among the preview modules (`/@trivia/preview/<name>`). */
export const BLUEPRINT_ENTRY = 'blueprint-route.tsx'

/** The route the entry is mounted at. */
export const BLUEPRINT_ROUTE = '/__blueprint/:triviaPage'

/**
 * The custom hot event sent after every blueprint document write (host.ts, invalidatePreviews).
 * The entry is static and never invalidated; a preview that loaded reloads through its own module.
 */
export const BLUEPRINTS_CHANGED = 'trivia:blueprints-changed'

/**
 * The entry's code. A preview that failed to load (a compile error, a page that does not exist
 * yet) loaded no module that a write could invalidate, so it reloads the page on the next
 * BLUEPRINTS_CHANGED instead. A preview that loaded ignores the event.
 */
export const blueprintEntry = [
  'import { lazy, Suspense, useMemo } from "react"',
  'import { useParams } from "react-router"',
  'export function TriviaBlueprintRoute() {',
  '  const { triviaPage: page } = useParams()',
  '  const Preview = useMemo(() => lazy(async () => {',
  '    const response = await fetch("/@trivia/api/blueprint/preview", {',
  '      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ page }),',
  '    })',
  '    const result = await response.json()',
  '    if (!result.ok) {',
  '      import.meta.hot?.on(' + JSON.stringify(BLUEPRINTS_CHANGED) + ', () => location.reload())',
  '      throw new Error(result.error.message)',
  '    }',
  '    return import(/* @vite-ignore */ result.data.module)',
  '  }), [page])',
  '  return <Suspense fallback={null}><Preview /></Suspense>',
  '}',
].join('\n')
