import { createStore } from 'zustand/vanilla'

import { APP_DOC, MODEL_DOC, pageDocPath } from '@/shared/engine/blueprint-types'
import type { BlueprintDocument, BlueprintOp, BlueprintPatchResult, BlueprintSummary } from '@/shared/engine/types'

import { blueprintApi, isConflict, problemOf, type BlueprintClient } from './api'

interface BlueprintState {
  summary: BlueprintSummary | null
  path: string | null
  document: BlueprintDocument | null
  pending: { ops: BlueprintOp[]; label: string } | null
  problem: ReturnType<typeof problemOf> | null
  loadError: string | null
  refresh(): Promise<void>
  open(path: string | null): Promise<void>
  patch(ops: BlueprintOp[], label: string): Promise<BlueprintPatchResult | null>
}

function revisionOf(summary: BlueprintSummary, path: string): string | undefined {
  if (path === APP_DOC) return summary.app?.rev
  if (path === MODEL_DOC) return summary.model?.rev
  return summary.pages.find((page) => page.path === path)?.rev
}

export function createBlueprintStore(client: BlueprintClient = blueprintApi) {
  let summaryRequest = 0
  let docRequest = 0
  let refreshDeferred = false

  return createStore<BlueprintState>()((set, get) => {
    async function readDocument(path: string): Promise<void> {
      const request = ++docRequest
      try {
        const document = await client.doc(path)
        if (request === docRequest) set({ document, loadError: null })
      } catch (error) {
        if (request === docRequest) set({ document: null, loadError: problemOf(error).message })
      }
    }

    async function reconcile(summary: BlueprintSummary): Promise<void> {
      set({ summary, loadError: null })
      const { path, document } = get()
      if (path === null) return
      const rev = revisionOf(summary, path)
      if (rev === undefined) {
        ++docRequest
        set({ path: null, document: null })
      } else if (document?.rev !== rev || document.path !== path) {
        await readDocument(path)
      }
    }

    async function refreshNow(): Promise<void> {
      refreshDeferred = false
      const request = ++summaryRequest
      try {
        const summary = await client.summary()
        if (request === summaryRequest) await reconcile(summary)
      } catch (error) {
        if (request === summaryRequest) set({ loadError: problemOf(error).message })
      }
    }

    return {
      summary: null,
      path: null,
      document: null,
      pending: null,
      problem: null,
      loadError: null,
      async refresh() {
        if (get().pending !== null) {
          refreshDeferred = true
          return
        }
        await refreshNow()
      },
      async open(path) {
        ++docRequest
        set({ path, document: null, problem: null, loadError: null })
        if (path !== null) await readDocument(path)
      },
      async patch(ops, label) {
        if (get().pending !== null || ops.length === 0) return null
        ++summaryRequest
        ++docRequest
        set({ pending: { ops, label }, problem: null })
        try {
          const result = await client.patch(ops, label)
          ++summaryRequest
          const path = get().path
          const rename = ops.find((op) => op.op === 'setPageMeta' && op.doc === path && op.name !== undefined)
          if (rename?.op === 'setPageMeta' && rename.name) set({ path: pageDocPath(rename.name) })
          await reconcile(result.summary)
          return result
        } catch (error) {
          if (isConflict(error)) {
            set({ problem: { message: 'Your change was not applied because the blueprint changed.', diagnostics: [] } })
            await refreshNow()
          } else {
            set({ problem: problemOf(error) })
          }
          return null
        } finally {
          set({ pending: null })
          if (refreshDeferred) await refreshNow()
        }
      },
    }
  })
}
