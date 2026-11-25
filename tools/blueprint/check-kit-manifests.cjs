// Run after building @trivia/engine. The registry sources used here are committed fixtures.
const { readFileSync, readdirSync } = require('node:fs')
const { createRequire } = require('node:module')
const { join, resolve } = require('node:path')
const { pathToFileURL } = require('node:url')

const repo = resolve(__dirname, '../..')
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

async function main() {
  const directory = resolve(process.argv[2] ?? join(repo, 'packages/blueprint-compiler/kit'))
  const root = resolve(process.argv[3] ?? join(repo, 'examples/blueprint-kit'))
  const { aliases, style } = readJson(join(root, 'components.json'))
  const project = join(root, 'tsconfig.json')
  const ts = createRequire(project)('typescript')
  const config = ts.readConfigFile(project, ts.sys.readFile)
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
  const program = ts.createProgram(parsed.fileNames, parsed.options)
  const checker = program.getTypeChecker()
  const { components } = await import(pathToFileURL(join(repo, 'crates/trivia_napi/index.js')).href)
  const libraries = [['src/components/ui', aliases.ui], ['src/components/refine-ui/data-table', aliases.components + '/refine-ui/data-table']]
  const analyzed = libraries.flatMap(([dir, alias]) => {
    const result = JSON.parse(components(root, dir, alias))
    if (!result.ok) throw new Error(result.error.message)
    return result.data
  })

  const failures = []
  const files = readdirSync(directory).filter((name) => name.endsWith('.manifest.json')).sort()
  for (const file of files) {
    const base = readJson(join(directory, file))
    const { type, source, composite, events, exposes, slots } = { ...base, ...base.variants?.[style] }
    const report = (name, description) => failures.push(`${type}: ${name} ${description}`)
    const component = analyzed.find(({ name, importSource }) =>
      name === source.import.name && (['ui', 'refine-ui'].includes(source.import.from) || source.import.from === importSource))
    if (!component) {
      report(source.import.name, 'is missing from the installed library')
      continue
    }

    const module = program.getSourceFile(resolve(root, component.file))
    const symbol = module && checker.getSymbolAtLocation(module)
    const exports = symbol ? checker.getExportsOfModule(symbol) : []
    for (const name of new Set([...Object.values(source.parts ?? {}), ...slots.flatMap((slot) => slot.wrapper ?? [])])) {
      if (!exports.some((entry) => entry.getName() === name)) report(name, `is not exported by ${component.file}`)
    }
    // Composites have blueprint-level configuration and exposures rather than native props.
    if (composite) continue
    const exported = exports.find((entry) => entry.getName() === component.name)
    const callable = exported && checker.getTypeOfSymbolAtLocation(exported, module)
    const types = callable?.getCallSignatures().flatMap((signature) => {
      const parameter = signature.getParameters()[0]
      if (!parameter) return []
      const props = checker.getTypeOfSymbolAtLocation(parameter, module)
      return props.isUnion() ? props.types : [props]
    }) ?? []
    const expectedProps = [
      ...events.map(({ prop }) => prop),
      ...exposes.flatMap(({ via }) => [via.valueProp, via.changeProp]),
    ]
    for (const name of new Set(expectedProps)) {
      if (!component.props.some((prop) => prop.name === name) && !types.some((props) => props.getProperty(name))) {
        report(name, `is not a prop of ${component.name} in ${component.file}`)
      }
    }
  }
  if (failures.length) throw new Error(failures.join('\n'))
  console.log(`Checked ${files.length} manifests against ${style}.`)
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
