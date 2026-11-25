import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function copyBlueprintProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trivia-blueprint-test-'))
  const example = path.resolve(import.meta.dirname, '../../../examples/refine-admin')
  fs.cpSync(path.join(example, 'src'), path.join(root, 'src'), { recursive: true })
  for (const file of ['components.json', 'trivia.manifest.json']) fs.copyFileSync(path.join(example, file), path.join(root, file))
  return fs.realpathSync(root)
}

export const listPage = (name = 'Customers', resource = 'Customer') => ({
  op: 'createPage', doc: `pages/${name}.page.json`, baseRev: null,
  name, route: `/${name.toLowerCase()}`, kind: 'list', resource,
} as const)
