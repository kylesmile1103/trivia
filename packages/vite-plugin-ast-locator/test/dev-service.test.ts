import { describe, expect, it } from 'vitest'

import { API_BASE, MCP_PATH, EngineService, createApiMiddleware, createMcpMiddleware } from '@trivia/dev-service'
import { API_BASE as VITE_API_BASE, MCP_PATH as VITE_MCP_PATH } from '../src/index.js'

describe('FR-TN-02 and FR-TN-07: shared dev service', () => {
  it('exports the Node handlers and preserves the Vite entry points', () => {
    expect(VITE_API_BASE).toBe(API_BASE)
    expect(VITE_MCP_PATH).toBe(MCP_PATH)
    expect(EngineService).toBeTypeOf('function')
    expect(createApiMiddleware).toBeTypeOf('function')
    expect(createMcpMiddleware).toBeTypeOf('function')
  })
})
