// Playwright owns this process. The API and Vite use a fresh generated solution per run.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { blueprint, prepareMvp, startMvpApi } from './mvp-project.mjs'

const port = process.argv[2]
const root = mkdtempSync(path.join(tmpdir(), 'trivia-mvp-e2e-'))
let api
let vite
let stopping = false
function stop() {
  stopping = true
  vite?.kill('SIGTERM')
}
process.once('SIGTERM', stop)
process.once('SIGINT', stop)

try {
  const web = await prepareMvp(root)
  await blueprint(root, 'backend', '--migration', 'Initial')
  await blueprint(root, 'eject')
  if (!stopping) api = await startMvpApi(root)
  if (!stopping) {
    vite = spawn(process.execPath, [path.join(web, 'node_modules/vite/bin/vite.js'), '--port', port, '--strictPort'], {
      cwd: web, stdio: 'inherit', env: { ...process.env, API_URL: api.url },
    })
    const code = await new Promise((resolve, reject) => {
      vite.once('error', reject)
      vite.once('close', resolve)
    })
    if (!stopping && code !== 0) throw new Error(`MVP Vite server exited (${code}).`)
  }
} finally {
  try {
    await api?.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
