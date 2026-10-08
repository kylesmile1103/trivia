// Typography: font size (named token or exact px), weight and text alignment.

import { AlignCenterIcon, AlignJustifyIcon, AlignLeftIcon, AlignRightIcon, TypeIcon } from 'lucide-react'

import { DEFAULT_THEME, FONT_WEIGHTS, type FontWeightName, formatNumber } from '@/lib/tailwind'

import { useEditor } from './editor'
import { Row, ScrubField, Section } from './fields'
import { pxCss, useGesture } from './gesture'
import { KeywordToggle, type KeywordOption } from './KeywordToggle'
import { type TokenOption, TokenSelect } from './TokenSelect'

const SIZE_OPTIONS: readonly TokenOption[] = Object.keys(DEFAULT_THEME.fontSize).map((name) => ({ value: name, label: name }))

const WEIGHT_OPTIONS: readonly TokenOption[] = (Object.keys(FONT_WEIGHTS) as FontWeightName[]).map((name) => ({
  value: name,
  label: name,
  detail: String(FONT_WEIGHTS[name]),
}))

const ALIGN: readonly KeywordOption[] = [
  { value: 'left', title: 'Left', content: <AlignLeftIcon /> },
  { value: 'center', title: 'Center', content: <AlignCenterIcon /> },
  { value: 'right', title: 'Right', content: <AlignRightIcon /> },
  { value: 'justify', title: 'Justify', content: <AlignJustifyIcon /> },
]

export function TypographySection() {
  const editor = useEditor()
  const { state, computed } = editor
  const size = state.fontSize
  const weight = state.fontWeight
  const gesture = useGesture((css) => ({ 'font-size': css }), 'Font size', pxCss)
  const computedPx = Number.parseFloat(computed['font-size'] ?? '')
  const sizeHint = size ? `${size.token}${size.css ? ` = ${size.css}` : ''}` : null

  return (
    <Section title="Typography">
      <Row label="Size" hint={sizeHint}>
        <TokenSelect
          label="Font size token"
          value={size?.name ?? null}
          options={SIZE_OPTIONS}
          placeholder={size ? 'Custom' : 'Token'}
          className="w-24 shrink-0"
          onPick={(v) => editor.commitClasses([`text-${v}`], 'Font size')}
          onClear={() => editor.clear(['font-size'], 'Font size')}
        />
        <ScrubField
          label="Font size"
          handle={<TypeIcon />}
          value={gesture.draft ?? (size && size.name === null ? size.px : null)}
          text={size && size.name === null && size.px === null ? size.css : null}
          placeholder={Number.isFinite(computedPx) ? formatNumber(computedPx) : undefined}
          unit="px"
          step={1}
          min={1}
          hint={sizeHint ?? 'not set'}
          className="min-w-16 flex-1"
          onChange={gesture.change}
          onCommit={gesture.commit}
          onCommitText={gesture.commitText}
          onClear={() => editor.clear(['font-size'], 'Font size')}
          onCancel={gesture.cancel}
        />
      </Row>
      <Row label="Weight" hint={weight?.token}>
        <TokenSelect
          label="Font weight"
          value={weight?.name ?? null}
          options={WEIGHT_OPTIONS}
          placeholder={weight ? weight.css ?? 'Custom' : (computed['font-weight'] ?? 'Weight')}
          className="w-full"
          onPick={(v) => editor.commitStyle({ 'font-weight': String(FONT_WEIGHTS[v as FontWeightName]) }, 'Font weight')}
          onClear={() => editor.clear(['font-weight'], 'Font weight')}
        />
      </Row>
      <Row label="Align" hint={state.textAlign?.token}>
        <KeywordToggle property="text-align" utility="text-align" label="Text align" options={ALIGN} value={state.textAlign?.css ?? null} />
      </Row>
    </Section>
  )
}
