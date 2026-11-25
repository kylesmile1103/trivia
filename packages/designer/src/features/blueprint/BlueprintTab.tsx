import { useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'

import { canvas } from '@/shared/canvas'
import { APP_DOC } from '@/shared/engine/blueprint-types'
import { engine } from '@/shared/engine/client'
import type { BlueprintDiagnostic, BlueprintPageSummary, ManifestResource } from '@/shared/engine/types'
import { useDesigner } from '@/shared/state/store'
import { Button } from '@/shared/ui/button'

import { blueprintApi, problemOf } from './api'
import { Diagnostics, focusDiagnosticField } from './Diagnostics'
import { EjectDialog } from './EjectDialog'
import { PageForm, type SaveBlueprintOp } from './PageForm'
import { PagesList } from './PagesList'
import { createBlueprintStore } from './store'

export function BlueprintTab() {
  const [store] = useState(createBlueprintStore)
  const { summary, refresh, loadError, problem, pending, path, document, open, patch } = useStore(store)
  const root = useRef<HTMLElement>(null)
  const editor = useRef<HTMLElement>(null)
  const [focusRequest, setFocusRequest] = useState<BlueprintDiagnostic | null>(null)
  const [eject, setEject] = useState<BlueprintPageSummary | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [adding, setAdding] = useState(false)
  const [resources, setResources] = useState<ManifestResource[]>([])
  const [manifestError, setManifestError] = useState<string | null>(null)
  const page = document && 'kind' in document.doc ? { ...document, doc: document.doc } : undefined
  const save: SaveBlueprintOp = async (op, label) => {
    const result = await patch([op], label)
    if (result && op.op === 'createPage') {
      setAdding(false)
      await open(op.doc)
    }
    return result !== null
  }
  const host = useDesigner((state) => state.health?.host)
  const initialize = () => void patch([{
    op: 'setApp', doc: APP_DOC, baseRev: null, name: 'App',
    targets: { web: host === 'next' ? 'next-refine' : 'vite-refine' },
  }], 'Blueprint: create app')

  useEffect(() => {
    let active = true
    void refresh()
    void engine.manifest().then(
      ({ manifest }) => { if (active) setResources(manifest?.resources ?? []) },
      (error: unknown) => { if (active) setManifestError(problemOf(error).message) },
    )
    return () => { active = false }
  }, [refresh])

  async function preview(page: BlueprintPageSummary) {
    setPreviewing(true)
    store.setState({ problem: null })
    try {
      const result = await blueprintApi.preview(page.name)
      canvas.navigate(result.route)
    } catch (error) {
      store.setState({ problem: problemOf(error) })
    } finally {
      setPreviewing(false)
    }
  }

  const findings = [...(problem?.diagnostics ?? []), ...(summary?.diagnostics.filter((item) => path === null || item.doc === path) ?? [])]

  function activateDiagnostic(diagnostic: BlueprintDiagnostic) {
    if (diagnostic.doc !== path && summary?.pages.some((page) => page.path === diagnostic.doc)) {
      setAdding(false)
      void open(diagnostic.doc)
    }
    setFocusRequest(diagnostic)
  }

  useEffect(() => {
    if (!focusRequest || pending || (focusRequest.doc === path && !document && !loadError)) return
    const region = editor.current ?? root.current
    if (region && !focusDiagnosticField(region, focusRequest.pointer)) region.focus()
    setFocusRequest(null)
  }, [focusRequest, pending, path, document, loadError])

  return (
    <section ref={root} tabIndex={-1} aria-label="Blueprint pages" className="min-h-0 flex-1 overflow-y-auto p-3">
      {loadError && (
        <div className="space-y-2">
          <p role="alert" className="text-destructive">{loadError}</p>
          <Button size="sm" variant="outline" onClick={() => void refresh()}>Reload blueprint</Button>
        </div>
      )}
      {problem && <p role="alert" className="mb-2 text-destructive">{problem.message}</p>}
      {summary && (
        <PagesList
          summary={summary} openPath={path} busy={pending !== null || previewing}
          onEject={setEject}
          onPreview={(item) => { void preview(item) }}
          onOpen={(doc) => { setAdding(false); void open(doc) }}
          onAdd={() => { void open(null); setAdding(true) }} onInitialize={initialize}
        />
      )}
      {(adding || path !== null) && (
        <section ref={editor} tabIndex={-1} aria-label="Page editor" className="mt-3 space-y-3 border-t pt-3">
          <div className="flex items-start justify-between gap-2">
            <h3 className="min-w-0 text-xs font-semibold [overflow-wrap:anywhere]">{adding ? 'New page' : page?.doc.name ?? 'Page'}</h3>
            <Button size="xs" variant="ghost" disabled={pending !== null} onClick={() => { setAdding(false); void open(null) }}>Close editor</Button>
          </div>
          {manifestError && <p role="alert" className="text-xs text-destructive">{manifestError}</p>}
          {adding || page
            ? <PageForm key={page?.rev ?? 'new'} document={page} resources={resources} busy={pending !== null || loadError !== null} save={save} />
            : !loadError && <p role="status">Loading page…</p>}
        </section>
      )}
      {eject && <EjectDialog page={eject} onClose={() => setEject(null)} onRefresh={() => { void refresh() }} />}
      <Diagnostics diagnostics={findings} onActivate={activateDiagnostic} showPath={path === null && !adding} />
      {!summary && !loadError && <p role="status" className="text-muted-foreground">Loading blueprint…</p>}
    </section>
  )
}
