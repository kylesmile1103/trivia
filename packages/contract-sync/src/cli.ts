// trivia-contract-sync — generate typed TanStack Query code and trivia.manifest.json from a contract.

import { parseArgs } from 'node:util'

import { ContractSyncError, describeError } from './errors.js'
import type { ImportBase } from './manifest/generator.js'
import { DEFAULT_MANIFEST_PATH, DEFAULT_OUTPUT_DIR, syncContract } from './sync.js'
import { contractSyncVersion } from './versions.js'

const USAGE = `Usage: trivia-contract-sync --input <path|url> [options]
       trivia-contract-sync --supabase-url <url> --supabase-key <key> [options]

Generates typed fetch functions and TanStack Query v5 option factories with
@hey-api/openapi-ts, plus a static trivia.manifest.json for the Trivia designer.

Options:
  --input <path|url>      OpenAPI 3.0/3.1 or Swagger 2.0 document (JSON or YAML)
  --output <dir>          Generated code directory (default: ${DEFAULT_OUTPUT_DIR})
  --manifest <file>       Manifest path (default: ${DEFAULT_MANIFEST_PATH})
  --supabase-url <url>    Supabase project URL; reads PostgREST's spec from <url>/rest/v1/
  --supabase-key <key>    Secret (sb_secret_…) or service_role key; or set TRIVIA_SUPABASE_KEY
  --import-alias <a=dir>  Import alias for the manifest's import paths (default: @/=src)
  --zod                   Also generate zod schemas (zod.gen.ts) for forms; the code then imports zod
  --cwd <dir>             Project root; relative paths resolve against it (default: .)
  -h, --help              Show this help
  -v, --version           Show the version
`

export interface CliIo {
  stdout: (text: string) => void
  stderr: (text: string) => void
  env: Readonly<Record<string, string | undefined>>
}

const defaultIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
}

function parseImportAlias(value: string): ImportBase {
  const separator = value.indexOf('=')
  const alias = value.slice(0, separator)
  const dir = value.slice(separator + 1)
  if (separator <= 0 || dir.length === 0) {
    throw new ContractSyncError('usage', `--import-alias must look like "@/=src", got "${value}"`)
  }
  return { alias, dir }
}

/** Runs the CLI; returns the process exit code (0 ok, 1 failure, 2 usage error). */
export async function main(argv: readonly string[], io: CliIo = defaultIo): Promise<number> {
  let values: Record<string, string | boolean | undefined>
  try {
    values = parseArgs({
      args: [...argv],
      allowPositionals: false,
      strict: true,
      options: {
        input: { type: 'string' },
        output: { type: 'string' },
        manifest: { type: 'string' },
        'supabase-url': { type: 'string' },
        'supabase-key': { type: 'string' },
        'import-alias': { type: 'string' },
        zod: { type: 'boolean' },
        cwd: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    }).values
  } catch (error) {
    io.stderr(`error: ${describeError(error)}\n\n${USAGE}`)
    return 2
  }
  if (values['help']) {
    io.stdout(USAGE)
    return 0
  }
  if (values['version']) {
    io.stdout(`${contractSyncVersion()}\n`)
    return 0
  }

  const input = values['input'] as string | undefined
  const supabaseUrl = values['supabase-url'] as string | undefined
  const supabaseKey = (values['supabase-key'] as string | undefined) ?? io.env['TRIVIA_SUPABASE_KEY']
  if ((input === undefined) === (supabaseUrl === undefined)) {
    io.stderr(`error: pass either --input or --supabase-url\n\n${USAGE}`)
    return 2
  }
  if (supabaseUrl !== undefined && !supabaseKey) {
    io.stderr('error: --supabase-url needs --supabase-key (or TRIVIA_SUPABASE_KEY)\n')
    return 2
  }

  try {
    const importAlias = values['import-alias'] as string | undefined
    const result = await syncContract({
      ...(input !== undefined ? { input } : {}),
      ...(supabaseUrl !== undefined && supabaseKey ? { supabase: { url: supabaseUrl, key: supabaseKey } } : {}),
      ...(values['output'] !== undefined ? { outputDir: values['output'] as string } : {}),
      ...(values['manifest'] !== undefined ? { manifestPath: values['manifest'] as string } : {}),
      ...(values['cwd'] !== undefined ? { cwd: values['cwd'] as string } : {}),
      ...(importAlias !== undefined ? { importBase: parseImportAlias(importAlias) } : {}),
      ...(values['zod'] ? { zod: true } : {}),
    })
    const { manifest } = result
    io.stdout(
      `Generated ${result.files.length} files in ${manifest.modules.outputDir} with @hey-api/openapi-ts ${manifest.generator.heyApi}\n` +
        `Wrote ${result.manifestPath} (${manifest.schemaHash})\n`,
    )
    for (const resource of manifest.resources) {
      const crud = Object.entries(resource.operations)
        .filter(([, operation]) => operation !== null)
        .map(([kind]) => kind)
      io.stdout(
        `  ${resource.name}: ${crud.length > 0 ? crud.join(', ') : 'no CRUD'}` +
          `${resource.customOperations.length > 0 ? `; ${resource.customOperations.length} custom` : ''}\n`,
      )
    }
    return 0
  } catch (error) {
    if (error instanceof ContractSyncError) {
      io.stderr(`error[${error.code}]: ${error.message}\n${error.hint ? `hint: ${error.hint}\n` : ''}`)
      return error.code === 'usage' ? 2 : 1
    }
    io.stderr(`error: ${describeError(error)}\n`)
    return 1
  }
}
