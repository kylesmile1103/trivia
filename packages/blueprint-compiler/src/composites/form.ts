import { pageDocPath, toPointer, type CustomPage, type Diagnostic } from '@trivia/blueprint'
import type { ManifestField, TriviaManifest } from '@trivia/contract-sync'

import { CompileError } from '../compile.js'
import type { AttributeIR, JsxIR } from '../ir.js'
import { literal, property, quote } from '../print/style.js'
import { refineName } from '../targets/paths.js'
import { resourceRowType, snippet, withNodeAttributes, type CompositeScope } from './source.js'

type Element = Extract<JsxIR, { kind: 'element' }>

function editable(field: ManifestField): boolean {
  return !field.readOnly && ['string', 'integer', 'number', 'boolean'].includes(field.type ?? '')
}

export function checkForm(page: CustomPage, id: string, contract: TriviaManifest | null | undefined) {
  const props = page.props[id] ?? {}
  const diagnostics: Diagnostic[] = []
  const report = (code: string, prop: string, message: string, index?: number) => diagnostics.push({
    code, doc: pageDocPath(page.name), pointer: toPointer(['props', id, prop, ...(index === undefined ? [] : [index])]),
    severity: 'error', message,
  })
  const mode = props['mode'] ?? 'create'
  const modeValid = mode === 'create' || mode === 'edit'
  if (!modeValid) report('invalid_prop_value', 'mode', 'Form.mode expects create or edit.')
  if (mode === 'edit' && !page.route.split('/').includes(':id')) {
    report('invalid_prop_value', 'mode', 'A Form in edit mode requires an :id route parameter.')
  }
  const resource = contract?.resources.find(({ name }) => name === props['resource'])
  const operation = mode === 'edit' ? 'update' : 'create'
  const body = resource?.operations[operation]?.requestBody?.fields
  if (!resource) report('unknown_resource', 'resource', typeof props['resource'] === 'string'
    ? 'Unknown Form resource "' + props['resource'] + '".'
    : 'Form requires a contract resource.')
  else if (modeValid && !body) report('unsupported_operation', 'resource', resource.name + ' has no ' + operation + ' request body.')
  const selection = props['fields']
  let fields = body?.filter(editable) ?? []
  if (selection !== undefined) {
    fields = []
    if (!Array.isArray(selection) || !selection.length) {
      report('invalid_prop_value', 'fields', 'Form.fields expects a nonempty list of field names.')
    } else if (body) {
      for (const [index, name] of selection.entries()) {
        const field = body.find((candidate) => candidate.name === name)
        if (!field) report('unknown_field', 'fields', 'Unknown request field "' + String(name) + '".', index)
        else if (!editable(field)) report('invalid_prop_value', 'fields', 'Form cannot generate an editable control for "' + field.name + '".', index)
        else if (!fields.includes(field)) fields.push(field)
      }
    }
  } else if (body && !fields.length) {
    report('invalid_prop_value', 'fields', 'Form has no editable fields.')
  }
  const layout = props['layout'] ?? 'stack'
  if (layout !== 'stack' && layout !== 'grid-2') report('invalid_prop_value', 'layout', 'Form.layout expects stack or grid-2.')
  const redirect = props['redirect'] === undefined ? 'list' : props['redirect']
  if (redirect !== false && (typeof redirect !== 'string' || !['list', 'show', 'edit', 'create'].includes(redirect))) {
    report('invalid_prop_value', 'redirect', 'Form.redirect expects list, show, edit, create or false.')
  }
  return { diagnostics, resource, fields, mode, layout, redirect }
}

const value = (name: string, staticValue: unknown): AttributeIR => ({ name, value: { kind: 'static', value: staticValue } })
const binding = (name: string, code: string): AttributeIR => ({ name, value: { kind: 'expr', code } })

