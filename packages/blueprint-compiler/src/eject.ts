import { pageDocPath, revOfText, type Blueprint, type PageDoc } from '@trivia/blueprint'

import { CompileError, compilePage, type CompileContext, type EmittedModule, type RegistryItem } from './compile.js'
import type { Lock } from './lock.js'
import { compareBytes } from './print/style.js'

export interface EjectRoute {
  path: string
  file: string | null
  component: string | null
}

export interface EjectSnapshot {
  files: ReadonlyMap<string, string>
  routes: readonly EjectRoute[]
  compiler: string
}

export interface EjectContext extends EjectSnapshot {
  compile: CompileContext
}

export interface EjectPage {
  page: PageDoc
  rev: string
  module: EmittedModule
}

export type SourceOp =
  | { op: 'createFile'; file: string; content: string; ifMissing?: boolean }
  | { op: 'replaceFile'; file: string; expectedHash: string; content: string }

export interface EjectPlan {
  ops: SourceOp[]
  files: string[]
  requires: RegistryItem[]
  warnings: string[]
  lock: Lock
  label: string
  registrations: EjectPage[]
}

export const routePattern = (route: string) => route.replace(/\/(?::|\$)[^/]+/g, '/:').toLowerCase().replace(/\/$/, '')

export function prepareEject(
  blueprint: Blueprint, pages: readonly string[] | undefined, context: CompileContext, lock: Lock,
): EjectPage[] {
  const selected = pages ?? Object.values(blueprint.docs).flatMap((entry) =>
    entry.kind === 'page' && entry.doc && !Object.hasOwn(lock.pages, entry.doc.name) ? [entry.doc.name] : [])
  if (!selected.length) throw new CompileError('invalid_op', 'No draft blueprint pages were selected.')
  const requires: RegistryItem[] = []
  const work = [...new Set(selected)].sort(compareBytes).map((name) => {
    const entry = blueprint.docs[pageDocPath(name)]
    if (entry?.kind === 'page' && entry.doc?.kind === 'custom') {
      for (const { type } of Object.values(entry.doc.nodes)) {
        const manifest = context.manifests?.[type]
        if (manifest && !manifest.installed) requires.push({ registry: manifest.source.registry, item: manifest.source.item })
      }
    }
    return { name, entry }
  })
  needsComponents(requires)
  const prepared = work.map(({ name, entry }) => {
    const module = compilePage(blueprint, name, context)
    requires.push(...module.requires)
    return { page: entry!.doc as PageDoc, rev: entry!.rev, module }
  })
  needsComponents(requires)
  return prepared
}

function needsComponents(items: readonly RegistryItem[]): void {
  const grouped = new Map(items.map((item) => [item.registry + '/' + item.item, item]))
  if (!grouped.size) return
  const requires = [...grouped].sort(([a], [b]) => compareBytes(a, b)).map(([, item]) => item)
  throw new CompileError('unresolved_component', 'Install the required registry components before ejecting.', { requires })
}

export function planEject(blueprint: Blueprint, pages: readonly string[] | undefined, context: EjectContext, lock: Lock): EjectPlan {
  return planCompiledEject(prepareEject(blueprint, pages, context.compile, lock), context, lock)
}

export function planCompiledEject(prepared: readonly EjectPage[], snapshot: EjectSnapshot, lock: Lock): EjectPlan {
  const ops: SourceOp[] = []
  const files: string[] = []
  const registrations: EjectPage[] = []
  const records = { ...lock.pages }
  const used = new Set(Object.values(records).map(({ file }) => file))
  const routes = new Map(snapshot.routes.map((route) => [routePattern(route.path), route]))
  for (const candidate of prepared) {
    const { page: { name }, rev, module } = candidate
    const { file, code, route, component, handler } = module
    const previous = Object.hasOwn(records, name) ? records[name] : undefined
    const conflict = (why: string): never => { throw new CompileError('conflict', why, { page: name, file }) }
    if (previous && (previous.file !== file || (previous.route !== undefined && previous.route !== route))) {
      conflict('The file or route of ' + name + ' moved since its last eject.')
    }
    const existing = snapshot.files.get(file)
    if (!previous && (existing !== undefined || used.has(file))) conflict(file + ' is already owned by the project.')
    if (previous && existing !== undefined && revOfText(existing) !== previous.hash) conflict(file + ' changed since its last eject.')

    const pattern = routePattern(route)
    const claimed = routes.get(pattern)
    if (claimed) {
      const sameRoute = claimed.path === route && (claimed.file === file ||
        (previous?.route === route && claimed.file === null && claimed.component === previous.component))
      if (!previous || !sameRoute) conflict(route + ' is already registered in the app.')
    } else {
      registrations.push(candidate)
      routes.set(pattern, { path: route, file, component })
    }

    ops.push(existing === undefined ? { op: 'createFile', file, content: code }
      : { op: 'replaceFile', file, expectedHash: previous!.hash, content: code })
    files.push(file)
    used.add(file)
    records[name] = { file, hash: revOfText(code), blueprintRev: rev, route, component }
    if (handler && !snapshot.files.has(handler.file)) {
      ops.push({ op: 'createFile', file: handler.file, content: handler.code, ifMissing: true })
      files.push(handler.file)
    }
  }
  return {
    ops, files, registrations, requires: [], warnings: prepared.flatMap(({ module }) => module.warnings ?? []),
    lock: { ...lock, compiler: snapshot.compiler, pages: records },
    label: 'Eject ' + prepared.map(({ page }) => page.name).join(', '),
  }
}
