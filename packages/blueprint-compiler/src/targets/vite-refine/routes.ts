import { CONTRACT_KINDS, type ContractPage } from '@trivia/blueprint'

export interface RouteRegistration {
  kind?: ContractPage['kind']
  resource?: string
  route: string
  component: string
  importPath: string
}

export interface RouteAnchor {
  parent: string
  index: number
  placement: 'before' | 'after'
}

export function resourceOps(path: string, name: string, routes: Partial<Record<ContractPage['kind'], string>>, exists: boolean) {
  const kinds = CONTRACT_KINDS.filter((kind) => routes[kind] !== undefined)
  if (!kinds.length) return []
  if (exists) {
    return kinds.map((kind) => ({
      op: 'setProperty', path: path + '[name=' + name + ']', prop: kind, value: JSON.stringify(routes[kind]),
    }))
  }
  const keys = ['name: ' + JSON.stringify(name), ...kinds.map((kind) => kind + ': ' + JSON.stringify(routes[kind]))]
  return [{ op: 'insertElement', path, value: '{\n  ' + keys.join(',\n  ') + ',\n}' }]
}

export function routeOps(files: readonly RouteRegistration[], anchor: RouteAnchor) {
  return files.map((file, index) => ({
    op: 'insert',
    target: anchor.parent + '.' + (anchor.index + index),
    expectedName: 'Route',
    placement: anchor.placement,
    snippet: '<Route path=' + JSON.stringify(file.route) + ' element={<'+ file.component + ' />} />',
    imports: [{ name: file.component, source: file.importPath }],
  }))
}
