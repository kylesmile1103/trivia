import type { PrintStyle, ProjectFacts } from '../facts.js'
import type { HandlerIR, HookIR, PageIR } from '../ir.js'
import { printImports } from './imports.js'
import { printJsx } from './jsx.js'
import { statement } from './style.js'

export function printHook({ name, hook, args, type }: HookIR, style: PrintStyle): string {
  return statement('const ' + name + ' = ' + hook + (type ? '<' + type + '>' : '') + '(' + (args ?? '') + ')', style)
}

export function printHandler({ name, params, body }: HandlerIR, style: PrintStyle): string {
  return ['async function ' + name + '(' + params.join(', ') + ') {',
    ...body.map((step) => '  ' + statement((step.await ? 'await ' : '') + step.code, style)), '}'].join('\n')
}

export function printModule(ir: PageIR, facts: ProjectFacts): string {
  const { style } = facts
  const indent = (code: string) => code.split('\n').map((line) => '  ' + line).join('\n')
  const declarations = [
    ...ir.state.map(({ name, setter, type, initial }) => statement(
      'const [' + name + ', ' + setter + '] = useState<' + type + '>(' + initial + ')', style)),
    ...[...ir.hooks, ...ir.queries, ...ir.mutations].map((hook) => printHook(hook, style)),
  ]
  const body = [
    ...(declarations.length ? [declarations.map(indent).join('\n')] : []),
    ...ir.handlers.map((handler) => indent(printHandler(handler, style))),
    '  return (\n' + printJsx(ir.jsx, 2, style) + '\n  ' + statement(')', style),
  ]
  const imports = printImports(ir.imports, facts)
  const component = 'export function ' + ir.name + '() {\n' + body.join('\n\n') + '\n}\n'
  return (imports ? imports + '\n\n' : '') + component
}
