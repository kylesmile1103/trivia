// The canvas: the user's real app in a same-origin <iframe src="/"> (the designer proxies the
// app's dev server), with a transparent interaction overlay on top. Nothing is injected into
// the app's React DOM; see controller.ts for how gestures become ops.
//
// Zoom behaves like browser zoom: the iframe lays out at canvasSize / zoom and is scaled by
// `zoom`, so it always fills the canvas.

import { useEffect, useRef, useState } from 'react'
import { LoaderCircleIcon, TriangleAlertIcon, UnplugIcon } from 'lucide-react'

import { setCanvasApi } from '@/shared/canvas'
import { cn } from '@/shared/lib/utils'
import { useDesigner } from '@/shared/state/store'

import { CanvasContextMenu } from './ContextMenu'
import { OverlayLayer } from './OverlayLayer'
import { type CanvasStatus, type CanvasView, CanvasController, EMPTY_VIEW } from './controller'

export function Canvas() {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const controllerRef = useRef<CanvasController | null>(null)
  const [view, setView] = useState<CanvasView>(EMPTY_VIEW)
  const mode = useDesigner((s) => s.mode)
  const zoom = useDesigner((s) => s.zoom)
  const dragging = useDesigner((s) => s.drag !== null)

  useEffect(() => {
    const iframe = frameRef.current
    const overlay = overlayRef.current
    if (!iframe || !overlay) return
    const controller = new CanvasController(iframe, overlay, setView)
    const unmount = controller.mount()
    controllerRef.current = controller
    setCanvasApi(controller.api)
    return () => {
      setCanvasApi(null)
      controllerRef.current = null
      unmount()
    }
  }, [])

  // Interact mode hands the pointer to the app, except while something is being dragged in.
  const captures = mode === 'design' || dragging

  return (
    <div className="relative min-w-0 flex-1 overflow-hidden bg-muted/40">
      <iframe
        ref={frameRef}
        src="/"
        title="App canvas"
        className="absolute top-0 left-0 origin-top-left border-0"
        style={{ width: `${100 / zoom}%`, height: `${100 / zoom}%`, transform: zoom === 1 ? undefined : `scale(${zoom})` }}
      />
      <div
        ref={overlayRef}
        data-testid="canvas-overlay"
        tabIndex={0}
        role="application"
        aria-roledescription="design canvas"
        aria-label="Canvas. Click to select, drag to move, right-click for actions, Delete to remove, Arrow Up for the parent, Escape to deselect."
        // An edit is rendering: presses, Delete and drops wait for it (controller.ts `stale`).
        aria-busy={view.updating || undefined}
        className={cn(
          'absolute inset-0 overflow-hidden outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset',
          view.moving ? 'cursor-grabbing' : view.updating && 'cursor-progress',
        )}
        style={{ pointerEvents: captures ? 'auto' : 'none' }}
      >
        <OverlayLayer view={view} />
      </div>
      <CanvasContextMenu
        menu={view.menu}
        onAction={(action) => void controllerRef.current?.runMenuAction(action)}
        onClose={() => {
          controllerRef.current?.closeMenu()
          overlayRef.current?.focus({ preventScroll: true }) // its keyboard shortcuts again
        }}
      />
      <StatusNotice status={view.status} />
    </div>
  )
}

const notices: Partial<Record<CanvasStatus, { icon: 'spinner' | 'warning' | 'blocked'; title: string; detail?: string }>> = {
  engine: { icon: 'spinner', title: 'Waiting for the Trivia engine…' },
  'no-locators': {
    icon: 'warning',
    title: 'Nothing on this page can be selected',
    detail: 'No data-ast-node locators were found. Is vite-plugin-ast-locator in the app’s Vite config?',
  },
  'build-error': {
    icon: 'warning',
    title: 'The app has a build error',
    detail: 'Fix it in your editor, or switch to Interact to read Vite’s overlay.',
  },
  blocked: {
    icon: 'blocked',
    title: 'The app’s document is not readable',
    detail: 'The canvas needs the app on the designer’s origin. Open the designer through its own dev server (TRIVIA_TARGET).',
  },
}

function StatusNotice({ status }: { status: CanvasStatus }) {
  if (status === 'loading') {
    return (
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <LoaderCircleIcon className="size-3.5 animate-spin" />
          Loading app…
        </div>
      </div>
    )
  }
  const notice = notices[status]
  if (!notice) return null
  const Icon = notice.icon === 'spinner' ? LoaderCircleIcon : notice.icon === 'blocked' ? UnplugIcon : TriangleAlertIcon
  return (
    <div
      role="status"
      className="pointer-events-none absolute bottom-3 left-3 flex max-w-sm gap-2 rounded-md border bg-popover/95 px-2.5 py-2 text-xs text-popover-foreground shadow-sm backdrop-blur"
    >
      <Icon
        className={cn(
          'mt-px size-3.5 shrink-0',
          notice.icon === 'spinner' ? 'animate-spin text-muted-foreground' : 'text-amber-600 dark:text-amber-400',
        )}
      />
      <div className="grid gap-0.5">
        <p className="font-medium">{notice.title}</p>
        {notice.detail && <p className="text-muted-foreground">{notice.detail}</p>}
      </div>
    </div>
  )
}
