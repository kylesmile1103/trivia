#!/usr/bin/env node

import { runLauncher } from '../dist/launcher.js'

try {
  process.exitCode = await runLauncher(process.argv.slice(2))
} catch (error) {
  console.error(`[trivia] ${error.message}`)
  process.exitCode = 1
}
