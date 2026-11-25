import { spawnSync } from 'node:child_process'

export function blueprintNextUnavailable() {
  for (const [executable, args, description] of [
    ['dotnet', ['--version'], 'the .NET SDK'],
    ['docker', ['info', '--format', '{{.ServerVersion}}'], 'a running Docker daemon'],
    ['aspire', ['--version'], 'the Aspire CLI'],
  ]) {
    if (spawnSync(executable, args, { stdio: 'ignore', timeout: 15_000 }).status !== 0) {
      return 'The generated Next AppHost test requires ' + description + '.'
    }
  }
  return ''
}
