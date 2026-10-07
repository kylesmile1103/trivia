// Loads engine details for the selected node: on selection change, on every canvas revision
// (HMR) and on demand after the inspector's own commits. The store holds the details; the load
// status (including failures) is local to the inspector.

import { useCallback, useEffect, useState } from 'react'

import { ApiError, engine } from '@/bridge/client'
import type { ErrorCode, NodeDetails } from '@/bridge/types'
import { designer, useDesigner } from '@/state/store'

export interface LoadFailure {
  code: ErrorCode
  message: string
  /** The last details seen for this locator, so the error state can offer "select parent". */
  last: NodeDetails | null
}

export type DetailsStatus =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; details: NodeDetails; refreshing: boolean }
  | { status: 'error'; locator: string; failure: LoadFailure }

interface Outcome {
  key: string
  failure: LoadFailure | null
}

export function failureOf(error: unknown): Omit<LoadFailure, 'last'> {
  if (error instanceof ApiError) return { code: error.code, message: error.message }
  return { code: 'internal', message: error instanceof Error ? error.message : String(error) }
}

export function useSelectedDetails(): { status: DetailsStatus; reload(): void } {
  const selected = useDesigner((s) => s.selected)
  const revision = useDesigner((s) => s.revision)
  const details = useDesigner((s) => s.details)
  const [reloads, setReloads] = useState(0)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const key = `${selected ?? ''}\u0000${revision}\u0000${reloads}`

  useEffect(() => {
    if (selected === null) return
    let live = true
    engine.inspect(selected).then(
      (fresh) => {
        if (!live) return
        designer.getState().setDetails(fresh)
        setOutcome({ key, failure: null })
      },
      (error: unknown) => {
        if (!live) return
        const state = designer.getState()
        const previous = state.details?.locator === selected ? state.details : null
        // Stale details must not outlive the node: nobody should edit through them.
        state.setDetails(null)
        setOutcome((prior) => ({
          key,
          failure: {
            ...failureOf(error),
            last: previous ?? (prior?.failure?.last?.locator === selected ? prior.failure.last : null),
          },
        }))
      },
    )
    return () => {
      live = false
    }
  }, [selected, key])

  const reload = useCallback(() => setReloads((n) => n + 1), [])

  let status: DetailsStatus
  if (selected === null) status = { status: 'idle' }
  else if (outcome?.key === key && outcome.failure !== null) status = { status: 'error', locator: selected, failure: outcome.failure }
  else if (details !== null && details.locator === selected) status = { status: 'ready', details, refreshing: outcome?.key !== key }
  else status = { status: 'loading' }

  return { status, reload }
}

export interface Crumb {
  locator: string
  name: string
}

/**
 * Ancestors of a node, root first, fetched lazily (one inspect per level) once the node itself
 * is shown. Refetched when the node or the canvas revision changes, since a structural edit
 * moves positions.
 */
export function useAncestors(details: NodeDetails | null): { crumbs: Crumb[] | null; error: string | null } {
  const revision = useDesigner((s) => s.revision)
  const locator = details?.locator ?? null
  const parent = details?.parent ?? null
  const key = `${locator ?? ''}\u0000${parent ?? ''}\u0000${revision}`
  const [result, setResult] = useState<{ key: string; locator: string; crumbs: Crumb[]; error: string | null } | null>(null)

  useEffect(() => {
    if (locator === null || parent === null) return
    let live = true
    void (async () => {
      const crumbs: Crumb[] = []
      let next: string | null = parent
      try {
        // A locator path is at most as deep as the JSX; the bound only guards a broken engine.
        for (let depth = 0; next !== null && depth < 256; depth += 1) {
          const ancestor: NodeDetails = await engine.inspect(next)
          if (!live) return
          crumbs.unshift({ locator: ancestor.locator, name: ancestor.name })
          next = ancestor.parent
        }
        if (live) setResult({ key, locator, crumbs, error: null })
      } catch (error) {
        if (live) setResult({ key, locator, crumbs, error: failureOf(error).message })
      }
    })()
    return () => {
      live = false
    }
  }, [key, locator, parent])

  if (locator === null) return { crumbs: null, error: null }
  if (parent === null) return { crumbs: [], error: null }
  // While refetching after HMR, keep showing this node's previous chain instead of flickering.
  if (result === null || result.locator !== locator) return { crumbs: null, error: null }
  return { crumbs: result.crumbs, error: result.error }
}
