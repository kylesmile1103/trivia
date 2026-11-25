// Build @trivia/engine first with pnpm build:engine, then run this script from any directory.
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { dirname, join, resolve } = require('node:path')
const { pathToFileURL } = require('node:url')

async function main() {
  const repo = resolve(__dirname, '../..')
  const root = join(repo, 'examples/refine-admin')
  const { aliases } = JSON.parse(readFileSync(join(root, 'components.json'), 'utf8'))
  const { components } = await import(pathToFileURL(join(repo, 'crates/trivia_napi/index.js')).href)
  const libraries = [
    ['src/components/ui', aliases.ui],
    ['src/components/refine-ui/data-table', `${aliases.components}/refine-ui/data-table`],
  ]
  const schemas = libraries.flatMap(([directory, importBase]) => {
    const result = JSON.parse(components(root, directory, importBase))
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.data
  })

  const file = join(repo, 'packages/blueprint/fixtures/manifests/analyzer/refine-admin.components.json')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(schemas, null, 2) + '\n')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
