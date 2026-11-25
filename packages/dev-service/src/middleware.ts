import { createApiMiddleware, type ApiOptions, type Middleware } from './api/http.js'
import type { DevHost } from './host.js'
import { createMcpMiddleware } from './mcp/server.js'

export function createDevMiddleware(host: DevHost, options: Omit<ApiOptions, 'allowedHosts'> & { mcp?: boolean }): Middleware {
  const rules = { ...options, allowedHosts: host.allowedHosts }
  const api = createApiMiddleware(rules)
  const mcp = options.mcp === false ? null : createMcpMiddleware(rules)
  if (!mcp) return api
  return (req, res, next) => api(req, res, (error) => {
    if (error) next(error)
    else mcp(req, res, next)
  })
}
