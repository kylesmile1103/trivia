// Padding, margin and gap: one field per written level (all / x·y / sides), each scrubbable,
// plus a slider on the "all" field. Values are shown in px; the tooltip names the class.

import { LinkIcon, ScanIcon, SquareDashedIcon, UnlinkIcon } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { Toggle } from '@/components/ui/toggle'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { type BoxMode, common, formatNumber, type ParsedToken, type Side, type Utility } from '@/lib/tailwind'

import { useEditor } from './editor'
import { Row, ScrubField, ScrubSlider, Section, SEGMENT_ITEM, TokenHint } from './fields'
import { useGesture } from './gesture'

const SPACING_STEP = 4 // px: one Tailwind spacing unit
const SLIDER_MAX = 96 // px: p-24

interface FieldSpec {
  key: string
  /** Accessible name and history label ("Padding top"). */
  label: string
  handle: ReactNode
  /** The CSS property one value of this field sets. */
  property: string
  /** Utilities removed when the field is cleared (what setting it would override). */
  clear: readonly Utility[]
  sides: readonly Side[]
}

type BoxProperty = 'padding' | 'margin'

const ALL_SIDES: readonly Side[] = ['top', 'right', 'bottom', 'left']

function boxSpecs(property: BoxProperty): Record<BoxMode, FieldSpec[]> {
  const p = property === 'padding' ? 'p' : 'm'
  const Name = property === 'padding' ? 'Padding' : 'Margin'
  const u = (s: string) => `${p}${s}` as Utility
  return {
    all: [
      {
        key: 'all',
        label: Name,
        handle: property === 'padding' ? <ScanIcon /> : <SquareDashedIcon />,
        property,
        clear: [u(''), u('x'), u('y'), u('t'), u('r'), u('b'), u('l')],
        sides: ALL_SIDES,
      },
    ],
    axis: [
      { key: 'x', label: `${Name} X`, handle: 'X', property: `${property}-inline`, clear: [u('x'), u('l'), u('r')], sides: ['left', 'right'] },
      { key: 'y', label: `${Name} Y`, handle: 'Y', property: `${property}-block`, clear: [u('y'), u('t'), u('b')], sides: ['top', 'bottom'] },
    ],
    sides: [
      { key: 't', label: `${Name} top`, handle: 'T', property: `${property}-top`, clear: [u('t')], sides: ['top'] },
      { key: 'r', label: `${Name} right`, handle: 'R', property: `${property}-right`, clear: [u('r')], sides: ['right'] },
      { key: 'b', label: `${Name} bottom`, handle: 'B', property: `${property}-bottom`, clear: [u('b')], sides: ['bottom'] },
      { key: 'l', label: `${Name} left`, handle: 'L', property: `${property}-left`, clear: [u('l')], sides: ['left'] },
    ],
  }
}

const MODES: ReadonlyArray<{ value: BoxMode; label: string; title: string }> = [
  { value: 'all', label: 'All', title: 'One value for every side' },
  { value: 'axis', label: 'X·Y', title: 'Horizontal and vertical' },
  { value: 'sides', label: 'Sides', title: 'Each side' },
]

