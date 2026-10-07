// The harness page: the user's app in an iframe, the StylePanel wired to the engine. See main.tsx.

import { MoonIcon, Redo2Icon, SunIcon, Undo2Icon } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'

import { ApiError, engine } from '@/bridge/client'
import type { NodeDetails } from '@/bridge/types'
import { setCanvasApi } from '@/canvas/api'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { dispatch, redo, undo } from '@/state/actions'
import { designer, useDesigner } from '@/state/store'

import { StylePanel } from '../StylePanel'
import { createHarnessCanvas, type HarnessCanvas } from './canvas'

export function Harness() {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const canvasRef = useRef<HarnessCanvas | null>(null)
  const locator = useDesigner((s) => s.selected)
  const details = useDesigner((s) => s.details)
  const history = useDesigner((s) => s.history)
  // Read by the iframe's click listener, which outlives the render that attached it.
  const uiDir = useRef('src/components/ui')
  const [error, setError] = useState<string | null>(null)
  const [dark, setDark] = useState(() => new URLSearchParams(location.search).get('theme') === 'dark')

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
  }, [dark])

  useEffect(() => {
    const canvas = createHarnessCanvas(frameRef.current!)
    canvasRef.current = canvas
    setCanvasApi(canvas)
    const initial = new URLSearchParams(location.search).get('locator')
    if (initial) designer.getState().select(initial)
    engine.health().then(
      (h) => {
        uiDir.current = h.uiDir
      },
      (e: unknown) => setError(message(e)),
    )
    engine.history().then((h) => designer.getState().setHistory(h), (e: unknown) => setError(message(e)))
    return () => setCanvasApi(null)
  }, [])

  // Details follow the selection and every DOM change (HMR), like the real inspector.
  const refresh = useCallback(async (target: string) => {
    try {
      const d = await engine.inspect(target)
      if (designer.getState().selected === target) {
        designer.getState().setDetails(d)
        setError(null)
      }
    } catch (e) {
      designer.getState().setDetails(null)
      setError(message(e))
    }
  }, [])
  useEffect(() => {
    const follow = (selected: string | null) => {
      canvasRef.current?.highlight(selected)
      if (selected) void refresh(selected)
    }
    follow(designer.getState().selected)
    return useDesigner.subscribe((s, prev) => {
      if (s.selected !== prev.selected || s.revision !== prev.revision) follow(s.selected)
    })
  }, [refresh])

  const onFrameLoad = () => {
    const frame = frameRef.current
    const doc = frame?.contentDocument
    if (!frame || !doc?.body) return
    canvasRef.current?.reattach()
    doc.addEventListener(
      'click',
      (event) => {
        event.preventDefault()
        event.stopPropagation()
        const picked = usageSite(event.target, uiDir.current)
        if (picked) designer.getState().select(picked)
      },
      true,
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    new MutationObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(() => designer.getState().bumpRevision(), 60)
    }).observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'data-ast-node'] })
  }

  const onPreview = useCallback(
    (style: Record<string, string> | null) => {
      if (locator) canvasRef.current?.previewStyle(locator, style)
    },
    [locator],
  )

  const onCommit = useCallback(
    async (next: string, label?: string) => {
      if (!locator || !details) return null
      // An emptied className removes the attribute instead of leaving className="".
      const value = next.trim() === '' ? null : next
      const result = await dispatch(
        { op: 'updateProp', target: locator, expectedName: details.name, prop: 'className', value },
        label ?? 'Edit classes',
      )
      if (result) await refresh(result.locator ?? locator)
      return result
    },
    [locator, details, refresh],
  )

  const className = literalClassName(details)

  return (
    <div className="flex h-svh bg-background text-foreground">
      <main className="flex min-w-0 flex-1 bg-muted/40 p-3">
        <iframe ref={frameRef} title="Canvas" src="/" onLoad={onFrameLoad} className="size-full rounded-lg border bg-background shadow-xs" />
      </main>
      <aside className="flex w-80 shrink-0 flex-col border-l">
        <header className="flex items-center gap-1 border-b px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium">{details ? `<${details.name}>` : 'Style'}</div>
            <div className="truncate font-mono text-[10px] text-muted-foreground" title={locator ?? undefined}>
              {locator ?? 'Click an element in the canvas'}
            </div>
          </div>
          <IconButton label={history.undoLabel ? `Undo ${history.undoLabel}` : 'Undo'} disabled={!history.canUndo} onClick={() => void undo()}>
            <Undo2Icon />
          </IconButton>
          <IconButton label={history.redoLabel ? `Redo ${history.redoLabel}` : 'Redo'} disabled={!history.canRedo} onClick={() => void redo()}>
            <Redo2Icon />
          </IconButton>
          <IconButton label={dark ? 'Light theme' : 'Dark theme'} onClick={() => setDark((d) => !d)}>
            {dark ? <SunIcon /> : <MoonIcon />}
          </IconButton>
        </header>
        {/* Radix lays the viewport content out as a max-content table; keep it to the column width. */}
        <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:block!">
          {error && <p className="m-3 rounded-md bg-destructive/10 p-2 text-xs text-destructive">{error}</p>}
          {locator && details && details.locator === locator && className.kind === 'literal' && (
            <StylePanel locator={locator} className={className.value} onPreview={onPreview} onCommit={onCommit} />
          )}
          {details && className.kind === 'expression' && (
            <p className="m-3 text-xs text-muted-foreground">
              className is an expression (<code className="font-mono">{className.source}</code>); the style panel edits literal
              classNames only.
            </p>
          )}
        </ScrollArea>
      </aside>
    </div>
  )
}

function IconButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick(): void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} disabled={disabled} onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}

type ClassNameSource = { kind: 'literal'; value: string } | { kind: 'expression'; source: string } | { kind: 'none' }

function literalClassName(details: NodeDetails | null): ClassNameSource {
  if (!details) return { kind: 'none' }
  const attr = details.attributes.find((a) => a.name === 'className')
  if (!attr) return { kind: 'literal', value: '' }
  if (attr.kind === 'string' && typeof attr.value === 'string') return { kind: 'literal', value: attr.value }
  return { kind: 'expression', source: attr.source }
}

/** The nearest `data-ast-node` whose file is outside the component library (docs/api.md). */
function usageSite(target: EventTarget | null, uiDir: string): string | null {
  // The event comes from the iframe's realm, where `instanceof Element` (ours) is false.
  const node = target as Node | null
  let el = node?.nodeType === Node.ELEMENT_NODE ? (node as Element) : (node?.parentElement ?? null)
  el = el?.closest('[data-ast-node]') ?? null
  while (el) {
    const locator = el.getAttribute('data-ast-node')
    if (locator && !locator.startsWith(`${uiDir}/`)) return locator
    el = el.parentElement?.closest('[data-ast-node]') ?? null
  }
  return null
}

function message(error: unknown): string {
  return error instanceof ApiError ? `${error.code}: ${error.message}` : String(error)
}
