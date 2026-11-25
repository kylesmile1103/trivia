export interface PrintStyle {
  semicolons: boolean
  quotes: 'single' | 'double'
}

export interface ProjectFacts {
  target: 'vite-refine' | 'next-refine'
  aliases: Readonly<Record<string, string>>
  pagesDir: string
  /** The physical route directory for a Next draft preview. */
  previewDirectory?: string
  style: PrintStyle
  formStyle: 'Field' | 'FormField'
  installed: ReadonlySet<string>
}

export interface FactInputs {
  target?: ProjectFacts['target']
  aliases?: ProjectFacts['aliases']
  pagesDir?: string
  entrySource?: string
  formStyle?: ProjectFacts['formStyle']
  installed?: Iterable<string>
}

const trimSlash = (value: string) => value.replace(/\/+$/, '')

export function projectFacts(input: FactInputs = {}): ProjectFacts {
  const aliases = Object.fromEntries(Object.entries(input.aliases ?? {}).map(([key, value]) => [key, trimSlash(value)]))
  aliases.components ??= '@/components'
  aliases.ui ??= `${aliases.components}/ui`
  return {
    target: input.target ?? 'vite-refine',
    aliases,
    pagesDir: trimSlash(input.pagesDir ?? (input.target === 'next-refine' ? 'app/(app)' : 'src/pages')),
    style: importStyle(input.entrySource ?? ''),
    formStyle: input.formStyle ?? 'Field',
    installed: new Set(input.installed),
  }
}

function importStyle(source: string): PrintStyle {
  // Static imports, including multiline named clauses and side-effect imports. Other lines may
  // contain JSX, comments or strings whose delimiters are unrelated to the module's style.
  const imports = [...source.matchAll(/^[\t ]*import(?:\s+[^"'();]*?\bfrom)?\s*(["'])(?:\\.|[^\\\r\n])*?\1[\t ]*(;?)[\t ]*(?=\/\/|$)/gm)]
  return {
    quotes: imports.filter((match) => match[1] === "'").length > imports.length / 2 ? 'single' : 'double',
    semicolons: imports.filter((match) => match[2] === ';').length >= imports.length / 2,
  }
}
