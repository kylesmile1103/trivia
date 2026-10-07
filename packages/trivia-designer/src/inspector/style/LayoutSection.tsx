// Layout: display, and — for flex/grid containers — direction, wrap, alignment and gap.

import {
  AlignCenterHorizontalIcon,
  AlignCenterVerticalIcon,
  AlignEndHorizontalIcon,
  AlignEndVerticalIcon,
  AlignHorizontalDistributeCenterIcon,
  AlignHorizontalJustifyCenterIcon,
  AlignHorizontalJustifyEndIcon,
  AlignHorizontalJustifyStartIcon,
  AlignHorizontalSpaceAroundIcon,
  AlignHorizontalSpaceBetweenIcon,
  AlignStartHorizontalIcon,
  AlignStartVerticalIcon,
  AlignVerticalDistributeCenterIcon,
  AlignVerticalJustifyCenterIcon,
  AlignVerticalJustifyEndIcon,
  AlignVerticalJustifyStartIcon,
  AlignVerticalSpaceAroundIcon,
  AlignVerticalSpaceBetweenIcon,
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  BaselineIcon,
  StretchHorizontalIcon,
  StretchVerticalIcon,
  WrapTextIcon,
} from 'lucide-react'

import { Toggle } from '@/components/ui/toggle'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

import { useEditor } from './editor'
import { Row, Section, SEGMENT_ITEM, TokenHint } from './fields'
import { KeywordToggle, type KeywordOption } from './KeywordToggle'
import { GapRow } from './SpacingControls'

const DISPLAY: readonly KeywordOption[] = [
  { value: 'block', title: 'Block' },
  { value: 'flex', title: 'Flex' },
  { value: 'grid', title: 'Grid' },
  { value: 'inline-flex', title: 'Inline flex' },
  { value: 'none', title: 'Hidden' },
]

const DIRECTION: readonly KeywordOption[] = [
  { value: 'row', title: 'Row', content: <ArrowRightIcon /> },
  { value: 'column', title: 'Column', content: <ArrowDownIcon /> },
  { value: 'row-reverse', title: 'Row reverse', content: <ArrowLeftIcon /> },
  { value: 'column-reverse', title: 'Column reverse', content: <ArrowUpIcon /> },
]

// Icons follow the axis they act on: align-items is the cross axis, justify-content the main.
function alignOptions(vertical: boolean): KeywordOption[] {
  return [
    { value: 'flex-start', title: 'Start', content: vertical ? <AlignStartVerticalIcon /> : <AlignStartHorizontalIcon /> },
    { value: 'center', title: 'Center', content: vertical ? <AlignCenterVerticalIcon /> : <AlignCenterHorizontalIcon /> },
    { value: 'flex-end', title: 'End', content: vertical ? <AlignEndVerticalIcon /> : <AlignEndHorizontalIcon /> },
    { value: 'stretch', title: 'Stretch', content: vertical ? <StretchHorizontalIcon /> : <StretchVerticalIcon /> },
    { value: 'baseline', title: 'Baseline', content: <BaselineIcon /> },
  ]
}

function justifyOptions(vertical: boolean): KeywordOption[] {
  return [
    { value: 'flex-start', title: 'Start', content: vertical ? <AlignVerticalJustifyStartIcon /> : <AlignHorizontalJustifyStartIcon /> },
    { value: 'center', title: 'Center', content: vertical ? <AlignVerticalJustifyCenterIcon /> : <AlignHorizontalJustifyCenterIcon /> },
    { value: 'flex-end', title: 'End', content: vertical ? <AlignVerticalJustifyEndIcon /> : <AlignHorizontalJustifyEndIcon /> },
    { value: 'space-between', title: 'Space between', content: vertical ? <AlignVerticalSpaceBetweenIcon /> : <AlignHorizontalSpaceBetweenIcon /> },
    { value: 'space-around', title: 'Space around', content: vertical ? <AlignVerticalSpaceAroundIcon /> : <AlignHorizontalSpaceAroundIcon /> },
    { value: 'space-evenly', title: 'Space evenly', content: vertical ? <AlignVerticalDistributeCenterIcon /> : <AlignHorizontalDistributeCenterIcon /> },
  ]
}

export function LayoutSection() {
  const editor = useEditor()
  const { state, computed } = editor
  // The className may leave display to the component (CardFooter is `flex` internally), so the
  // container controls follow the computed value when the className says nothing.
  const display = state.display?.css ?? computed['display'] ?? ''
  const isFlex = display === 'flex' || display === 'inline-flex'
  const isGrid = display === 'grid' || display === 'inline-grid'
  const direction = state.flexDirection?.css ?? computed['flex-direction'] ?? 'row'
  const vertical = isFlex && direction.startsWith('column')
  const wraps = state.flexWrap?.css === 'wrap'

  return (
    <Section title="Layout" actions={<TokenHint token={state.display?.token} />}>
      <KeywordToggle
        property="display"
        utility="display"
        label="Display"
        options={DISPLAY}
        value={state.display?.css ?? null}
        className="w-full"
        itemClassName="grow px-1 font-mono text-[10px]"
      />
      {isFlex && (
        <Row label="Direction" hint={state.flexDirection?.token}>
          <KeywordToggle
            property="flex-direction"
            utility="flex-direction"
            label="Direction"
            options={DIRECTION}
            value={state.flexDirection?.css ?? null}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Toggle
                size="sm"
                variant="outline"
                aria-label="Wrap (flex-wrap)"
                className={`ml-auto size-7 min-w-7 px-0 ${SEGMENT_ITEM}`}
                pressed={wraps}
                onPressedChange={(on) => {
                  if (on) editor.commitStyle({ 'flex-wrap': 'wrap' }, 'Wrap')
                  else editor.clear(['flex-wrap'], 'Wrap')
                }}
              >
                <WrapTextIcon />
              </Toggle>
            </TooltipTrigger>
            <TooltipContent side="top">
              Wrap <code className="font-mono opacity-70">flex-wrap</code>
            </TooltipContent>
          </Tooltip>
        </Row>
      )}
      {(isFlex || isGrid) && (
        <>
          <Row label="Align" hint={state.alignItems?.token}>
            <KeywordToggle
              property="align-items"
              utility="align-items"
              label="Align items"
              options={alignOptions(vertical)}
              value={state.alignItems?.css ?? null}
            />
          </Row>
          <Row label="Justify" hint={state.justifyContent?.token}>
            <KeywordToggle
              property="justify-content"
              utility="justify-content"
              label="Justify content"
              options={justifyOptions(vertical)}
              value={state.justifyContent?.css ?? null}
            />
          </Row>
          <GapRow />
        </>
      )}
    </Section>
  )
}
