import path from 'node:path'

import type { ManifestResource } from '@trivia/contract-sync'

/** Match the Refine resource key to the collection path (LLD-05). */
export function refineName(resource: ManifestResource): string {
  return resource.basePath?.split('/').filter(Boolean).at(-1)
    ?? resource.name.charAt(0).toLowerCase() + resource.name.slice(1) + 's'
}

export function handlerFile(page: string): string {
  return 'src/handlers/' + page + '.ts'
}

export function relativeModule(from: string, file: string): string {
  const specifier = path.posix.relative(path.posix.dirname(from), file).replace(/\.(?:tsx?|jsx?)$/, '')
  return specifier.startsWith('.') ? specifier : './' + specifier
}
