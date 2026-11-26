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

import { BLUEPRINT_ENTRY, BLUEPRINT_ROUTE, blueprintEntry } from './blueprint-entry.js'
import { createViteHost, invalidatePreviews } from './host.js'
import { type ProjectPaths, resolveProjectPaths } from './options.js'
import { JSX_ID, NODE_MODULES, VIRTUAL_ID, moduleFile, relativeToRoots } from './transform.js'
import { replayDroppedChanges } from './watch.js'

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
  /** Directory under the project root for blueprint documents. Default: blueprint. */
  blueprintDir?: string
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
  let stopReplay: (() => void) | undefined
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

    async resolveId(id, importer) {
      if (service === undefined) return null
      if (id.startsWith(PREVIEW_PREFIX)) return path.join(previewDir, id.slice(PREVIEW_PREFIX.length).split('?', 1)[0]!)
      if (id.startsWith(previewUrl)) return path.join(previewDir, id.slice(previewUrl.length).split('?', 1)[0]!)
      if (importer && isPreview(importer) && id.startsWith('.')) {
        const name = path.basename(importer.split('?', 1)[0]!, '.tsx')
        const page = await service.refine.previewSource(name)
        if (page && paths) {
          const origin = path.resolve(roots[0]!, page.file)
          const resolved = await this.resolve(id, origin, { skipSelf: true })
          if (resolved) return resolved
          const file = path.relative(roots[0]!, path.resolve(path.dirname(origin), id)).split(path.sep).join('/')
          if (page.handler && (file === page.handler.file || file + '.ts' === page.handler.file)) {
            return path.join(previewDir, name + '.handler.ts')
          }
        }
      }
      // Vite resolves a module's own id again (its HMR self-accept): it is still a preview.
      return isPreview(id) ? id : null
    },

    async load(id) {
      if (service === undefined || !isPreview(id)) return null
      const file = id.split('?', 1)[0]!
      if (file.endsWith('.css')) return (await service.refine.previewStyles(path.basename(file, '.css'))) ?? ''
      if (path.basename(file) === BLUEPRINT_ENTRY) return blueprintEntry
      if (file.endsWith('.handler.ts')) return (await service.refine.previewSource(path.basename(file, '.handler.ts')))?.handler?.code
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
          const insertions = binding.annotate(code, file)
          const stamp = () => annotateModule(code, file, id.split('?', 1)[0] ?? id, () => insertions)
          if (!service || !code.includes('<Refine') || !code.includes('<Routes')) return stamp()
          return service.refine.blueprintRouteAnchor(file).then((anchor) => {
            const location = anchor && insertions.find((item) => item.text.includes('"' + anchor.target + '"'))
            if (location) {
              const offset = code.lastIndexOf('<', location.offset)
              insertions.push({ offset, text: '<Route path="' + BLUEPRINT_ROUTE + '" element={<__TriviaBlueprintRoute />} />\n' })
              insertions.push({
                offset: 0, text: 'import { TriviaBlueprintRoute as __TriviaBlueprintRoute } from "'
                  + PREVIEW_PREFIX + BLUEPRINT_ENTRY + '";\n',
              })
            }
            return stamp()
          }, () => stamp())
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
        blueprintDir: paths.blueprintDir,
        version: pkg.version,
        engine,
        ...(options.screenshotTimeoutMs !== undefined ? { screenshotTimeoutMs: options.screenshotTimeoutMs } : {}),
      })
      server.middlewares.use(createDevMiddleware(host, { service, logger: server.config.logger, allowRemote, mcp: options.mcp !== false }))
      // The canvas must show what is on disk: replay a change the watcher dropped (watch.ts).
      stopReplay?.()
      stopReplay = replayDroppedChanges(server.watcher, roots)
      // A sync rewrites the manifest: previews generated from the old one are stale.
      const manifestFile = path.join(server.config.root, 'trivia.manifest.json')
      const blueprintDir = path.join(server.config.root, paths.blueprintDir) + path.sep
      server.watcher.on('all', (event, file) => {
        if (!['add', 'change', 'unlink'].includes(event)) return
        const changed = path.resolve(file)
        if (changed === manifestFile) invalidatePreviews(server, false)
        else if (changed.startsWith(blueprintDir)) invalidatePreviews(server, true)
      })
    },

    // Vite reloads the page when an updated file has a module that nothing imports (a dead end
    // of its update propagation). A stylesheet's dependency on a file stays in the graph as an
    // `asset` node after the stylesheet dropped it: Tailwind's plugin makes its stylesheet depend
    // on every file it scans, so after an undo deleted an ejected page (or the lock), the next
    // eject reloaded the canvas, though nothing reads that node. Such nodes are left out (before
    // the other plugins' hooks, Tailwind's among them); Vite updates the rest, and sends nothing
    // for an empty list. A dependency a stylesheet still has keeps its CSS update.
    hotUpdate: {
      order: 'pre',
      handler({ file, modules }) {
        if (service === undefined || NODE_MODULES.test(file) || relativeToRoots(path.resolve(file), roots) === null) return
        const consumed = modules.filter((mod) => mod.type !== 'asset' || mod.importers.size > 0)
        return consumed.length === modules.length ? undefined : consumed
      },
    },

    closeServer({ reason }) {
      // A restart configures the new server before it closes the old one. With plugins passed
      // inline, one instance serves both: `stopReplay` is the new server's by now, and
      // configureServer stopped the old one. A plugin instance of its own (from a config file)
      // stops with the old watcher, whose close removes its listener (watch.ts).
      if (reason === 'restart') return
      stopReplay?.()
      stopReplay = undefined
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
