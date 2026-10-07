// @trivia/vite-plugin-ast-locator: the dev-time bridge between the user's Vite server and the
// Trivia engine. It stamps `data-ast-node` locators on every JSX opening element and serves
// the engine HTTP API at /@trivia/api (docs/api.md).

import fs from 'node:fs'

import type { Plugin } from 'vite'

import { createApiMiddleware } from './api.js'
import { type EngineBinding, loadEngine } from './engine.js'
import { type ProjectPaths, resolveProjectPaths } from './options.js'
import { JSX_ID, NODE_MODULES, VIRTUAL_ID, annotateModule, isSyntaxError, moduleFile } from './transform.js'

export { API_BASE } from './api.js'
export type * from './types.js'

export interface AstLocatorOptions {
  /**
   * Project-relative directory of the component library, read by the prop analyzer. Default:
   * components.json `aliases.ui` mapped through `resolve.alias` (`@/components/ui` →
   * `src/components/ui`), else `src/components/ui`.
   */
  uiDir?: string
  /** Import prefix of library components. Default: components.json `aliases.ui`, else `@/components/ui`. */
  importBase?: string
  /** Serve the engine HTTP API at /@trivia/api. Default: true. */
  api?: boolean
}

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }

export function astLocator(options: AstLocatorOptions = {}): Plugin {
  let engine: EngineBinding | undefined
  let paths: ProjectPaths | undefined
  let roots: string[] = []

  return {
    name: 'trivia:ast-locator',
    // Dev server only, and ahead of Vite's Oxc transform, which compiles JSX away (CLAUDE.md rule 6).
    apply: (_config, env) => env.command === 'serve' && env.isPreview !== true,
    enforce: 'pre',

    async configResolved(config) {
      engine = await loadEngine()
      // Vite resolves module ids through symlinks; the configured root may be one.
      roots = [...new Set([config.root, realpath(config.root)])]
      paths = resolveProjectPaths(config.root, config.resolve.alias, options)
      for (const warning of paths.warnings) config.logger.warn(`[trivia] ${warning}`)
    },

    transform: {
      filter: { id: { include: JSX_ID, exclude: [NODE_MODULES, VIRTUAL_ID] } },
      handler(code, id) {
        const file = moduleFile(id, roots)
        const binding = engine
        if (file === null || binding === undefined) return null
        try {
          return annotateModule(code, file, id.split('?', 1)[0] ?? id, (c, f) => binding.annotate(c, f))
        } catch (error) {
          // A syntax error leaves the module untouched, so Vite's own transform reports it
          // with a code frame. Anything else is an engine failure worth saying out loud.
          if (!isSyntaxError(error)) {
            this.warn(`no data-ast-node locators for ${file}: ${error instanceof Error ? error.message : String(error)}`)
          }
          return null
        }
      },
    },

    configureServer(server) {
      if (options.api === false) return
      if (engine === undefined || paths === undefined) throw new Error('[trivia] configureServer ran before configResolved')
      // Registered directly (not returned as a post hook), so it runs before Vite's own
      // transform and SPA-fallback middlewares.
      server.middlewares.use(
        createApiMiddleware({
          root: server.config.root,
          uiDir: paths.uiDir,
          importBase: paths.importBase,
          version: pkg.version,
          engine,
          logger: server.config.logger,
        }),
      )
    },
  }
}

export default astLocator

function realpath(dir: string): string {
  try {
    return fs.realpathSync(dir)
  } catch {
    return dir
  }
}
