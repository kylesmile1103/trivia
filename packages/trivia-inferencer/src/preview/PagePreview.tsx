// The inferred page, live: the dev server's module for it (`/@trivia/preview/<id>.tsx`) is the
// code Eject would write, compiled by Vite with the app's own aliases and components. Rendered
// here, inside the app's <Refine>, it reads the real data provider. One generator, so the preview
// can never differ from the file.

import { Component, type ComponentType, type ReactNode, Suspense, lazy, useMemo } from 'react'

import type { InferredPage } from '../types'
import { styles } from './styles'

/** Loads a module by URL; the dev server's own `import()` by default. */
export type ModuleLoader = (url: string) => Promise<Record<string, unknown>>

export const importModule: ModuleLoader = (url) => import(/* @vite-ignore */ url) as Promise<Record<string, unknown>>

export function PagePreview({ page, load }: { page: InferredPage; load: ModuleLoader }) {
  const Page = useMemo(
    () =>
      lazy(async () => {
        const module = await load(page.module)
        const exported = module[page.component]
        if (typeof exported !== 'function') throw new Error(`${page.module} exports no ${page.component}`)
        return { default: exported as ComponentType }
      }),
    [page.module, page.component, load],
  )
  return (
    <PreviewBoundary key={page.module}>
      <Suspense fallback={<p style={styles.note}>Loading the inferred page…</p>}>
        <Page />
      </Suspense>
    </PreviewBoundary>
  )
}

/** Shows why the page could not render (a compile error, a contract the page no longer fits) instead of blanking the route. */
class PreviewBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  override render() {
    if (this.state.error) {
      return (
        <div role="alert" style={styles.error}>
          The inferred page failed to render: {this.state.error.message}
        </div>
      )
    }
    return this.props.children
  }
}
