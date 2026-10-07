import { execFile } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import ts from 'typescript'

import type { ManifestParameter, TriviaManifest } from '../src/manifest-types.js'

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)

export const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))
export const REPO_ROOT = path.resolve(PACKAGE_DIR, '../..')
export const FIXTURES = path.join(PACKAGE_DIR, 'test/fixtures')

export const fixture = (name: string): string => path.join(FIXTURES, name)

/** A throwaway "user project": node_modules links to this package's, so the generated code
 * resolves @tanstack/react-query and React types exactly like an app that installed them. */
export async function makeProject(prefix = 'trivia-contract-sync-'): Promise<string> {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), prefix)))
  await fsp.symlink(path.join(PACKAGE_DIR, 'node_modules'), path.join(root, 'node_modules'), 'dir')
  return root
}

export async function removeProject(root: string): Promise<void> {
  await fsp.rm(root, { recursive: true, force: true })
}

/** Mirrors examples/playground/tsconfig.app.json, plus `strict` and `noUncheckedIndexedAccess`. */
export const CONSUMER_TSCONFIG = {
  compilerOptions: {
    target: 'es2023',
    lib: ['ES2023', 'DOM'],
    module: 'esnext',
    moduleResolution: 'bundler',
    types: [],
    skipLibCheck: true,
    allowImportingTsExtensions: true,
    verbatimModuleSyntax: true,
    moduleDetection: 'force',
    noEmit: true,
    jsx: 'react-jsx',
    strict: true,
    noUncheckedIndexedAccess: true,
    noUnusedLocals: true,
    noUnusedParameters: true,
    erasableSyntaxOnly: true,
    noFallthroughCasesInSwitch: true,
    paths: { '@/*': ['./src/*'] },
  },
  include: ['src'],
}

