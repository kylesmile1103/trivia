// Build @trivia/engine first with pnpm build:engine, then run this script from any directory.
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { dirname, join, resolve } = require('node:path')
const { pathToFileURL } = require('node:url')

async function main() {
  const repo = resolve(__dirname, '../..')
  const root = join(repo, 'examples/refine-admin')
  const { aliases } = JSON.parse(readFileSync(join(root, 'components.json'), 'utf8'))
  const { components } = await import(pathToFileURL(join(repo, 'crates/trivia_napi/index.js')).href)
  const result = JSON.parse(components(root, 'src/components/ui', aliases.ui))
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)

  const file = join(repo, 'packages/blueprint/fixtures/manifests/analyzer/refine-admin.components.json')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(result.data, null, 2) + '\n')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
