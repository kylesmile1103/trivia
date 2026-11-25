import MagicString, { type SourceMap } from 'magic-string'

import type { Insertion } from './engine.js'

export interface Annotated {
  code: string
  map: SourceMap
}

/**
 * Apply the engine's insertions for `file` (project-relative) to `code`. `source` names the
 * original in the source map. Returns `null` when there is no JSX to stamp; throws whatever
 * `annotate` throws (a syntax error, typically).
 */
export function annotateModule(
  code: string,
  file: string,
  source: string,
  annotate: (code: string, file: string) => Insertion[],
): Annotated | null {
  if (!code.includes('<')) return null
  const insertions = annotate(code, file)
  if (insertions.length === 0) return null
  const s = new MagicString(code)
  // Offsets are UTF-16 code units, the same unit as MagicString's string indices.
  for (const { offset, text } of insertions) s.appendLeft(offset, text)
  return {
    code: s.toString(),
    map: s.generateMap({ source, includeContent: true, hires: 'boundary' }),
  }
}

/** True for syntax diagnostics the app's bundler can report with its own code frame. */
export function isSyntaxError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('cannot parse ')
}
