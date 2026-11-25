import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import { createServer } from 'node:net'
import { createInterface } from 'node:readline'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { prepareMvp, nextExample } from '../packages/blueprint-compiler/test/next-fixture.ts'

const workspace = fileURLToPath(new URL('../', import.meta.url))
const bin = path.join(workspace, 'packages/blueprint-compiler/bin/trivia-blueprint.js')
const cache = path.join(workspace, '.nx')
fs.mkdirSync(cache, { recursive: true })
const root = fs.mkdtempSync(path.join(cache, 'blueprint-next-app-'))
const env = { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', NEXT_TELEMETRY_DISABLED: '1' }
const appPort = process.env.TRIVIA_BLUEPRINT_NEXT_APP_PORT ?? '5486'
const apiPort = process.env.TRIVIA_BLUEPRINT_NEXT_API_PORT ?? '4586'

function run(executable, args, cwd = root, stdout = 'inherit') {
  execFileSync(executable, args, { cwd, env, stdio: ['ignore', stdout, 'inherit'], timeout: 180_000 })
}

async function configureLaunch(appHost) {
  const profileFile = path.join(root, path.dirname(appHost), 'Properties/launchSettings.json')
  const profile = JSON.parse(fs.readFileSync(profileFile, 'utf8'))
  const servers = Array.from({ length: 3 }, () => createServer())
  try {
    await Promise.all(servers.map((server) => once(server.listen(0, '127.0.0.1'), 'listening')))
    const [dashboard, telemetry, resources] = servers.map((server) => 'http://127.0.0.1:' + server.address().port)
    const http = profile.profiles.http
    http.applicationUrl = dashboard
    http.launchBrowser = false
    http.environmentVariables.ASPIRE_DASHBOARD_OTLP_ENDPOINT_URL = telemetry
    http.environmentVariables.ASPIRE_RESOURCE_SERVICE_ENDPOINT_URL = resources
    fs.writeFileSync(profileFile, JSON.stringify(profile, null, 2) + '\n')
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))))
  }
}

try {
  const web = prepareMvp(root)
  fs.symlinkSync(fileURLToPath(new URL('node_modules', nextExample)), path.join(web, 'node_modules'), 'junction')
  const blueprint = path.join(web, 'blueprint')
  const scope = ['--blueprint', blueprint, '--root', root]
  run('trivia-dotnet', ['write', ...scope], root, 'ignore')
  run('trivia-dotnet', ['migrate', 'Initial', ...scope], root, 'ignore')
  run('dotnet', ['build', 'BankAdmin.slnx', '--disable-build-servers'])
  run('pnpm', ['exec', 'trivia-contract-sync', '--input', 'openapi/api.openapi.json', '--zod'], web)
  run(process.execPath, [bin, 'eject'], web, 'ignore')

  const appHost = 'src/BankAdmin.AppHost/BankAdmin.AppHost.csproj'
  await configureLaunch(appHost)
  const hosted = spawn('aspire', ['run', '--no-build', '--non-interactive', '--apphost', appHost, '--',
    '--Trivia:WebPort=' + appPort, '--Trivia:ApiPort=' + apiPort, '--Trivia:InstallWebDependencies=false',
    '--Trivia:UseDataVolume=false'], { cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'] })
  createInterface({ input: hosted.stdout }).on('line', (line) => console.log(line.replace(/(\/login\?t=)\S+/g, '$1[redacted]')))
  let stopping = false
  const stop = () => {
    stopping = true
    hosted.kill('SIGTERM')
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  const [exit] = await once(hosted, 'exit')
  process.exitCode = stopping ? 0 : exit ?? 1
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
