// The page the contract gives the active resource (docs/product.md, slice 6): the resource
// comes from the `resource` prop, else from Refine's route context. The page comes from Trivia's
// dev server, which reads trivia.manifest.json, so it is there even with no records.

import { useResourceParams } from '@refinedev/core'
import { useCallback, useEffect, useState } from 'react'

import { TriviaApiError, post } from '../api'
import type { InferredPage, OpenApiInferencerProps, PageKind } from '../types'

export interface ResourceContract {
  /** The resource asked for, or null when neither the props nor the route name one. */
  resource: string | null
  page: InferredPage | null
  isLoading: boolean
  error: TriviaApiError | null
  /** Ask again (after a sync, say). */
  reload(): void
}

/** The body of a `refine/preview` request. */
export function previewRequest(resource: string, kind: PageKind, props: OpenApiInferencerProps): Record<string, unknown> {
  return {
    resource,
    kind,
    ...(props.hideFields && props.hideFields.length > 0 ? { hide: props.hideFields } : {}),
    ...(props.title ? { title: props.title } : {}),
    ...(props.ejectPath ? { file: projectPath(props.ejectPath) } : {}),
  }
}

/**
 * `path` as the dev server wants it: project-relative with forward slashes (`./src/a.tsx`,
 * `/src/a.tsx` and `src\a.tsx` are all `src/a.tsx`). The server refuses anything outside `src/`.
 */
export function projectPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^(\.\/|\/)+/, '')
}

/** True in a production build, where there is no dev server to ask. */
function isProduction(): boolean {
  return (import.meta as { env?: { PROD?: boolean } }).env?.PROD === true
}

export function useResourceContract(kind: PageKind, props: OpenApiInferencerProps, fetcher?: typeof fetch): ResourceContract {
  const { resource: active } = useResourceParams()
  const resource = props.resource ?? active?.name ?? null
  const [state, setState] = useState<{ page: InferredPage | null; error: TriviaApiError | null; isLoading: boolean }>({ page: null, error: null, isLoading: resource !== null })
  const [attempt, setAttempt] = useState(0)
  const key = resource === null ? null : JSON.stringify(previewRequest(resource, kind, props))

  useEffect(() => {
    if (key === null) {
      setState({ page: null, error: null, isLoading: false })
      return
    }
    if (isProduction()) {
      setState({ page: null, isLoading: false, error: new TriviaApiError('production', 'The inferencer only works on the dev server: eject the page, or render the real one, before building.') })
      return
    }
    let live = true
    setState((s) => ({ ...s, isLoading: true }))
    post<InferredPage>('/refine/preview', JSON.parse(key), fetcher)
      .then((page) => live && setState({ page, error: null, isLoading: false }))
      .catch((error: unknown) => {
        if (!live) return
        setState({ page: null, isLoading: false, error: error instanceof TriviaApiError ? error : new TriviaApiError('internal', String(error)) })
      })
    return () => {
      live = false
    }
  }, [key, attempt, fetcher])

  const reload = useCallback(() => setAttempt((n) => n + 1), [])
  return { resource, ...state, reload }
}
