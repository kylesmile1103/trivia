// Size: width and height presets (auto / full / fit / screen) plus a numeric value.

import { formatNumber } from '@/lib/tailwind'

import { useEditor } from './editor'
import { Row, ScrubField, Section } from './fields'
import { useGesture } from './gesture'
import { KeywordToggle, type KeywordOption } from './KeywordToggle'

type Axis = 'width' | 'height'

function presets(axis: Axis): KeywordOption[] {
  return [
    { value: 'auto', title: 'Auto', content: 'auto' },
    { value: '100%', title: 'Full', content: 'full' },
    { value: 'fit-content', title: 'Fit content', content: 'fit' },
    { value: axis === 'width' ? '100vw' : '100vh', title: 'Screen', content: 'screen' },
  ]
}

export function SizeSection() {
  return (
    <Section title="Size">
      <SizeRow axis="width" />
      <SizeRow axis="height" />
    </Section>
  )
}

function SizeRow({ axis }: { axis: Axis }) {
  const editor = useEditor()
  const token = editor.state[axis]
  const label = axis === 'width' ? 'Width' : 'Height'
  const options = presets(axis)
  const preset = token?.css && options.some((o) => o.value === token.css) ? token.css : null
  const gesture = useGesture((css) => ({ [axis]: css }), label)
  // Non-length values that are not presets (w-1/2, w-sm, w-[50%]) show as text.
  const text = token && preset === null && token.px === null ? (token.name ?? token.css ?? token.token) : null
  const computedPx = Number.parseFloat(editor.computed[axis] ?? '')

  return (
    <Row label={label} hint={token ? `${token.token}${token.css ? ` = ${token.css}` : ''}` : null}>
      <KeywordToggle
        property={axis}
        utility={axis === 'width' ? 'w' : 'h'}
        label={label}
        options={options}
        value={preset}
        itemClassName="px-1 font-mono text-[10px]"
      />
      <ScrubField
        label={label}
        handle={axis === 'width' ? 'W' : 'H'}
        value={gesture.draft ?? token?.px ?? null}
        text={text}
        placeholder={Number.isFinite(computedPx) ? formatNumber(Math.round(computedPx)) : undefined}
        step={4}
        min={0}
        hint={token ? `${token.token}${token.css ? ` = ${token.css}` : ''}` : 'not set'}
        className="min-w-14 flex-1"
        onChange={gesture.change}
        onCommit={gesture.commit}
        onCommitText={gesture.commitText}
        onClear={() => editor.clear([axis === 'width' ? 'w' : 'h'], label)}
        onCancel={gesture.cancel}
      />
    </Row>
  )
}
