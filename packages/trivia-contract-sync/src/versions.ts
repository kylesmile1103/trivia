import fs from 'node:fs'
import { createRequire } from 'node:module'

import { ContractSyncError } from './errors.js'

const require = createRequire(import.meta.url)

function readVersion(file: string | URL, label: string): string {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: unknown }
    if (typeof parsed.version === 'string' && parsed.version.length > 0) return parsed.version
  } catch (cause) {
    throw new ContractSyncError('environment', `Cannot read the ${label} version from ${String(file)}`, { cause })
  }
  throw new ContractSyncError('environment', `${String(file)} has no "version" field`)
}

/** Version of this package (works from src/ under vitest and from dist/ when installed). */
export function contractSyncVersion(): string {
  return readVersion(new URL('../package.json', import.meta.url), '@trivia/contract-sync')
}

/** Version of the @hey-api/openapi-ts that is actually installed and will run. */
export function heyApiVersion(): string {
  return readVersion(require.resolve('@hey-api/openapi-ts/package.json'), '@hey-api/openapi-ts')
}
