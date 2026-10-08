// Eject (docs/product.md, slice 6): Trivia's dev server writes the inferred page to disk and puts
// its component where the inferencer was, as one entry of the undo history it shares with the
// designer. The page's file then takes over through HMR.

import { useCallback, useState } from 'react'

import { TriviaApiError, post } from '../api'
import type { PageKind, Plan } from '../types'
import { projectPath } from './useResourceContract'

export interface EjectRequest {
  resource: string
  kind: PageKind
  /** Where to write the page (project-relative, under `src/`); default: the dev server's. */
  file?: string
  hideFields?: string[]
  title?: string
  /** The inferencer element's own locator (`data-ast-node`), so its route renders the page instead. */
  locator?: string
}

export type EjectStatus = 'idle' | 'ejecting' | 'done' | 'failed'

export interface EjectResult {
  /** The undo entry it made, e.g. "Eject CustomerList to src/pages/customers/list.tsx". */
  label: string
  /** What is left to do by hand (no locator: which element to swap). */
  warnings: string[]
}

/** The body of a `refine/eject` request. */
export function ejectPayload(request: EjectRequest): Record<string, unknown> {
  return {
    resource: request.resource,
    kind: request.kind,
    ...(request.file ? { file: projectPath(request.file) } : {}),
    ...(request.hideFields && request.hideFields.length > 0 ? { hide: request.hideFields } : {}),
    ...(request.title ? { title: request.title } : {}),
    ...(request.locator ? { locator: request.locator } : {}),
  }
}

/** Plan the eject, then apply it as one undo entry. */
export async function ejectToDisk(request: EjectRequest, fetcher?: typeof fetch): Promise<EjectResult> {
  const plan = await post<Plan>('/refine/eject', ejectPayload(request), fetcher)
  await post('/batch', { ops: plan.ops, label: plan.label }, fetcher)
  return { label: plan.label, warnings: plan.warnings ?? [] }
}

export function useEjectToDisk(fetcher?: typeof fetch) {
  const [status, setStatus] = useState<EjectStatus>('idle')
  const [error, setError] = useState<TriviaApiError | null>(null)
  const [result, setResult] = useState<EjectResult | null>(null)
  const eject = useCallback(
    async (request: EjectRequest): Promise<EjectResult | null> => {
      setStatus('ejecting')
      setError(null)
      try {
        const done = await ejectToDisk(request, fetcher)
        setResult(done)
        setStatus('done')
        return done
      } catch (e) {
        setError(e instanceof TriviaApiError ? e : new TriviaApiError('internal', String(e)))
        setStatus('failed')
        return null
      }
    },
    [fetcher],
  )
  return { status, error, result, eject }
}
