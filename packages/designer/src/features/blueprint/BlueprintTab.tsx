import { useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'

import { canvas } from '@/shared/canvas'
import { APP_DOC, MODEL_DOC } from '@/shared/engine/blueprint-types'
import { engine } from '@/shared/engine/client'
import { syncHistory } from '@/shared/engine/session'
import type { BlueprintComponents, BlueprintDiagnostic, BlueprintOp, BlueprintPageSummary, ManifestResource } from '@/shared/engine/types'
import { fillRoute, matchRoute } from '@/shared/lib/route-url'
import { designer, useDesigner } from '@/shared/state/store'
import { Button } from '@/shared/ui/button'

import { blueprintApi, problemOf } from './api'
import { BackendDialog } from './BackendDialog'
import { Diagnostics, focusDiagnosticField } from './Diagnostics'
import { EjectDialog } from './EjectDialog'
import { ModelEditor } from './ModelEditor'
import { NodeProps } from './NodeProps'
import { NodeTree } from './NodeTree'
import { PageForm, type SaveBlueprintOp } from './PageForm'
import { PagesList } from './PagesList'
import { RouteDialog } from './RouteDialog'
import { createBlueprintStore } from './store'

export function BlueprintTab() {
  const [store] = useState(createBlueprintStore)
  const { summary, refresh, loadError, problem, pending, path, document, open, patch } = useStore(store)
  const root = useRef<HTMLElement>(null)
  const editor = useRef<HTMLElement>(null)
  const editorOpener = useRef<HTMLElement | null>(null)
  const focusName = useRef(false)
  const focusAdd = useRef(false)
  const focusModelButton = useRef(false)
  const [focusRequest, setFocusRequest] = useState<BlueprintDiagnostic | null>(null)
  const [routeDialog, setRouteDialog] = useState<{ route: string; params: string[] } | null>(null)
  const [openingRoute, setOpeningRoute] = useState(false)
  const [eject, setEject] = useState<BlueprintPageSummary | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [backend, setBackend] = useState<{ modelRev: string; appRev: string | null } | null>(null)
  const [modelOpen, setModelOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [resources, setResources] = useState<ManifestResource[]>([])
  const [catalog, setCatalog] = useState<BlueprintComponents | null>(null)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [nodeSelection, setNodeSelection] = useState<{ page: string; node: string } | null>(null)
  const [manifestError, setManifestError] = useState<string | null>(null)
  const model = document && 'namespace' in document.doc ? { ...document, doc: document.doc } : undefined
  const modelRev = summary?.model?.rev
  const page = document && 'kind' in document.doc ? { ...document, doc: document.doc } : undefined
  const custom = page?.doc.kind === 'custom' ? { ...page, doc: page.doc } : null
  const customId = custom?.doc.id
  const selectedNode = custom && nodeSelection && nodeSelection.page === custom.doc.id && custom.doc.nodes[nodeSelection.node]
    ? nodeSelection.node : custom?.doc.root
  const commit = async (ops: BlueprintOp[], label: string) => {
    const result = await patch(ops, label)
    if (result?.entry) void syncHistory()
    return result
  }
  const save: SaveBlueprintOp = async (op, label) => {
    const result = await commit([op], label)
    if (result && op.op === 'createPage') {
      setAdding(false)
      await open(op.doc)
    }
    return result !== null
  }
  const host = useDesigner((state) => state.health?.host)
  function initialize() {
    focusAdd.current = true
    void commit([{
      op: 'setApp', doc: APP_DOC, baseRev: null, name: 'App',
      targets: { web: host === 'next' ? 'next-refine' : 'vite-refine' },
    }], 'Blueprint: create app')
  }

  useEffect(() => {
    if (modelOpen && modelRev && path !== MODEL_DOC) void open(MODEL_DOC)
  }, [modelOpen, modelRev, open, path])

  function openModel() {
    focusName.current = true
    setAdding(false)
    setModelOpen(true)
    void open(modelRev ? MODEL_DOC : null)
  }

  function openEditor(pagePath: string | null) {
    const active = globalThis.document.activeElement
    editorOpener.current = active instanceof HTMLElement ? active : null
    focusName.current = true
    setAdding(pagePath === null)
    void open(pagePath)
  }

  function closeEditor() {
    focusName.current = false
    setAdding(false)
    void open(null)
    editorOpener.current?.focus()
  }

  useEffect(() => {
    if (pending || loadError) return
    if (focusAdd.current && summary?.exists) {
      focusAdd.current = false
      root.current?.querySelector<HTMLElement>('[data-blueprint-add]')?.focus()
    }
    if (focusModelButton.current && !modelOpen) {
      focusModelButton.current = false
      root.current?.querySelector<HTMLElement>('[data-blueprint-model]')?.focus()
    }
    if (focusName.current && (modelOpen || adding || document)) {
      const field = modelOpen
        ? root.current?.querySelector<HTMLElement>('[data-pointer="/namespace"]')
        : editor.current?.querySelector<HTMLElement>('[data-pointer="/name"]')
      if (field) {
        focusName.current = false
        field.focus()
      }
    }
  }, [adding, document, loadError, modelOpen, pending, summary?.exists])

  useEffect(() => {
    let manifestRequest = 0
    function reload() {
      const request = ++manifestRequest
      void refresh()
      void engine.manifest().then(
        ({ manifest }) => {
          if (manifestRequest !== request) return
          setResources(manifest?.resources ?? [])
          setManifestError(null)
        },
        (error: unknown) => { if (manifestRequest === request) setManifestError(problemOf(error).message) },
      )
    }
    reload()
    window.addEventListener('focus', reload)
    const unsubscribe = designer.subscribe((state, previous) => {
      if (state.history !== previous.history) void refresh()
    })
    return () => {
      manifestRequest++
      window.removeEventListener('focus', reload)
      unsubscribe()
    }
  }, [refresh])

  useEffect(() => {
    if (customId === undefined) return
    let request = 0
    function reload() {
      const id = ++request
      void blueprintApi.components().then(
        (components) => { if (id === request) { setCatalog(components); setCatalogError(null) } },
        (error: unknown) => { if (id === request) setCatalogError(problemOf(error).message) },
      )
    }
    reload()
    window.addEventListener('focus', reload)
    return () => { request++; window.removeEventListener('focus', reload) }
  }, [customId])

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

  function navigate(route: string, params = route.split('/').flatMap((part) => part.startsWith(':') ? [part.slice(1)] : [])) {
    const current = designer.getState().canvasPath?.split(/[?#]/)[0]
    const url = fillRoute(route, current ? matchRoute(route, current) ?? {} : {})
    if (url !== null) canvas.navigate(url)
    else setRouteDialog({ route, params })
  }

  async function openRoute(item: BlueprintPageSummary) {
    setOpeningRoute(true)
    store.setState({ problem: null })
    try {
      const routes = await engine.routes()
      const candidates = item.file ? routes.filter(({ file }) => file === item.file) : []
      const route = candidates.find(({ path }) => path === item.route) ?? candidates[0]
      navigate(route?.path ?? item.route, route?.params)
    } catch (error) {
      store.setState({ problem: problemOf(error) })
    } finally {
      setOpeningRoute(false)
    }
  }

  const pageStatus = summary?.pages.find((item) => item.path === path)?.status
  const findings = [...(problem?.diagnostics ?? []), ...(summary?.diagnostics.filter((item) => path === null || item.doc === path) ?? [])]

  function activateDiagnostic(diagnostic: BlueprintDiagnostic) {
    if (diagnostic.doc !== path && summary?.pages.some((page) => page.path === diagnostic.doc && page.status === 'draft')) {
      setAdding(false)
      void open(diagnostic.doc)
    }
    setFocusRequest(diagnostic)
  }

  useEffect(() => {
    if (!focusRequest || pending || (focusRequest.doc === path && !document && !loadError)) return
    if (document?.path === focusRequest.doc && 'nodes' in document.doc && !catalog && !catalogError) return
    const [, map, key] = focusRequest.pointer.split('/')
    const node = map === 'actions' ? key?.split('.')[0] : key
    if (document?.path === focusRequest.doc && document.doc && 'nodes' in document.doc && node && document.doc.nodes[node] && selectedNode !== node) {
      setNodeSelection({ page: document.doc.id, node })
      return
    }
    const region = editor.current ?? root.current
    if (region && !focusDiagnosticField(region, focusRequest.pointer)) region.focus()
    setFocusRequest(null)
  }, [focusRequest, pending, path, document, loadError, selectedNode, catalog, catalogError])

  return (
    <section ref={root} tabIndex={-1} aria-label="Blueprint pages" className="min-h-0 flex-1 overflow-y-auto p-3">
      {loadError && (
        <div className="space-y-2">
          <p role="alert" className="text-destructive">{loadError}</p>
          <Button size="sm" variant="outline" onClick={() => void refresh()}>Reload blueprint</Button>
        </div>
      )}
      {problem && <p role="alert" className="mb-2 text-destructive">{problem.message}</p>}
      {summary && !modelOpen && (
        <PagesList
          summary={summary} openPath={path} busy={pending !== null || previewing || openingRoute}
          onEject={setEject}
          onOpenRoute={(item) => { void openRoute(item) }}
          onPreview={(item) => { void preview(item) }}
          onOpen={openEditor}
          onModel={openModel}
          onAdd={() => openEditor(null)} onInitialize={initialize}
        />
      )}
      {!modelOpen && (adding || (path !== null && pageStatus === 'draft')) && (
        <section ref={editor} tabIndex={-1} aria-label="Page editor" className="mt-3 space-y-3 border-t pt-3">
          <div className="flex items-start justify-between gap-2">
            <h3 className="min-w-0 text-xs font-semibold [overflow-wrap:anywhere]">{adding ? 'New page' : page?.doc.name ?? 'Page'}</h3>
            <Button size="xs" variant="ghost" disabled={pending !== null} onClick={closeEditor}>Close editor</Button>
          </div>
          {manifestError && <p role="alert" className="text-xs text-destructive">{manifestError}</p>}
          {adding || page
            ? <PageForm key={page?.rev ?? 'new'} document={page} resources={resources} busy={pending !== null || loadError !== null} save={save} />
            : !loadError && <p role="status">Loading page…</p>}
          {custom && (catalogError ? <p role="alert" className="text-destructive">{catalogError}</p> : catalog && selectedNode ? (
            <>
              <NodeTree
                key={custom.doc.id} document={custom} catalog={catalog} selected={selectedNode} busy={pending !== null || loadError !== null}
                onSelect={(node) => setNodeSelection({ page: custom.doc.id, node })} save={save}
              />
              <NodeProps
                key={selectedNode} document={custom} catalog={catalog} nodeId={selectedNode} diagnostics={findings}
                busy={pending !== null || loadError !== null} commit={commit}
              />
            </>
          ) : <p role="status">Loading component manifests…</p>)}
        </section>
      )}
      {modelOpen && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-1">
            <Button type="button" size="xs" variant="ghost" disabled={pending !== null} onClick={() => {
              focusName.current = false
              focusModelButton.current = true
              setModelOpen(false)
              void open(null)
            }}>Back to pages</Button>
            {model && <Button
              type="button" size="xs" variant="outline" disabled={pending !== null || loadError !== null}
              onClick={() => setBackend({ modelRev: model.rev, appRev: summary?.app?.rev ?? null })}
            >Generate backend</Button>}
          </div>
          {modelRev && !model
            ? !loadError && <p role="status">Loading model…</p>
            : <ModelEditor
                document={model} appName={summary?.app?.name ?? 'App'} diagnostics={summary?.diagnostics ?? []}
                rejected={problem?.ops ? { ops: problem.ops, diagnostics: problem.diagnostics } : undefined}
                busy={pending !== null || loadError !== null} commit={commit}
              />}
        </div>
      )}
      {backend && <BackendDialog {...backend} onClose={() => setBackend(null)} />}
      {eject && <EjectDialog page={eject} onClose={() => setEject(null)} onRefresh={() => { void refresh() }} onNavigate={navigate} />}
      {routeDialog && <RouteDialog {...routeDialog} onClose={() => setRouteDialog(null)} />}
      {!modelOpen && <Diagnostics diagnostics={findings} onActivate={activateDiagnostic} showPath={path === null && !adding} />}
      {!summary && !loadError && <p role="status" className="text-muted-foreground">Loading blueprint…</p>}
    </section>
  )
}
