import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { parseArgs } from 'node:util'

import { loadEngine, parsePort, startDevService } from '@trivia/dev-service'

import { createNextHost } from './host.js'

export async function runLauncher(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      port: { type: 'string', short: 'p', default: process.env.PORT ?? '3000' },
      'service-port': { type: 'string', default: '0' },
      webpack: { type: 'boolean' },
      'ui-dir': { type: 'string' },
      'import-base': { type: 'string' },
    },
  })
  if (positionals.length !== 1 || positionals[0] !== 'dev') {
    throw new Error('Usage: trivia-next dev [--port PORT] [--service-port PORT] [--webpack]')
  }
  const port = parsePort(values.port, '--port')
  const servicePort = parsePort(values['service-port'], '--service-port')
  const root = fs.realpathSync(process.cwd())
  const next = createRequire(path.join(root, 'package.json')).resolve('next/dist/bin/next')
  const engine = await loadEngine()
  const host = createNextHost(root, engine, {
    ...(values['ui-dir'] ? { uiDir: values['ui-dir'] } : {}),
    ...(values['import-base'] ? { importBase: values['import-base'] } : {}),
  })
  const service = await startDevService(host, { port: servicePort, engine })
  try {
    const child = spawn(process.execPath, [next, 'dev', '--hostname', '127.0.0.1', '--port', String(port), ...(values.webpack ? ['--webpack'] : [])], {
      cwd: root,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
      stdio: 'inherit',
    })
    let stopping = false
    const stop = () => {
      stopping = true
      child.kill('SIGTERM')
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    try {
      console.log(`Trivia API: ${service.url}/@trivia/api`)
      console.log(`Trivia MCP: ${service.url}/@trivia/mcp`)
      const [code] = await once(child, 'exit') as [number | null, NodeJS.Signals | null]
      return code ?? (stopping ? 0 : 1)
    } finally {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
    }
  } finally {
    await service.close()
  }
}
