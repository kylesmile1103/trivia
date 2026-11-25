import type { ResolvedManifest } from '@trivia/blueprint'

import { CompileError } from '../compile.js'
import type { PrintStyle } from '../facts.js'
import type { AttributeIR, JsxIR } from '../ir.js'
import { quote } from '../print/style.js'

type Element = Extract<JsxIR, { kind: 'element' }>

const element = (tag: string, children: JsxIR[] = [], props: AttributeIR[] = []): Element =>
  ({ kind: 'element', tag, props, children })
const text = (value: string): JsxIR => ({ kind: 'text', value })
const expr = (code: string): JsxIR => ({ kind: 'expr', code })
const attr = (name: string, value: unknown): AttributeIR => ({ name, value: { kind: 'static', value } })
const bound = (name: string, code: string): AttributeIR => ({ name, value: { kind: 'expr', code } })

export function kitInput(
  manifest: ResolvedManifest, root: Element, part: (name: string) => string,
  popover: (name: string) => string, style: PrintStyle,
): Element {
  if (manifest.source.registry !== 'shadcn') return root
  const attributes = new Map(root.props.map(({ name, value }) => [name, value]))
  const config = (name: string) => {
    const value = attributes.get(name)
    if (!value) return
    if (value.kind !== 'static') throw new CompileError('invalid_result', manifest.type + '.' + name + ' requires a static value.')
    root.props = root.props.filter((prop) => prop.name !== name)
    return value.value
  }
  const value = (name: string) => {
    const attribute = attributes.get(name)
    return attribute?.kind === 'expr' ? attribute.code : 'undefined'
  }
  const label = (fallback: string) => {
    const placeholder = config('placeholder') ?? fallback
    if (typeof placeholder !== 'string') throw new CompileError('invalid_result', manifest.type + '.placeholder expects text.')
    return placeholder
  }
  if (manifest.type === 'Select') {
    const placeholder = label('Choose an option')
    root.children.unshift(element(part('SelectTrigger'), [
      element(part('SelectValue'), [], [attr('placeholder', placeholder)]),
    ]))
  }
  const popup = (trigger: JsxIR) => {
    const keys = root.props.filter(({ name }) => name === 'key')
    root.props = root.props.filter(({ name }) => name !== 'key')
    return element(popover('Popover'), [
      element(popover('PopoverTrigger'), [trigger]),
      element(popover('PopoverContent'), [root]),
    ], keys)
  }
  if (manifest.type === 'DatePicker') {
    root.props.unshift(attr('mode', 'single'))
    return popup(expr('(' + value('selected') + ')?.toLocaleDateString() ?? ' + quote('Pick a date', style)))
  }
  if (manifest.type === 'Combobox') {
    const placeholder = label('Choose an option')
    const options = config('options') ?? []
    if (!Array.isArray(options) || options.some((option) => typeof option !== 'string' || option === '') ||
      new Set(options).size !== options.length) {
      throw new CompileError('invalid_result', 'Combobox.options expects distinct nonempty strings.')
    }
    const selected = value('value')
    const change = value('onValueChange')
    root.props = root.props.filter(({ name }) => name !== 'value' && name !== 'onValueChange')
    root.children.push(element(part('CommandInput'), [], [attr('placeholder', placeholder)]))
    root.children.push(element(part('CommandList'), [
      element(part('CommandEmpty'), [text('No matching options')]),
      element(part('CommandGroup'), options.map((option: string) => element(part('CommandItem'), [text(option)], [
        attr('value', option), bound('onSelect', '() => (' + change + ')(' + quote(option, style) + ')'),
      ]))),
    ]))
    return popup(expr('(' + selected + ') || ' + quote(placeholder, style)))
  }
  return root
}
