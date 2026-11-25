import { globSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { componentManifestSchema, loadBlueprint, type ComponentManifest } from '@trivia/blueprint'

const kit = new URL('../kit/', import.meta.url)
export const fixtureDir = new URL('../fixtures/kit/', import.meta.url)

const list = (pattern: string, root: URL) => globSync(pattern, { cwd: fileURLToPath(root) }).sort()
const read = (file: string, root: URL) => readFileSync(new URL(file.replaceAll('\\', '/'), root), 'utf8')

export function kitManifests(): ComponentManifest[] {
  return list('*.manifest.json', kit).map((file) => {
    const manifest = componentManifestSchema.parse(JSON.parse(read(file, kit)))
    if (file !== manifest.type + '.manifest.json') throw new Error('Unexpected kit manifest filename: ' + file)
    return manifest
  })
}

export function fixture(): Record<string, string> {
  const files = ['app.blueprint.json', ...list('pages/*.page.json', fixtureDir)]
  return Object.fromEntries(files.map((file) => [file.replaceAll('\\', '/'), read(file, fixtureDir)]))
}

export function missingKitTypes(manifests: readonly Pick<ComponentManifest, 'type'>[], files: Record<string, string>): string[] {
  const types = new Set<string>()
  for (const entry of Object.values(loadBlueprint(files).docs)) {
    if (entry.kind !== 'page') continue
    if (entry.doc === null) throw new Error('Invalid fixture page: ' + entry.path)
    if (entry.doc.kind !== 'custom') continue
    for (const { type } of Object.values(entry.doc.nodes)) types.add(type)
  }
  return manifests.map(({ type }) => type).filter((type) => !types.has(type))
}
