import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { syncContract } from '@trivia/contract-sync'

import type { CompileContext } from '../src/index.js'

export const mvp = new URL('../fixtures/next/mvp/', import.meta.url)
export const nextExample = new URL('../../../examples/next-admin/', import.meta.url)
export const dotnetAvailable = spawnSync('dotnet', ['--version'], { stdio: 'ignore' }).status === 0

export function prepareMvp(root: string, template = new URL('../templates/next-refine/', import.meta.url)) {
  const web = path.join(root, 'web')
  fs.cpSync(template, web, { recursive: true })
  fs.cpSync(new URL('blueprint/', mvp), path.join(web, 'blueprint'), { recursive: true })
  const app = path.join(web, 'blueprint/app.blueprint.json')
  fs.writeFileSync(app, fs.readFileSync(app, 'utf8').replace('"vite-refine"', '"next-refine"'))
  fs.renameSync(path.join(web, 'package.json.template'), path.join(web, 'package.json'))
  fs.renameSync(path.join(web, 'next.config.ts.template'), path.join(web, 'next.config.ts'))
  for (const dir of ['components', 'hooks', 'lib']) {
    fs.cpSync(new URL('src/' + dir, nextExample), path.join(web, 'src', dir), { recursive: true })
  }
  return web
}

export async function mvpContract(root: string, web: string) {
  const project = fileURLToPath(new URL('../../../dotnet/src/Trivia.Blueprint.Codegen/Trivia.Blueprint.Codegen.csproj', import.meta.url))
  execFileSync('dotnet', ['run', '--project', project, '--configuration', 'Release', '--disable-build-servers', '--',
    'write', '--blueprint', path.join(web, 'blueprint'), '--root', root], { cwd: root, timeout: 150_000, encoding: 'utf8' })
  execFileSync('dotnet', ['build', 'src/BankAdmin.Api/BankAdmin.Api.csproj', '-warnaserror', '--disable-build-servers'],
    { cwd: root, timeout: 150_000, encoding: 'utf8' })
  return syncContract({ cwd: web, input: 'openapi/api.openapi.json', zod: true })
}

export async function serviceContext(web: string): Promise<{ blueprint: import('@trivia/blueprint').Blueprint; context: CompileContext }> {
  const serviceModule = new URL('../../dev-service/dist/index.js', import.meta.url)
  const { EngineService, createStandaloneHost, loadEngine } = await import(serviceModule.href)
  const service = new EngineService({ engine: await loadEngine(), host: createStandaloneHost(web), version: 'test' })
  return service.blueprintInputs()
}
