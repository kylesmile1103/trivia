import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { expect, test } from '@playwright/test'

const viteUrl = new URL(`http://localhost:${process.env.TRIVIA_APP_PORT ?? 5173}/@trivia/mcp`)
// The launcher's printed URL uses its service port, independent of the Next app port.
const nextUrl = new URL(`http://127.0.0.1:${process.env.TRIVIA_NEXT_API_PORT ?? 4403}/@trivia/mcp`)

test('the Next launcher MCP endpoint serves the same tools as Vite', async () => {
  const vite = new Client({ name: 'vite-mcp-parity', version: '0' })
  const next = new Client({ name: 'next-mcp-parity', version: '0' })
  try {
    await vite.connect(new StreamableHTTPClientTransport(viteUrl) as never)
    await next.connect(new StreamableHTTPClientTransport(nextUrl) as never)
    const expected = (await vite.listTools()).tools
    expect(expected.map((tool) => tool.name)).toContain('trivia_list_routes')
    expect((await next.listTools()).tools).toEqual(expected)
    const result = await next.callTool({ name: 'trivia_list_routes' })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toMatchObject({
      routes: expect.arrayContaining([
        expect.objectContaining({ router: 'next-app-router', path: '/customers', file: 'app/(bank)/customers/page.tsx' }),
      ]),
    })
  } finally {
    await Promise.all([vite.close(), next.close()])
  }
})
