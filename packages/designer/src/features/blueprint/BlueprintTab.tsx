import { useEffect, useState } from 'react'
import { useStore } from 'zustand'

import { APP_DOC } from '@/shared/engine/blueprint-types'
import { useDesigner } from '@/shared/state/store'
import { Button } from '@/shared/ui/button'

import { PagesList } from './PagesList'
import { createBlueprintStore } from './store'

export function BlueprintTab() {
  const [store] = useState(createBlueprintStore)
  const { summary, refresh, loadError, problem, pending, path, open, patch } = useStore(store)
  const host = useDesigner((state) => state.health?.host)
  const initialize = () => void patch([{
    op: 'setApp', doc: APP_DOC, baseRev: null, name: 'App',
    targets: { web: host === 'next' ? 'next-refine' : 'vite-refine' },
  }], 'Blueprint: create app')

  useEffect(() => { void refresh() }, [refresh])

  return (
    <section aria-label="Blueprint pages" className="min-h-0 flex-1 overflow-y-auto p-3">
      {loadError && (
        <div className="space-y-2">
          <p role="alert" className="text-destructive">{loadError}</p>
          <Button size="sm" variant="outline" onClick={() => void refresh()}>Reload blueprint</Button>
        </div>
      )}
      {problem && <p role="alert" className="mb-2 text-destructive">{problem.message}</p>}
      {summary && (
        <PagesList summary={summary} openPath={path} busy={pending !== null} onOpen={(doc) => { void open(doc) }} onInitialize={initialize} />
      )}
      {!summary && !loadError && <p role="status" className="text-muted-foreground">Loading blueprint…</p>}
    </section>
  )
}
