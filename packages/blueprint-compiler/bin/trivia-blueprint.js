#!/usr/bin/env node
import manifest from '../package.json' with { type: 'json' }

if (process.argv[2] === '--version' && process.argv.length === 3) {
  console.log(manifest.version)
} else {
  const { run } = await import('../dist/cli.js')
  process.exitCode = await run(process.argv.slice(2), manifest.version)
}
