import type { EmittedModule } from '../../compile.js'
import type { ProjectFacts } from '../../facts.js'
import { printModule } from '../../print/module.js'
import { restyleModule } from '../../print/style.js'
import { relativeModule } from '../paths.js'
import type { LoweredPage } from '../target.js'

export function files(page: LoweredPage, facts: ProjectFacts): [EmittedModule] {
  if (page.kind === 'contract') {
    const { content, ...generated } = page.generated
    return [{ ...generated, code: restyleModule(content, facts.style), route: page.page.route, requires: [] }]
  }
  const { ir, requires, handler } = page
  const { file, route, name } = ir
  const printed = printModule(ir, facts)
  return [{
    code: ir.declarations?.length ? restyleModule(printed, facts.style) : printed,
    file, route, component: name, importPath: relativeModule('src/App.tsx', file),
    ...(handler && { handler }), requires,
  }]
}
