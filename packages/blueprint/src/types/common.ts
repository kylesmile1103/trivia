// Patterns and small schemas shared by the documents and the ops (LLD-01 section 2).
// Every rule here is a regular expression, not a refinement, so the JSON Schemas generated
// from these zod schemas (schemas/*.v1.json) enforce exactly what zod enforces.
import { z } from 'zod'

import { ULID_SOURCE as ULID } from '../ids.js'

/** The format version this package reads and writes. Older documents are migrated (migrate/). */
export const BLUEPRINT_VERSION = 1

export const SCHEMA_URL = {
  app: 'https://trivia.dev/schemas/blueprint/app.v1.json',
  page: 'https://trivia.dev/schemas/blueprint/page.v1.json',
  model: 'https://trivia.dev/schemas/blueprint/model.v1.json',
} as const

export const PAGE_ID = new RegExp(`^pg_${ULID}$`)
export const NODE_ID = new RegExp(`^n_${ULID}$`)

/**
 * Words that cannot name a variable in emitted TypeScript. Names become identifiers there
 * (`const [selectedId, setSelectedId] = useState(…)`), so they must be usable as one.
 */
const RESERVED = [
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete',
  'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if',
  'implements', 'import', 'in', 'instanceof', 'interface', 'let', 'new', 'null', 'package',
  'private', 'protected', 'public', 'return', 'static', 'super', 'switch', 'this', 'throw', 'true',
  'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
]
/** Node, state, query and local names: camelCase identifiers (FR-BP-03). */
export const NAME = new RegExp(`^(?!(?:${RESERVED.join('|')})$)[a-z][A-Za-z0-9]*$`)
/** Page and app names: PascalCase, since they name files, components and projects. */
export const PAGE_NAME = /^[A-Z][A-Za-z0-9]*$/
/** A manifest type (PascalCase) or a lowercase HTML tag (LLD-02, FR-MF-06). */
export const NODE_TYPE = /^(?:[A-Z][A-Za-z0-9]*|[a-z][a-z0-9]*)$/
/** A slot of the parent's manifest. Checked against the manifest in layer 3. */
export const SLOT = /^[a-z][A-Za-z0-9]*$/
/**
 * A component prop: an identifier, or a hyphenated attribute such as `aria-label`. Never
 * `__proto__`, which a JavaScript object cannot hold as a plain key.
 */
export const PROP = /^(?!__proto__$)[A-Za-z_$][A-Za-z0-9_$]*(?:-[A-Za-z0-9_$]+)*$/
/** An event prop of a component: `onClick`, `onValueChange`. */
export const EVENT = /^on[A-Z][A-Za-z0-9]*$/
/** A key of `actions`: `<nodeId>.<event>`. */
export const ACTION_KEY = new RegExp(`^n_${ULID}\\.on[A-Z][A-Za-z0-9]*$`)
/** Contract resources, fields, operations and query parameters (trivia.manifest.json). */
export const CONTRACT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
/** A shadcn CSS variable name without its leading dashes: `primary`, `card-foreground`. */
export const TOKEN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
/** A lucide icon name: `users`, `circle-check`. */
export const ICON = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** An exported function of `src/handlers/<page>.ts` (the `call` step). */
export const HANDLER = /^[A-Za-z_$][A-Za-z0-9_$]*$/
/** An absolute route: literal segments or `:param`s, no trailing slash except `/` itself. */
export const ROUTE = /^\/(?:(?:[A-Za-z0-9._~-]+|:[a-z][A-Za-z0-9]*)(?:\/(?:[A-Za-z0-9._~-]+|:[a-z][A-Za-z0-9]*))*)?$/

/**
 * A fractional index key (FR-BP-08, order.ts): a head letter that fixes the length of the
 * integer part (`a` one digit up to `z` 26, `Z` one down to `A` 26), the base-62 integer, then
 * an optional fraction that never ends in '0'. The smallest integer alone is not a key, since
 * nothing could ever sort before it.
 */
export const ORDER_KEY = (() => {
  const digit = '[0-9A-Za-z]'
  const heads: string[] = []
  for (let i = 0; i < 26; i++) {
    heads.push(`${String.fromCharCode(97 + i)}${digit}{${i + 1}}`)
    heads.push(`${String.fromCharCode(65 + i)}${digit}{${26 - i}}`)
  }
  return new RegExp(`^(?!A0{26}$)(?:${heads.join('|')})(?:${digit}*[1-9A-Za-z])?$`)
})()

/** Marks a string as a binding expression (LLD-03) in zod and in the generated JSON Schema. */
export const EXPRESSION_META = 'x-trivia-expression'
export const expression = z.string().min(1).meta({ [EXPRESSION_META]: true })

/** Arbitrary JSON: static prop values and initial state. */
export const json = z.json()

export const pageName = z.string().regex(PAGE_NAME)
export const name = z.string().regex(NAME)
export const nodeId = z.string().regex(NODE_ID)
export const contractName = z.string().regex(CONTRACT_NAME)
