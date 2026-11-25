import { once } from 'node:events'
import fs from 'node:fs'
import { createServer, type Server } from 'node:http'

import { EngineService } from './api/service.js'
import { ApiError, type EngineBinding, loadEngine } from './engine.js'
import type { DevHost } from './host.js'
import { createDevMiddleware } from './middleware.js'
import { discoverRoutes, fileResolver } from './routes/index.js'

const LOOPBACK = '127.0.0.1'
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }

export interface RunningDevService {
  server: Server
  url: string
  close(): Promise<void>
}

export async function startDevService(host: DevHost, options: {
  port?: number
  engine?: EngineBinding
  logger?: { error(message: string): void }
} = {}): Promise<RunningDevService> {
  const service = new EngineService({ host, engine: options.engine ?? await loadEngine(), version: pkg.version })
  const middleware = createDevMiddleware(host, { service, logger: options.logger ?? console })
  const server = createServer((req, res) => {
    if (!URL.canParse(req.url ?? '/', 'http://localhost')) {
      res.writeHead(400).end()
      return
    }
    middleware(req, res, (error) => res.writeHead(error ? 500 : 404).end())
  })
  await once(server.listen(options.port ?? 0, LOOPBACK), 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('[trivia] no TCP address for the dev service')

  let closing: Promise<void> | undefined
  return {
    server,
    url: `http://${LOOPBACK}:${address.port}`,
    close() {
      return closing ??= new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
        // Release a designer's in-flight screenshot long poll, too.
        server.closeAllConnections()
      }).finally(() => host.preview.close?.())
    },
  }
}

/** The CLI without a custom app host can read source and Vite-style routes. */
export function createStandaloneHost(root: string, paths: { uiDir?: string; importBase?: string } = {}): DevHost {
  root = fs.realpathSync(root)
  const resolveModule = fileResolver(root)
  return {
    root,
    kind: 'vite',
    uiDir: paths.uiDir ?? 'src/components/ui',
    importBase: paths.importBase ?? '@/components/ui',
    resolveModule,
    readRoutes: (source) => discoverRoutes({ ...source, root, resolve: resolveModule }),
    preview: {
      publish() {
        throw new ApiError('unsupported', 'a running app host is required to compile preview modules')
      },
    },
    allowedHosts: [],
  }
}

/** A zero port asks the OS for an unused port. */
export function parsePort(value: string, option: string): number {
  if (!/^\d+$/.test(value) || Number(value) > 65535) throw new Error(`${option} must be a port from 0 to 65535`)
  return Number(value)
}
