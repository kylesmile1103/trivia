#!/usr/bin/env node

import { parseArgs } from 'node:util'

import { createStandaloneHost, parsePort, startDevService } from '../dist/standalone.js'

try {
  const { values } = parseArgs({
    options: {
      root: { type: 'string', default: process.cwd() },
      port: { type: 'string', default: '0' },
      'ui-dir': { type: 'string' },
      'import-base': { type: 'string' },
    },
  })
  const host = createStandaloneHost(values.root, { uiDir: values['ui-dir'], importBase: values['import-base'] })
  const service = await startDevService(host, { port: parsePort(values.port, '--port') })
  console.log(`Trivia API: ${service.url}/@trivia/api`)
  console.log(`Trivia MCP: ${service.url}/@trivia/mcp`)
  const stop = () => {
    service.close().catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
} catch (error) {
  console.error(`[trivia] ${error.message}`)
  process.exitCode = 1
}