/** Runs the real `tsc` binary; resolves with its exit code and output. */
export async function runTsc(projectRoot: string): Promise<{ code: number; output: string }> {
  await fsp.writeFile(path.join(projectRoot, 'tsconfig.json'), `${JSON.stringify(CONSUMER_TSCONFIG, null, 2)}\n`)
  const tsc = require.resolve('typescript/bin/tsc')
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [tsc, '-p', path.join(projectRoot, 'tsconfig.json')], {
      cwd: projectRoot,
    })
    return { code: 0, output: `${stdout}${stderr}` }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return { code: typeof failure.code === 'number' ? failure.code : 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` }
  }
}

export async function listFiles(dir: string, base = dir): Promise<string[]> {
  const files: string[] = []
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await listFiles(absolute, base)))
    else files.push(path.relative(base, absolute).split(path.sep).join('/'))
  }
  return files.sort()
}

export async function readTree(dir: string): Promise<Map<string, string>> {
  const tree = new Map<string, string>()
  for (const file of await listFiles(dir)) tree.set(file, await fsp.readFile(path.join(dir, file), 'utf8'))
  return tree
}

/** Exported value and type names of a TS file — an independent reader, not the one under test. */
export function exportedNames(file: string): Set<string> {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const names = new Set<string>()
  for (const statement of source.statements) {
    const exported = ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    if (!exported) continue
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text)
      }
    } else if (
      (ts.isFunctionDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) &&
      statement.name
    ) {
      names.add(statement.name.text)
    }
  }
  return names
}

/** Module specifiers imported or re-exported by a TS file (static and dynamic). */
export function moduleSpecifiers(text: string): string[] {
  const source = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push(node.moduleSpecifier.text)
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments
      if (argument && ts.isStringLiteralLike(argument)) found.push(argument.text)
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      found.push(node.argument.literal.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

function literalFor(parameter: ManifestParameter, value: number): string {
  // Values must match the generated parameter type: PostgREST types limit/offset as strings.
  return parameter.type === 'integer' || parameter.type === 'number' ? String(value) : `'${value}'`
}

const lowerFirst = (name: string): string => name.slice(0, 1).toLowerCase() + name.slice(1)

/**
 * Writes one component per resource with exactly the code shapes docs/data-provider.md specifies
 * for the Rust data binder, so `tsc` proves the manifest + generated types support them.
 */
export async function writeBinderConsumers(projectRoot: string, manifest: TriviaManifest): Promise<string[]> {
  const queries = manifest.modules.queries.importPath
  if (queries === null) throw new Error('fixture manifests must have an import path')
  const dir = path.join(projectRoot, 'src/bindings')
  await fsp.mkdir(dir, { recursive: true })
  const written: string[] = []
  for (const resource of manifest.resources) {
    const { list, get, create, update, delete: remove } = resource.operations
    const imports = new Set<string>()
    const hooks = new Set<string>()
    const body: string[] = []
    const base = lowerFirst(resource.name)
    if (list) {
      imports.add(list.queryOptionsFn as string)
      hooks.add('useQuery')
      const args: string[] = []
      const pagination = list.pagination
      const param = (name: string | null): ManifestParameter | undefined => list.parameters.find((p) => p.name === name)
      if (pagination?.style === 'page') {
        const page = param(pagination.pageParam)
        const size = param(pagination.pageSizeParam)
        if (page) args.push(`${page.name}: ${literalFor(page, 1)}`)
        if (size) args.push(`${size.name}: ${literalFor(size, 20)}`)
      } else if (pagination?.style === 'offset' || pagination?.style === 'limit' || pagination?.style === 'cursor') {
        const limit = param(pagination.limitParam ?? pagination.pageSizeParam)
        const offset = param(pagination.offsetParam)
        if (limit) args.push(`${limit.name}: ${literalFor(limit, 20)}`)
        if (offset) args.push(`${offset.name}: ${literalFor(offset, 0)}`)
      }
      const call = args.length > 0 ? `{ query: { ${args.join(', ')} } }` : ''
      body.push(
        `  const { data: ${base}Data, isLoading: is${resource.name}Loading } = useQuery({ ...${list.queryOptionsFn}(${call}) })`,
        `  const ${base}Rows = ${base}Data${list.listItemsPath === null ? '' : `?.${list.listItemsPath}`} ?? []`,
        `  void (<DataTable data={${base}Rows} isLoading={is${resource.name}Loading} />)`,
      )
    }
    if (get) {
      imports.add(get.queryOptionsFn as string)
      hooks.add('useQuery')
      if (get.postgrest?.rowFilter) {
        const filter = get.postgrest.rowFilter
        body.push(
          `  const { data: ${base}Match } = useQuery({ ...${get.queryOptionsFn}({ query: { ${filter.param}: \`eq.\${id}\`, limit: '1' } }) })`,
          `  const ${base}One = ${base}Match?.[0]`,
          `  void ${base}One`,
        )
      } else {
        body.push(
          `  const { data: ${base}One } = useQuery({ ...${get.queryOptionsFn}({ path: { ${get.idParam}: id } }) })`,
          `  void ${base}One`,
        )
      }
    }
    for (const operation of [create, update, remove]) {
      if (!operation) continue
      imports.add(operation.mutationFn as string)
      hooks.add('useMutation')
      body.push(`  const ${operation.mutationFn}State = useMutation({ ...${operation.mutationFn}() })`, `  void ${operation.mutationFn}State`)
    }
    if (body.length === 0) continue
    const file = path.join(dir, `${resource.name}Binding.tsx`)
    await fsp.writeFile(
      file,
      [
        `import { ${[...hooks].sort().join(', ')} } from '@tanstack/react-query'`,
        `import { ${[...imports].sort().join(', ')} } from '${queries}'`,
        '',
        'function DataTable<TRow>(props: { data: readonly TRow[]; isLoading: boolean }) {',
        '  return props.isLoading ? null : <table data-rows={props.data.length} />',
        '}',
        '',
        `export function ${resource.name}Binding({ id }: { id: string }) {`,
        '  void id',
        ...body,
        '  return null',
        '}',
        '',
      ].join('\n'),
    )
    written.push(file)
  }
  return written
}
