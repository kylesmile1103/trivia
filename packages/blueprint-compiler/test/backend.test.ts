import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { MODEL_DOC, revOfText } from '@trivia/blueprint'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { run } from '../src/cli.js'

let root: string
let web: string
let log: string
let fake: string
const model = fs.readFileSync(new URL('../../blueprint/fixtures/model/valid/bank/model.blueprint.json', import.meta.url), 'utf8')

beforeEach(async () => {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trivia-backend-')))
  root = path.join(parent, 'Bank Office')
  log = path.join(parent, 'steps.jsonl')
  fake = path.join(parent, 'fake.cjs')

  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(process, 'cwd').mockReturnValue(parent)

  fs.writeFileSync(fake, `
    const fs = require('node:fs')
    const path = require('node:path')
    const { createHash } = require('node:crypto')
    const [file, fail, name, ...args] = process.argv.slice(2)
    fs.appendFileSync(file, JSON.stringify({ name, args, cwd: process.cwd() }) + '\\n')
    if (args[0] === fail) {
      console.log('step output')
      console.error('step error')
      process.exitCode = 17
    } else if (name === 'trivia-dotnet') {
      const source = fs.readFileSync(path.join(args[args.indexOf('--blueprint') + 1], '${MODEL_DOC}'))
      console.log(JSON.stringify({ modelRev: 'sha256:' + createHash('sha256').update(source).digest('hex'), diagnostics: [] }))
    }
  `)
  expect(await run(['new', root, '--api', 'dotnet-minimal'], 'test')).toBe(0)
  web = path.join(root, 'web')
  fs.writeFileSync(path.join(web, 'blueprint', MODEL_DOC), model)
  expect(JSON.parse(fs.readFileSync(path.join(web, 'blueprint/app.blueprint.json'), 'utf8')).targets.api).toBe('dotnet-minimal')
  vi.mocked(process.cwd).mockReturnValue(root)
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(path.dirname(root), { recursive: true, force: true })
})

function executables(fail = '') {
  const command = (name: string) => ({ executable: process.execPath, prefix: [fake, log, fail, name] })
  return { 'trivia-dotnet': command('trivia-dotnet'), dotnet: command('dotnet'), pnpm: command('pnpm') }
}

function steps() {
  return fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
}

it('FR-AS-08 writes, migrates, builds and syncs in order, then prints drift', async () => {
  expect(await run(['backend', '--migration', 'AddNotes'], 'test', executables())).toBe(0)
  const args = ['--blueprint', path.join(web, 'blueprint'), '--root', root]
  expect(steps()).toEqual([
    { name: 'trivia-dotnet', args: ['write', ...args], cwd: root },
    { name: 'trivia-dotnet', args: ['migrate', 'AddNotes', ...args], cwd: root },
    { name: 'dotnet', args: ['build', 'BankOffice.slnx', '--disable-build-servers'], cwd: root },
    { name: 'pnpm', args: ['run', 'sync'], cwd: web },
  ])
  expect(console.log).toHaveBeenCalledWith('No contract drift.')
})

it('can run from the web directory and omits the migration when no name was passed', async () => {
  vi.mocked(process.cwd).mockReturnValue(web)
  expect(await run(['backend'], 'test', executables())).toBe(0)
  expect(steps().map(({ args }) => args[0])).toEqual(['write', 'build', 'run'])
})

it.each([
  ['write', ['write']],
  ['migrate', ['write', 'migrate']],
  ['build', ['write', 'migrate', 'build']],
  ['run', ['write', 'migrate', 'build', 'run']],
])('stops after failing %s and reports that step’s output', async (fail, order) => {
  expect(await run(['backend', '--migration', 'AddNotes'], 'test', executables(fail))).toBe(1)
  expect(steps().map(({ args }) => args[0])).toEqual(order)
  const output = vi.mocked(console.error).mock.calls.flat().join('\n')
  expect(output).toContain('step output')
  expect(output).toContain('step error')
  expect(output).toContain('17')
  expect(console.log).not.toHaveBeenCalledWith('No contract drift.')
})


it('records the generated model in the existing lock after sync', async () => {
  const file = path.join(web, 'blueprint/blueprint.lock.json')
  const pages = { Customers: { file: 'src/pages/customers/list.tsx', hash: 'sha256:' + 'a'.repeat(64) } }
  fs.writeFileSync(file, JSON.stringify({ lockVersion: 1, compiler: 'older', pages }))
  expect(await run(['backend'], 'test', executables())).toBe(0)
  const lock = JSON.parse(fs.readFileSync(file, 'utf8'))
  expect(lock).toMatchObject({
    lockVersion: 1, compiler: 'older', pages,
    model: {
      rev: revOfText(model),
      entities: { Customer: {
        email: { type: 'string', required: true, hasDefault: false },
        status: { type: 'enum', required: true, hasDefault: true, enumValues: ['pending', 'active', 'suspended'] },
      } },
    },
  })
})

it('keeps the existing lock when sync fails', async () => {
  const file = path.join(web, 'blueprint/blueprint.lock.json')
  const original = '{"lockVersion":1,"pages":{}}\n'
  fs.writeFileSync(file, original)
  expect(await run(['backend'], 'test', executables('run'))).toBe(1)
  expect(fs.readFileSync(file, 'utf8')).toBe(original)
})