export function BoxSection({ property }: { property: BoxProperty }) {
  const { state } = useEditor()
  const box = state[property]
  const [mode, setMode] = useState<BoxMode>(property === 'padding' ? state.paddingMode : state.marginMode)
  const specs = boxSpecs(property)[mode]
  const title = property === 'padding' ? 'Padding' : 'Margin'
  return (
    <Section
      title={title}
      actions={
        <ToggleGroup
          type="single"
          size="sm"
          variant="outline"
          spacing={0}
          aria-label={`${title} sides`}
          value={mode}
          onValueChange={(v) => {
            if (v) setMode(v as BoxMode)
          }}
        >
          {MODES.map((m) => (
            <ToggleGroupItem key={m.value} value={m.value} title={m.title} className={`h-6 min-w-0 px-1.5 text-[10px] ${SEGMENT_ITEM}`}>
              {m.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      }
    >
      <div className={mode === 'sides' ? 'grid grid-cols-4 gap-1' : 'flex gap-1.5'}>
        {specs.map((spec) => (
          <SpacingField
            key={spec.key}
            spec={spec}
            tokens={spec.sides.map((s) => box[s])}
            computedKeys={spec.sides.map((s) => `${property}-${s}`)}
            min={property === 'padding' ? 0 : undefined}
            slider={mode === 'all'}
            unit={mode === 'sides' ? undefined : 'px'}
          />
        ))}
      </div>
    </Section>
  )
}

/** Gap row for the layout section: linked (`gap-*`) or split (`gap-x-*` / `gap-y-*`). */
export function GapRow() {
  const { state } = useEditor()
  const [split, setSplit] = useState(state.gapMode === 'axis')
  const { row, column } = state.gap
  const all: FieldSpec = { key: 'all', label: 'Gap', handle: 'G', property: 'gap', clear: ['gap', 'gap-x', 'gap-y'], sides: [] }
  const x: FieldSpec = { key: 'x', label: 'Column gap', handle: 'X', property: 'column-gap', clear: ['gap-x'], sides: [] }
  const y: FieldSpec = { key: 'y', label: 'Row gap', handle: 'Y', property: 'row-gap', clear: ['gap-y'], sides: [] }
  return (
    <Row label="Gap">
      {split ? (
        <>
          <SpacingField spec={x} tokens={[column]} computedKeys={['column-gap']} min={0} unit="px" />
          <SpacingField spec={y} tokens={[row]} computedKeys={['row-gap']} min={0} unit="px" />
        </>
      ) : (
        <SpacingField spec={all} tokens={[row, column]} computedKeys={['row-gap', 'column-gap']} min={0} slider />
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <Toggle
            size="sm"
            aria-label="Separate row and column gap"
            pressed={split}
            onPressedChange={setSplit}
            className={`size-7 min-w-7 shrink-0 px-0 ${SEGMENT_ITEM}`}
          >
            {split ? <UnlinkIcon /> : <LinkIcon />}
          </Toggle>
        </TooltipTrigger>
        <TooltipContent side="top">{split ? 'Row and column gap' : 'One gap'}</TooltipContent>
      </Tooltip>
    </Row>
  )
}

interface SpacingFieldProps {
  spec: FieldSpec
  /** The parsed tokens behind this field's sides (one per side/axis). */
  tokens: ReadonlyArray<ParsedToken | null>
  /** Computed properties shown as the placeholder when nothing is written. */
  computedKeys: readonly string[]
  min?: number
  slider?: boolean
  unit?: string
}

function SpacingField({ spec, tokens, computedKeys, min, slider = false, unit }: SpacingFieldProps) {
  const editor = useEditor()
  const gesture = useGesture((css) => ({ [spec.property]: css }), spec.label)
  const shared = common(tokens)
  const token = shared.kind === 'value' ? shared.token : null
  const value = gesture.draft ?? token?.px ?? null
  const text = shared.kind === 'mixed' ? 'Mixed' : token && token.px === null ? (token.css ?? token.token) : null
  const placeholder = computedPlaceholder(editor.computed, computedKeys)
  const hint = token ? `${token.token}${token.css ? ` = ${token.css}` : ''}` : shared.kind === 'mixed' ? 'mixed values' : 'not set'

  const field = (
    <ScrubField
      label={spec.label}
      handle={spec.handle}
      value={value}
      text={text}
      placeholder={placeholder}
      unit={unit}
      step={SPACING_STEP}
      min={min}
      hint={hint}
      className={slider ? 'w-20 shrink-0' : 'flex-1'}
      onChange={gesture.change}
      onCommit={gesture.commit}
      onCommitText={gesture.commitText}
      onClear={() => editor.clear(spec.clear, spec.label)}
      onCancel={gesture.cancel}
    />
  )
  if (!slider) return field
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      {field}
      <ScrubSlider
        label={spec.label}
        value={value ?? finiteOr(Number.parseFloat(placeholder ?? ''), 0)}
        min={0}
        max={SLIDER_MAX}
        step={SPACING_STEP}
        onChange={gesture.change}
        onCommit={gesture.commit}
        onCancel={gesture.cancel}
      />
      <TokenHint token={token?.token} className="max-w-16" />
    </div>
  )
}

function finiteOr(n: number, fallback: number): number {
  return Number.isFinite(n) ? n : fallback
}

/** The computed value as a placeholder: "24" when the sides agree, "–" when they differ. */
function computedPlaceholder(computed: Readonly<Record<string, string>>, keys: readonly string[]): string | undefined {
  // `normal` is how browsers report an unset gap; in flex and grid it is 0.
  const values = keys
    .map((k) => (computed[k] === 'normal' ? '0px' : computed[k]))
    .filter((v): v is string => v !== undefined && v !== '')
  if (values.length === 0) return undefined
  if (new Set(values).size > 1) return '–'
  const px = Number.parseFloat(values[0]!)
  return Number.isFinite(px) ? formatNumber(px) : undefined
}
