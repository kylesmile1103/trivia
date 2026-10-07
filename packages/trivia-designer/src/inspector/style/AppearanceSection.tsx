// Appearance: corner radius (named token or exact px) and opacity.

import { BlendIcon, RadiusIcon } from 'lucide-react'

import { formatNumber } from '@/lib/tailwind'

import { useEditor } from './editor'
import { Row, ScrubField, ScrubSlider, Section, TokenHint } from './fields'
import { pxCss, useGesture } from './gesture'
import { type TokenOption, TokenSelect } from './TokenSelect'

// `rounded` with no suffix is its own token in v4 (0.25rem); "DEFAULT" stands for it.
const DEFAULT_RADIUS = 'DEFAULT'
const RADIUS_OPTIONS: readonly TokenOption[] = [
  { value: 'none', label: 'none' },
  { value: 'xs', label: 'xs' },
  { value: 'sm', label: 'sm' },
  { value: DEFAULT_RADIUS, label: 'rounded' },
  { value: 'md', label: 'md' },
  { value: 'lg', label: 'lg' },
  { value: 'xl', label: 'xl' },
  { value: '2xl', label: '2xl' },
  { value: '3xl', label: '3xl' },
  { value: '4xl', label: '4xl' },
  { value: 'full', label: 'full' },
]

export function AppearanceSection() {
  return (
    <Section title="Appearance">
      <RadiusRow />
      <OpacityRow />
    </Section>
  )
}

function RadiusRow() {
  const editor = useEditor()
  const token = editor.state.radius
  const named = token?.name ?? null
  const gesture = useGesture((css) => ({ 'border-radius': css }), 'Radius', pxCss)
  const computedPx = Number.parseFloat(editor.computed['border-top-left-radius'] ?? '')
  const hint = token ? `${token.token}${token.css ? ` = ${token.css}` : ''}` : null
  return (
    <Row label="Radius" hint={hint}>
      <TokenSelect
        label="Radius token"
        value={named === null ? null : named === '' ? DEFAULT_RADIUS : named}
        options={RADIUS_OPTIONS}
        placeholder={token ? 'Custom' : 'Token'}
        className="w-24 shrink-0"
        onPick={(v) => editor.commitClasses([v === DEFAULT_RADIUS ? 'rounded' : `rounded-${v}`], 'Radius')}
        onClear={() => editor.clear(['rounded'], 'Radius')}
      />
      <ScrubField
        label="Radius"
        handle={<RadiusIcon />}
        // A named token's length depends on the project theme; show it as the computed value.
        value={gesture.draft ?? (named === null ? (token?.px ?? null) : null)}
        text={named === null && token && token.px === null ? (token.css ?? token.token) : null}
        placeholder={Number.isFinite(computedPx) ? formatNumber(computedPx) : undefined}
        unit="px"
        step={1}
        min={0}
        hint={hint ?? 'not set'}
        className="min-w-16 flex-1"
        onChange={gesture.change}
        onCommit={gesture.commit}
        onCommitText={gesture.commitText}
        onClear={() => editor.clear(['rounded'], 'Radius')}
        onCancel={gesture.cancel}
      />
    </Row>
  )
}

function OpacityRow() {
  const editor = useEditor()
  const token = editor.state.opacity
  const toCss = (percent: number) => formatNumber(percent / 100)
  const gesture = useGesture((css) => ({ opacity: css }), 'Opacity', toCss)
  const written = token?.css ? Number.parseFloat(token.css) * 100 : null
  const value = gesture.draft ?? (written !== null && Number.isFinite(written) ? Math.round(written * 100) / 100 : null)
  const computed = Number.parseFloat(editor.computed['opacity'] ?? '')
  const placeholder = Number.isFinite(computed) ? formatNumber(computed * 100) : '100'
  return (
    <Row label="Opacity" hint={token ? `${token.token} = ${token.css}` : null}>
      <ScrubSlider
        label="Opacity"
        value={value ?? Number.parseFloat(placeholder)}
        min={0}
        max={100}
        step={1}
        onChange={gesture.change}
        onCommit={gesture.commit}
        onCancel={gesture.cancel}
      />
      <ScrubField
        label="Opacity value"
        handle={<BlendIcon />}
        value={value}
        placeholder={placeholder}
        unit="%"
        step={1}
        min={0}
        max={100}
        hint={token ? `${token.token} = ${token.css}` : 'not set'}
        className="w-20 shrink-0"
        onChange={gesture.change}
        onCommit={gesture.commit}
        onCommitText={gesture.commitText}
        onClear={() => editor.clear(['opacity'], 'Opacity')}
        onCancel={gesture.cancel}
      />
      <TokenHint token={token?.token} className="max-w-16" />
    </Row>
  )
}
