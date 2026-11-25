// @trivia/vite-plugin-ast-locator: the dev-time bridge between the user's Vite server and the
// Trivia engine. It stamps `data-ast-node` locators on every JSX opening element and serves
// the engine HTTP API at /@trivia/api (docs/api.md).

import fs from 'node:fs'
import path from 'node:path'

import type { Plugin } from 'vite'

import {
  type EngineBinding, EngineService, PREVIEW_PREFIX, createDevMiddleware, loadEngine,
} from '@trivia/dev-service'
import { annotateModule, isSyntaxError } from '@trivia/dev-service/stamp'

import { createViteHost } from './host.js'
import { type ProjectPaths, resolveProjectPaths } from './options.js'
import { JSX_ID, NODE_MODULES, VIRTUAL_ID, moduleFile } from './transform.js'

export { API_BASE, MCP_PATH } from '@trivia/dev-service'
export type * from '@trivia/dev-service'

export interface AstLocatorOptions {
  /**
   * Project-relative directory of the component library, read by the prop analyzer. Default:
   * components.json `aliases.ui` mapped through `resolve.alias` (`@/components/ui` →
   * `src/components/ui`), else `src/components/ui`.
   */
  uiDir?: string
  /** Import prefix of library components. Default: components.json `aliases.ui`, else `@/components/ui`. */
  importBase?: string
  /** Serve the engine HTTP API at /@trivia/api, and the MCP endpoint at /@trivia/mcp. Default: true. */
  api?: boolean
  /** Serve the MCP endpoint for agents at /@trivia/mcp (docs/mcp.md). Default: true (with `api`). */
  mcp?: boolean
  /** How long trivia_screenshot waits for an open designer to take the screenshot (ms). Default 15 000. */
  screenshotTimeoutMs?: number
  /**
   * **Dangerous.** Let clients on other machines call the engine API. It rewrites source files,
   * so with `vite --host` (or Docker, or `server.host`) anyone who can reach the dev server
   * could then edit your code. Default: false, the API answers loopback clients only. The
   * Host and Origin checks apply either way.
   */
  allowRemote?: boolean
}

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }

export function astLocator(options: AstLocatorOptions = {}): Plugin {
  let engine: EngineBinding | undefined
  let paths: ProjectPaths | undefined
  let roots: string[] = []
  let service: EngineService | undefined
  // The inferencer's previews (docs/product.md, slice 6) are modules at `/@trivia/preview/<id>.tsx`
  // that never exist on disk. They resolve to a path in the project's src/ (so the project's
  // aliases, JSX transform and React refresh apply to them like to its own files) and their
  // code comes from the Refine adapter.
  let previewDir = ''
  /** The same directory as a URL from the root (`/src/.trivia-preview/`): how Vite writes imports between previews. */
  let previewUrl = ''
  const isPreview = (id: string) => previewDir !== '' && id.split('?', 1)[0]!.startsWith(previewDir)

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
      previewDir = path.join(config.root, 'src', '.trivia-preview') + path.sep
      previewUrl = '/src/.trivia-preview/'
    },

    resolveId(id) {
      if (service === undefined) return null
      if (id.startsWith(PREVIEW_PREFIX)) return path.join(previewDir, id.slice(PREVIEW_PREFIX.length).split('?', 1)[0]!)
      if (id.startsWith(previewUrl)) return path.join(previewDir, id.slice(previewUrl.length).split('?', 1)[0]!)
      // Vite resolves a module's own id again (its HMR self-accept): it is still a preview.
      return isPreview(id) ? id : null
    },

    async load(id) {
      if (service === undefined || !isPreview(id)) return null
      const file = id.split('?', 1)[0]!
      if (file.endsWith('.css')) return (await service.refine.previewStyles(path.basename(file, '.css'))) ?? ''
      const name = path.basename(file, '.tsx')
      const code = await service.refine.previewModule(name)
      return code ?? `throw new Error(${JSON.stringify(`no Trivia preview ${name}: the dev server restarted since it was asked for; reload the page`)});\n`
    },

    transform: {
      filter: { id: { include: JSX_ID, exclude: [NODE_MODULES, VIRTUAL_ID] } },
      handler(code, id) {
        // A preview's elements belong to no file yet: there is nothing to select and edit.
        if (isPreview(id)) return null
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
      const allowRemote = options.allowRemote === true
      if (allowRemote) {
        server.config.logger.warn(
          '[trivia] allowRemote: the engine API at /@trivia/api answers every client that can reach this server, and it rewrites source files',
        )
      }
      // Registered directly (not returned as a post hook), so it runs before Vite's own
      // transform and SPA-fallback middlewares.
      const host = createViteHost(server, paths)
      service = new EngineService({
        host,
        version: pkg.version,
        engine,
        ...(options.screenshotTimeoutMs !== undefined ? { screenshotTimeoutMs: options.screenshotTimeoutMs } : {}),
      })
      server.middlewares.use(createDevMiddleware(host, { service, logger: server.config.logger, allowRemote, mcp: options.mcp !== false }))
      // A sync rewrites the manifest: previews generated from the old one are stale.
      const manifestFile = path.join(server.config.root, 'trivia.manifest.json')
      server.watcher.on('change', (file) => {
        if (path.resolve(file) !== manifestFile) return
        const graph = server.environments.client.moduleGraph
        let stale = false
        for (const mod of graph.idToModuleMap.values()) {
          if (mod.id !== null && isPreview(mod.id)) {
            graph.invalidateModule(mod)
            stale = true
          }
        }
        if (stale) server.environments.client.hot.send({ type: 'full-reload' })
      })
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
