import type { ComponentManifest, ManifestEvent, PropSchema } from './types.js'

const tags = [
  'div', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'section', 'header', 'footer', 'main', 'ul', 'li', 'a', 'img', 'form', 'label',
] as const
type Tag = (typeof tags)[number]

const prop = (name: string, kind: 'string' | 'number' | 'boolean' | 'className' = 'string'): PropSchema =>
  ({ name, kind, optional: true, source: 'intrinsic' })

const commonProps = [prop('className', 'className'), prop('id'), prop('title'), prop('role'), prop('aria-label'), prop('hidden', 'boolean')]
const extraProps: Partial<Record<Tag, PropSchema[]>> = {
  a: [prop('href'), prop('target'), prop('rel')],
  img: [prop('src'), prop('alt'), prop('width', 'number'), prop('height', 'number')],
  form: [prop('action'), prop('method'), prop('name')],
  label: [prop('htmlFor')],
  li: [prop('value', 'number')],
}

const commonEvents = ['onClick', 'onDoubleClick', 'onFocus', 'onBlur', 'onKeyDown', 'onKeyUp', 'onMouseEnter', 'onMouseLeave']
const formEvents = ['onSubmit', 'onReset']
const mediaEvents = ['onLoad', 'onError']
const valueEvents = ['onInput', 'onChange']
export const INTRINSIC_EVENT_NAMES: ReadonlySet<string> = new Set([
  ...commonEvents, ...formEvents, ...mediaEvents, ...valueEvents,
])

const event = (name: string): ManifestEvent => ({ name, prop: name })

export const intrinsicManifests: readonly ComponentManifest[] = tags.map((type) => ({
  type,
  source: { registry: 'local', item: type, import: { name: type, from: '' } },
  props: [...commonProps, ...(extraProps[type] ?? []), ...(type === 'img' ? [] : [prop('children')])],
  slots: type === 'img' ? [] : [{ name: 'children', kind: 'nodes' }],
  events: [
    ...commonEvents,
    ...(type === 'form' ? formEvents : []),
    ...(type === 'img' ? mediaEvents : []),
  ].map(event),
  exposes: [],
  client: false,
  template: {},
}))
