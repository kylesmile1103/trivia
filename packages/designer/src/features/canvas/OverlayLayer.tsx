// What the canvas draws over the app: hover and selection outlines with a name/size label, the
// drop indicator, and the chip that follows the cursor during a drag. Pure presentation of a CanvasView; all
// positions are overlay pixels. The accent is fixed (not the designer theme) because it sits
// on top of the user's app, whose own colors are unknown.

import type { CSSProperties, ReactNode } from 'react'
import { ChevronRightIcon, MoveIcon, PlusIcon } from 'lucide-react'

import { cn } from '@/shared/lib/utils'

import type { CanvasView, CursorChip, DropView, Highlight } from './controller'
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
      {view.drop && <DropIndicator drop={view.drop} />}
      {view.cursor && <Cursor chip={view.cursor} />}
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

function DropIndicator({ drop }: { drop: DropView }) {
  if (drop.kind === 'inside') {
    return (
      <Box
        rect={drop.rect}
        data-canvas-drop="inside"
        className="border-2 border-dashed border-(--canvas-accent) bg-(--canvas-accent)/10"
      />
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
    </>
  )
}

/** Below-right of the pointer, clear of the drag image: "✥ Button › After div". */
function Cursor({ chip }: { chip: CursorChip }) {
  const Icon = chip.kind === 'move' ? MoveIcon : PlusIcon
  return (
    <div
      data-testid="canvas-cursor-chip"
      className="absolute top-0 left-0 flex h-6 items-center gap-1 rounded-md border bg-popover px-1.5 text-xs whitespace-nowrap text-popover-foreground shadow-md"
      style={{ transform: `translate(${chip.at.x + 14}px, ${chip.at.y + 14}px)` }}
    >
      <Icon className="size-3 text-muted-foreground" />
      <span className="font-medium">{chip.subject}</span>
      {chip.target && (
        <>
          <ChevronRightIcon className="size-3 text-muted-foreground" />
          <span
            data-testid="canvas-drop-label"
            data-canvas-drop={chip.refused ? 'refused' : undefined}
            className={chip.refused ? 'text-destructive' : 'text-(--canvas-accent)'}
          >
            {chip.target}
          </span>
        </>
      )}
    </div>
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
