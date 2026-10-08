// The MCP endpoint at /@trivia/mcp (docs/mcp.md): Streamable HTTP, stateless, JSON responses.
// Each POST gets a fresh server and transport (no sessions, nothing to clean up between
// requests), behind the same caller guard as the engine API.

import fs from 'node:fs'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

import { type CallerRules, checkCaller } from '../api/guard.js'
import type { Middleware } from '../api/http.js'
import type { EngineService } from '../api/service.js'
import { ApiError } from '../engine.js'
import { registerTools } from './tools.js'

export const MCP_PATH = '/@trivia/mcp'

export interface McpOptions extends CallerRules {
  service: EngineService
  logger?: { error(message: string): void }
}

const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }

const INSTRUCTIONS =
  'Trivia edits the user\'s React source byte for byte while their app runs in the Trivia designer. When the user ' +
  'refers to "this" or "the selected" element, call trivia_get_selection, then change it with trivia_apply using the ' +
  'locator and tag name it returns. The designer shows each edit at once and can undo it.'

export function createMcpMiddleware(options: McpOptions): Middleware {
  const log = (message: string) => options.logger?.error(message)

  return (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== MCP_PATH) {
      next()
      return
    }
    try {
      checkCaller(req, options)
    } catch (error) {
      reply(res, 403, error instanceof ApiError ? error.message : 'forbidden')
      return
    }
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      reply(res, 405, `${MCP_PATH} takes POST (a stateless server has no event stream to GET)`)
      return
    }
    void serve(req, res, options.service, log)
  }
}

async function serve(req: Parameters<Middleware>[0], res: Parameters<Middleware>[1], service: EngineService, log: (m: string) => void) {
  const server = new McpServer({ name: 'trivia', version: pkg.version }, { instructions: INSTRUCTIONS })
  registerTools(server, service, log)
  // No sessionIdGenerator: stateless (the SDK's documented `sessionIdGenerator: undefined`, which
  // exactOptionalPropertyTypes will not let us spell).
  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true })
  res.on('close', () => {
    void transport.close()
    void server.close()
  })
  try {
    // The SDK's optional properties are typed without exactOptionalPropertyTypes in mind.
    await server.connect(transport as unknown as Transport)
    await transport.handleRequest(req, res)
  } catch (error) {
    log(`[trivia] MCP request failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
    if (!res.headersSent) reply(res, 500, 'internal error')
  }
}

/** A JSON-RPC error outside any request (the transport never saw it). */
function reply(res: Parameters<Middleware>[1], status: number, message: string): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }))
}