export function lowerForm(page: CustomPage, id: string, root: Element, scope: CompositeScope): Element {
  const { context: { facts, refineSnippets } } = scope
  const { diagnostics, resource, fields, mode, layout, redirect } = checkForm(page, id, scope.context.contract)
  if (diagnostics.length || !resource) throw new CompileError('invalid_result', 'Cannot compile Form.', { diagnostics })
  if (!refineSnippets) throw new CompileError('unsupported', 'The Refine form-field builder is unavailable.')
  const name = page.nodes[id]!.name
  const idPrefix = name.replace(/([a-z\d])([A-Z])/g, '$1-$2').toLowerCase()
  const schema = scope.name(resource.name.charAt(0).toLowerCase() + resource.name.slice(1) + 'Schema')
  const form = scope.name('form')
  const onFinish = scope.name('onFinish')
  const formLoading = scope.name('formLoading')
  const resolver = scope.import({ name: 'zodResolver', source: '@hookform/resolvers/zod' })
  const useForm = scope.import({ name: 'useForm', source: '@refinedev/react-hook-form' })
  const httpError = scope.import({ name: 'HttpError', source: '@refinedev/core', kind: 'type' })
  const z = scope.import({ name: 'z', source: 'zod' })
  const row = resourceRowType(resource, scope)
  const ui = facts.aliases['ui']
  const button = scope.import({ name: 'Button', source: ui + '/button' })
  const legacy = facts.formStyle === 'FormField'
  const group = legacy ? 'div' : scope.import({ name: 'FieldGroup', source: ui + '/field' })
  const pieces = fields.map((field) => ({ field, ...refineSnippets.field(field, idPrefix) }))
  const style = facts.style
  const str = (text: string) => quote(text, style)
  const key = (field: ManifestField) => property(field.name, style)
  const rules = pieces.map(({ field, rule }) => '  ' + key(field) + ': ' + snippet(rule, [], scope, { z }) + ',')
  const defaults = pieces.map(({ field, defaultValue }) => '    ' + key(field) + ': ' + defaultValue + ',')
  const coreKey = (key: string, local: string) => key === local ? key : key + ': ' + local
  const params = mode === 'edit' ? scope.name('formParams') : undefined
  if (params) {
    const useParams = scope.import({ name: 'useParams', source: 'react-router' })
    scope.declarations.push(`const ${params} = ${useParams}();`)
  }
  scope.declarations.push(
    `const ${schema} = ${z}.object({\n${rules.join('\n')}\n});`,
    `const { refineCore: { ${coreKey('onFinish', onFinish)}, ${coreKey('formLoading', formLoading)} }, ...${form} } = ${useForm}<${row}, ${httpError}, ${z}.infer<typeof ${schema}>>({
  resolver: ${resolver}(${schema}),
  defaultValues: {
${defaults.join('\n')}
  },
  refineCoreProps: {
    resource: ${str(refineName(resource))},
    action: ${str(String(mode))},
    redirect: ${literal(redirect, style)},${params ? '\n    id: ' + params + '.id,' : ''}
  },
});`,
  )

  const submit = mode === 'edit' ? 'Save changes' : 'Create ' + resource.name
    .replace(/([a-z\d])([A-Z])/g, '$1 $2').toLowerCase()
  const formElement: Element = {
    kind: 'element', tag: 'form',
    props: [value('aria-label', submit), value('noValidate', true), binding('onSubmit', `${form}.handleSubmit(${onFinish})`)],
    children: [{
      kind: 'element', tag: group,
      props: [value('className', layout === 'grid-2' ? 'grid gap-4 sm:grid-cols-2' : 'grid gap-4')],
      children: pieces.map((piece) => ({ kind: 'source', code: snippet(piece.controller, piece.imports, scope, { form }) })),
    }, {
      kind: 'element', tag: button, props: [value('type', 'submit'), binding('disabled', formLoading)],
      children: [{ kind: 'text', value: submit }],
    }, ...root.children],
  }
  const content: Element = legacy ? {
    kind: 'element', tag: scope.import({ name: 'Form', source: ui + '/form' }),
    props: [], spreads: [form], children: [formElement],
  } : formElement
  return withNodeAttributes(root, content)
}
