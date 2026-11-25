#!/usr/bin/env node
import manifest from '../package.json' with { type: 'json' }

if (process.argv[2] === '--version' && process.argv.length === 3) {
  console.log(manifest.version)
} else {
  console.error('Usage: trivia-blueprint --version')
  process.exitCode = 2
}
