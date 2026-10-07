// What the canvas draws over the app: hover and selection outlines with a name/size label, the
// drop indicator, and the cursor chip during a move. Pure presentation of a CanvasView; all
// positions are overlay pixels. The accent is fixed (not the designer theme) because it sits
// on top of the user's app, whose own colors are unknown.

import type { CSSProperties, ReactNode } from 'react'
import { MoveIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

import type { CanvasView, DropView, Highlight } from './controller'
import type { Rect } from './dom'

const ACCENT = 'oklch(0.6 0.19 256)'
const LABEL_HEIGHT = 18
const LABEL_GAP = 2

type BoxVariant = 'hover' | 'selection' | 'moving'

const boxClass: Record<BoxVariant, string> = {
  hover: 'border border-(--canvas-accent)',
  selection: 'border-2 border-(--canvas-accent) shadow-[0_0_0_1px_rgb(255_255_255/0.5)]',
  moving: 'border-2 border-dashed border-(--canvas-accent) bg-(--canvas-accent)/8',
}

export function OverlayLayer({ view }: { view: CanvasView }) {
  return (
    <div className="pointer-events-none absolute inset-0" style={{ '--canvas-accent': ACCENT } as CSSProperties}>
      {view.drop?.kind === 'line' && view.drop.container && (
        <Box rect={view.drop.container} className="border border-dashed border-(--canvas-accent)/50" />
      )}
      {view.hover && <Outline highlight={view.hover} variant="hover" bounds={view.bounds} />}
      {view.selection && (
        <Outline highlight={view.selection} variant={view.moving ? 'moving' : 'selection'} bounds={view.bounds} />
      )}
      {view.drop && <DropIndicator drop={view.drop} bounds={view.bounds} />}
      {view.ghost && (
        <div
          className="absolute top-0 left-0 flex items-center gap-1 rounded-md border bg-popover px-1.5 py-0.5 text-xs font-medium text-popover-foreground shadow-md"
          style={{ transform: `translate(${view.ghost.at.x + 14}px, ${view.ghost.at.y + 14}px)` }}
        >
          <MoveIcon className="size-3 text-muted-foreground" />
          {view.ghost.name}
        </div>
      )}
    </div>
  )
}

function Outline({ highlight, variant, bounds }: { highlight: Highlight; variant: BoxVariant; bounds: CanvasView['bounds'] }) {
  const [first] = highlight.boxes
  return (
    <>
      {highlight.boxes.map((rect, i) => (
        <Box
          key={i}
          rect={rect}
          className={boxClass[variant]}
          data-canvas-box={variant === 'hover' ? 'hover' : 'selection'}
          data-locator={highlight.locator}
        />
      ))}
      {first && variant !== 'moving' && (
        <Label anchor={first} bounds={bounds} faded={variant === 'hover'} testId={`canvas-${variant}-label`}>
          <span className="font-medium">{highlight.name}</span>
          <span className="opacity-75">
            {highlight.size.width} × {highlight.size.height}
          </span>
        </Label>
      )}
    </>
  )
}

function DropIndicator({ drop, bounds }: { drop: DropView; bounds: CanvasView['bounds'] }) {
  if (drop.kind === 'invalid') {
    return (
      <div
        data-canvas-drop="invalid"
        className="absolute top-0 left-0 rounded-sm bg-destructive px-1.5 text-[11px] leading-[18px] font-medium whitespace-nowrap text-white"
        style={{ transform: `translate(${drop.at.x + 14}px, ${drop.at.y + 14}px)` }}
      >
        {drop.label}
      </div>
    )
  }
  if (drop.kind === 'inside') {
    return (
      <>
        <Box
          rect={drop.rect}
          data-canvas-drop="inside"
          className="border-2 border-dashed border-(--canvas-accent) bg-(--canvas-accent)/10"
        />
        <Label anchor={drop.rect} bounds={bounds} testId="canvas-drop-label">
          {drop.label}
        </Label>
      </>
    )
  }
  const horizontal = drop.from.y === drop.to.y
  const line: Rect = horizontal
    ? { x: drop.from.x, y: drop.from.y - 1, width: drop.to.x - drop.from.x, height: 2 }
    : { x: drop.from.x - 1, y: drop.from.y, width: 2, height: drop.to.y - drop.from.y }
  return (
    <>
      <Box rect={line} data-canvas-drop={horizontal ? 'line-x' : 'line-y'} className="rounded-full bg-(--canvas-accent)" />
      {[drop.from, drop.to].map((p, i) => (
        <div
          key={i}
          className="absolute top-0 left-0 size-[7px] rounded-full border-[1.5px] border-(--canvas-accent) bg-white"
          style={{ transform: `translate(${p.x - 3.5}px, ${p.y - 3.5}px)` }}
        />
      ))}
      <Label anchor={{ ...line, y: line.y - 2, height: line.height + 4 }} bounds={bounds} testId="canvas-drop-label">
        {drop.label}
      </Label>
    </>
  )
}

function Box({ rect, className, ...data }: { rect: Rect; className: string } & Record<`data-${string}`, string>) {
  return (
    <div
      {...data}
      className={cn('absolute top-0 left-0 box-border rounded-[1px]', className)}
      style={{ transform: `translate(${rect.x}px, ${rect.y}px)`, width: rect.width, height: rect.height }}
    />
  )
}

/** A chip above the anchor's top-left corner; below it (or inside) when there is no room. */
function Label({
  anchor,
  bounds,
  faded = false,
  testId,
  children,
}: {
  anchor: Rect
  bounds: CanvasView['bounds']
  faded?: boolean
  testId: string
  children: ReactNode
}) {
  const above = anchor.y - LABEL_HEIGHT - LABEL_GAP
  const below = anchor.y + anchor.height + LABEL_GAP
  const y = above >= 0 ? above : below + LABEL_HEIGHT <= bounds.height ? below : Math.max(0, anchor.y) + LABEL_GAP
  const x = Math.min(Math.max(0, anchor.x), Math.max(0, bounds.width - 160))
  return (
    <div
      data-testid={testId}
      className={cn(
        'absolute top-0 left-0 flex h-[18px] items-center gap-1.5 rounded-sm px-1.5 text-[11px] leading-none whitespace-nowrap text-white tabular-nums',
        faded ? 'bg-(--canvas-accent)/85' : 'bg-(--canvas-accent)',
      )}
      style={{ transform: `translate(${x}px, ${y}px)` }}
    >
      {children}
    </div>
  )
}
