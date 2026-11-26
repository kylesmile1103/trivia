import fs from 'node:fs'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { copyPlayground, from, get, post, request, startServer, type TestServer } from './helpers.js'

const DASHBOARD = 'src/pages/Dashboard.tsx'
const CANCEL = `${DASHBOARD}#Dashboard#0.0.2.0`
const SAVE = `${DASHBOARD}#Dashboard#0.0.2.1`
const APP_MAIN = 'src/App.tsx#App#0'
/** The plugin's own version: a release bumps it, so tests read it rather than repeat it. */
const VERSION = (JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version

const setProp = (target: string, prop: string, value: unknown, expectedName = 'Button') => ({
  op: 'updateProp',
  target,
  expectedName,
  prop,
  value,
})

let root: string
let server: TestServer
let socket: string
let original: string

const read = (file = DASHBOARD) => fs.readFileSync(path.join(root, file), 'utf8')
const write = (text: string, file = DASHBOARD) => fs.writeFileSync(path.join(root, file), text)

beforeEach(async () => {
  root = copyPlayground()
  server = await startServer(root)
  socket = server.socket
  original = read()
})

afterEach(async () => {
  await server.close()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('read endpoints', () => {
  it('health reports the project paths', async () => {
    const r = await get(socket, '/health')
    expect(r.status).toBe(200)
    expect(r.body).toEqual({
      ok: true,
      data: { root: fs.realpathSync(root), uiDir: 'src/components/ui', importBase: '@/components/ui', version: VERSION },
    })
  })

  it('components returns a schema list', async () => {
    const r = await get(socket, '/components')
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(Array.isArray(r.body.data)).toBe(true)
  })

  it('inspect describes a node', async () => {
    const r = await get(socket, `/inspect?locator=${encodeURIComponent(SAVE)}`)
    expect(r.status).toBe(200)
    expect(r.body.data).toMatchObject({ locator: SAVE, file: DASHBOARD, name: 'Button', text: 'Save changes' })
  })

  it('inspect maps engine errors to HTTP statuses', async () => {
    const missing = await get(socket, '/inspect')
    expect([missing.status, missing.body.error.code]).toEqual([400, 'invalid_locator'])
    const garbage = await get(socket, '/inspect?locator=nonsense')
    expect([garbage.status, garbage.body.error.code]).toEqual([400, 'invalid_locator'])
    const absent = await get(socket, `/inspect?locator=${encodeURIComponent(`${DASHBOARD}#Dashboard#0.9`)}`)
    expect([absent.status, absent.body.error.code]).toEqual([404, 'node_not_found'])
    const outside = await get(socket, `/inspect?locator=${encodeURIComponent('../escape.tsx#A#0')}`)
    expect([outside.status, outside.body.error.code]).toEqual([422, 'path_outside_root'])
  })

  it('outline lists a file\'s JSX trees with locators', async () => {
    const r = await get(socket, `/outline?file=${encodeURIComponent(DASHBOARD)}`)
    expect(r.status).toBe(200)
    const [root] = r.body.data
    expect(root).toMatchObject({ locator: `${DASHBOARD}#Dashboard#0`, name: 'div' })
    const footer = root.children[0].children[2]
    expect(footer).toMatchObject({ name: 'CardFooter', children: [{ locator: CANCEL, name: 'Button', text: 'Cancel' }, { locator: SAVE, text: 'Save changes' }] })
    const missing = await get(socket, '/outline')
    expect([missing.status, missing.body.error.code]).toEqual([400, 'invalid_op'])
    const outside = await get(socket, `/outline?file=${encodeURIComponent('../etc/passwd.tsx')}`)
    expect([outside.status, outside.body.error.code]).toEqual([422, 'path_outside_root'])
  })

  it('history starts empty', async () => {
    const r = await get(socket, '/history')
    expect(r.body.data).toEqual({ canUndo: false, canRedo: false, undoLabel: null, redoLabel: null, lastWriteAt: null })
  })
})

describe('apply, undo, redo', () => {
  it('updateProp changes exactly that attribute, and undo restores the file byte for byte', async () => {
    const r = await post(socket, '/apply', { op: setProp(SAVE, 'variant', 'outline'), label: 'Save: outline' })
    expect(r.status).toBe(200)
    expect(r.body.data).toEqual({
      file: DASHBOARD,
      changed: true,
      locator: SAVE,
      history: { canUndo: true, canRedo: false, undoLabel: 'Save: outline', redoLabel: null, lastWriteAt: expect.any(Number) },
    })
    const edited = read()
    expect(edited).toBe(original.replace('<Button>Save changes', '<Button variant="outline">Save changes'))

    const undo = await post(socket, '/undo')
    expect(undo.status).toBe(200)
    expect(undo.body.data).toEqual({
      files: [DASHBOARD],
      history: { canUndo: false, canRedo: true, undoLabel: null, redoLabel: 'Save: outline', lastWriteAt: expect.any(Number) },
    })
    expect(read()).toBe(original)

    const redo = await post(socket, '/redo')
    expect(redo.body.data.history).toEqual({ canUndo: true, canRedo: false, undoLabel: 'Save: outline', redoLabel: null, lastWriteAt: expect.any(Number) })
    expect(read()).toBe(edited)
  })

  it('an unchanged result creates no history entry', async () => {
    const r = await post(socket, '/apply', { op: setProp(CANCEL, 'variant', 'ghost') })
    expect(r.body.data.changed).toBe(false)
    expect(r.body.data.history.canUndo).toBe(false)
    expect(read()).toBe(original)
  })

  it('a new entry clears the redo stack; labels default from the op', async () => {
    await post(socket, '/apply', { op: setProp(SAVE, 'variant', 'outline') })
    await post(socket, '/undo')
    const r = await post(socket, '/apply', { op: setProp(SAVE, 'size', 'lg') })
    expect(r.body.data.history).toEqual({ canUndo: true, canRedo: false, undoLabel: 'Set size', redoLabel: null, lastWriteAt: expect.any(Number) })
  })

  it('undo and redo with nothing to do change nothing', async () => {
    const undo = await post(socket, '/undo')
    expect(undo.body.data).toEqual({
      files: [],
      history: { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null, lastWriteAt: null },
    })
    expect((await post(socket, '/redo')).body.data.files).toEqual([])
    expect(read()).toBe(original)
  })

  it('undo refuses to overwrite a file edited outside the designer', async () => {
    await post(socket, '/apply', { op: setProp(SAVE, 'variant', 'outline'), label: 'outline' })
    const external = `${read()}// edited in the IDE\n`
    write(external)
    const undo = await post(socket, '/undo')
    expect(undo.status).toBe(409)
    expect(undo.body.error.code).toBe('conflict')
    expect(undo.body.error.message).toContain('undo "outline" failed')
    expect(read()).toBe(external)
    expect((await get(socket, '/history')).body.data).toEqual({
      canUndo: true,
      canRedo: false,
      undoLabel: 'outline',
      redoLabel: null,
      lastWriteAt: expect.any(Number), // the apply's: the refused undo wrote nothing
    })
  })

  it('redo refuses the same way', async () => {
    await post(socket, '/apply', { op: setProp(SAVE, 'variant', 'outline') })
    await post(socket, '/undo')
    write(`${original}// edited in the IDE\n`)
    const redo = await post(socket, '/redo')
    expect([redo.status, redo.body.error.code]).toEqual([409, 'conflict'])
    expect((await get(socket, '/history')).body.data.canRedo).toBe(true)
  })

  it('maps engine failures: stale locator 409, outside root 422', async () => {
    const stale = await post(socket, '/apply', { op: setProp(SAVE, 'variant', 'outline', 'Input') })
    expect([stale.status, stale.body.error.code]).toEqual([409, 'stale_locator'])
    const outside = await post(socket, '/apply', { op: setProp('../escape.tsx#A#0', 'x', 1, 'A') })
    expect([outside.status, outside.body.error.code]).toEqual([422, 'path_outside_root'])
    const invalid = await post(socket, '/apply', { op: { op: 'explode', target: SAVE } })
    expect([invalid.status, invalid.body.error.code]).toEqual([400, 'invalid_op'])
    expect(read()).toBe(original)
  })

  it('serializes concurrent edits: none is lost and each is one undo step', async () => {
    const edits = [
      setProp(SAVE, 'variant', 'outline'),
      setProp(SAVE, 'size', 'lg'),
      setProp(CANCEL, 'size', 'sm'),
      setProp(CANCEL, 'disabled', true),
      setProp(`${DASHBOARD}#Dashboard#0.0.1.0.1`, 'placeholder', 'name', 'Input'),
    ]
    const replies = await Promise.all(edits.map((op) => post(socket, '/apply', { op })))
    expect(replies.map((r) => r.status)).toEqual([200, 200, 200, 200, 200])
    const edited = read()
    for (const text of ['variant="outline"', 'size="lg"', 'size="sm"', 'disabled={true}', 'placeholder="name"']) {
      expect(edited).toContain(text)
    }
    for (let i = 0; i < edits.length; i++) expect((await post(socket, '/undo')).status).toBe(200)
    expect(read()).toBe(original)
    expect((await get(socket, '/history')).body.data.canUndo).toBe(false)
  })
})

describe('a move between files', () => {
  it('writes both files as one undo entry, and undo restores both byte for byte', async () => {
    const app = read('src/App.tsx')
    const r = await post(socket, '/apply', {
      op: { op: 'move', source: SAVE, expectedName: 'Button', target: 'src/App.tsx#App#0.0', expectedTargetName: 'Dashboard', placement: 'after' },
    })
    expect(r.status).toBe(200)
    expect(r.body.data).toMatchObject({ file: 'src/App.tsx', changed: true, locator: 'src/App.tsx#App#0.1', history: { undoLabel: 'Move <Button>' } })
    expect(read('src/App.tsx')).toContain('      <Dashboard />\n      <Button>Save changes</Button>\n    </main>')
    expect(read('src/App.tsx')).toContain('import { Button } from "@/components/ui/button"')
    expect(read()).toBe(original.replace('          <Button>Save changes</Button>\n', ''))

    await post(socket, '/undo')
    expect(read()).toBe(original)
    expect(read('src/App.tsx')).toBe(app)
  })
})

describe('createFile', () => {
  const FORM = 'src/components/forms/customer-form.tsx'
  const form = 'export function CustomerForm() {\n  return <form />\n}\n'
  const exists = () => fs.existsSync(path.join(root, FORM))

  it('creates a file and uses it in one undo entry; undo deletes it, redo brings it back', async () => {
    const r = await post(socket, '/batch', {
      label: 'Add a form',
      ops: [
        { op: 'createFile', file: FORM, content: form },
        { op: 'insert', target: CANCEL, expectedName: 'Button', placement: 'before', snippet: '<CustomerForm />', imports: [{ name: 'CustomerForm', source: '@/components/forms/customer-form' }] },
      ],
    })
    expect(r.status).toBe(200)
    expect(read(FORM)).toBe(form)
    expect(read()).toContain('import { CustomerForm } from "@/components/forms/customer-form"')

    await post(socket, '/undo')
    expect(exists()).toBe(false)
    expect(read()).toBe(original)
    await post(socket, '/redo')
    expect(read(FORM)).toBe(form)
    expect(read()).toContain('<CustomerForm />')
  })

  it('never overwrites a file, and refuses code that does not parse', async () => {
    const taken = await post(socket, '/apply', { op: { op: 'createFile', file: DASHBOARD, content: form } })
    expect([taken.status, taken.body.error.code]).toEqual([409, 'conflict'])
    expect(read()).toBe(original)
    const broken = await post(socket, '/apply', { op: { op: 'createFile', file: FORM, content: 'export const A = () => <form>' } })
    expect([broken.status, broken.body.error.code]).toEqual([422, 'invalid_result'])
    expect(exists()).toBe(false)
  })

  it('with ifMissing, keeps a file that exists (a no-op) and creates one that doesn\'t', async () => {
    fs.mkdirSync(path.join(root, path.dirname(FORM)), { recursive: true })
    write(`${form}// mine\n`, FORM)
    const kept = await post(socket, '/apply', { op: { op: 'createFile', file: FORM, content: form, ifMissing: true } })
    expect([kept.status, kept.body.data.changed]).toEqual([200, false])
    expect(read(FORM)).toBe(`${form}// mine\n`)
    fs.rmSync(path.join(root, FORM))
    const made = await post(socket, '/apply', { op: { op: 'createFile', file: FORM, content: form, ifMissing: true } })
    expect(made.body.data.changed).toBe(true)
    expect(read(FORM)).toBe(form)
  })

  it('undo leaves a created file the user has edited since', async () => {
    await post(socket, '/apply', { op: { op: 'createFile', file: FORM, content: form } })
    write(`${form}// mine\n`, FORM)
    const r = await post(socket, '/undo')
    expect([r.status, r.body.error.code]).toEqual([409, 'conflict'])
    expect(read(FORM)).toBe(`${form}// mine\n`)
  })
})

describe('batch', () => {
  it('is one history entry, even across files', async () => {
    const appBefore = read('src/App.tsx')
    const r = await post(socket, '/batch', {
      ops: [
        setProp(SAVE, 'variant', 'outline'),
        setProp(CANCEL, 'variant', 'destructive'),
        setProp(APP_MAIN, 'className', 'p-4', 'main'),
      ],
      label: 'Restyle',
    })
    expect(r.status).toBe(200)
    expect(r.body.data).toEqual({
      file: 'src/App.tsx',
      changed: true,
      locator: APP_MAIN,
      history: { canUndo: true, canRedo: false, undoLabel: 'Restyle', redoLabel: null, lastWriteAt: expect.any(Number) },
    })
    expect(read()).toContain('<Button variant="outline">Save changes')
    expect(read()).toContain('<Button variant="destructive">Cancel')
    expect(read('src/App.tsx')).toContain('className="p-4"')

    const undo = await post(socket, '/undo')
    expect(undo.body.data.files).toEqual([DASHBOARD, 'src/App.tsx'])
    expect(read()).toBe(original)
    expect(read('src/App.tsx')).toBe(appBefore)
  })

  it('rolls back when an op fails: nothing is written and no entry is recorded', async () => {
    const appBefore = read('src/App.tsx')
    const r = await post(socket, '/batch', {
      ops: [setProp(APP_MAIN, 'className', 'p-4', 'main'), setProp(SAVE, 'size', 'lg'), setProp(CANCEL, 'variant', 'x', 'Div')],
    })
    expect(r.status).toBe(409)
    expect(r.body.error.code).toBe('stale_locator')
    expect(r.body.error.message).toMatch(/^op 3 of 3: /)
    expect(read()).toBe(original)
    expect(read('src/App.tsx')).toBe(appBefore)
    expect((await get(socket, '/history')).body.data.canUndo).toBe(false)
  })

  it('a multi-file undo is all-or-nothing', async () => {
    await post(socket, '/batch', { ops: [setProp(SAVE, 'variant', 'outline'), setProp(APP_MAIN, 'className', 'p-4', 'main')] })
    const dashboardEdited = read()
    const appExternal = `${read('src/App.tsx')}// edited in the IDE\n`
    write(appExternal, 'src/App.tsx')
    const undo = await post(socket, '/undo')
    expect([undo.status, undo.body.error.code]).toEqual([409, 'conflict'])
    expect(read()).toBe(dashboardEdited)
    expect(read('src/App.tsx')).toBe(appExternal)
  })

  it('needs a non-empty array of ops', async () => {
    for (const body of [{ ops: [] }, { ops: 'x' }, { ops: [1] }, {}]) {
      const r = await post(socket, '/batch', body)
      expect([r.status, r.body.error.code]).toEqual([400, 'invalid_op'])
    }
  })
})

describe('request rules', () => {
  it('refuses foreign origins with 403 forbidden', async () => {
    for (const origin of ['http://evil.example', 'https://localhost.evil.example', 'null', 'file://']) {
      const r = await get(socket, '/health', { origin })
      expect([r.status, r.body.error?.code], origin).toEqual([403, 'forbidden'])
    }
    for (const origin of ['http://evil.example', 'null']) {
      const write = await post(socket, '/apply', { op: setProp(SAVE, 'variant', 'outline') }, { origin })
      expect([write.status, write.body.error.code], origin).toEqual([403, 'forbidden'])
    }
    expect(read()).toBe(original)
  })

  it('accepts localhost origins', async () => {
    for (const origin of ['http://localhost:4400', 'http://127.0.0.1:5301', 'http://[::1]:5173', 'https://localhost']) {
      expect((await get(socket, '/health', { origin })).status, origin).toBe(200)
    }
  })

  it('requires POST with content-type: application/json for changes', async () => {
    const body = JSON.stringify({ op: setProp(SAVE, 'variant', 'outline') })
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      const r = await post(socket, '/apply', body, { 'content-type': type })
      expect([r.status, r.body.error.code], type).toEqual([400, 'invalid_op'])
    }
    const charset = await post(socket, '/apply', body, { 'content-type': 'application/json; charset=utf-8' })
    expect(charset.status).toBe(200)
    await post(socket, '/undo')

    const viaGet = await get(socket, '/apply')
    expect([viaGet.status, viaGet.body.error.code]).toEqual([400, 'invalid_op'])
    const postHealth = await post(socket, '/health')
    expect([postHealth.status, postHealth.body.error.code]).toEqual([400, 'invalid_op'])
    expect(read()).toBe(original)
  })

  it('rejects malformed bodies and unknown endpoints', async () => {
    for (const body of ['{', '[]', '"op"', '']) {
      const r = await post(socket, '/apply', body)
      expect([r.status, r.body.error.code], JSON.stringify(body)).toEqual([400, 'invalid_op'])
    }
    const label = await post(socket, '/apply', { op: setProp(SAVE, 'variant', 'outline'), label: 3 })
    expect([label.status, label.body.error.code]).toEqual([400, 'invalid_op'])
    const unknown = await get(socket, '/nope')
    expect([unknown.status, unknown.body.error.code]).toEqual([400, 'invalid_op'])
    expect(read()).toBe(original)
  })

  it('leaves other paths to Vite', async () => {
    const r = await request(socket, '/@trivia/apiary')
    expect(r.body?.ok).toBeUndefined()
  })
})

describe('manifest', () => {
  it('serves trivia.manifest.json, current with its spec', async () => {
    const r = await get(socket, '/manifest')
    expect(r.status).toBe(200)
    const { manifest, drift } = r.body.data
    expect(manifest.resources.map((resource: { name: string }) => resource.name)).toEqual(['Customer', 'Health'])
    expect(drift).toEqual({ status: 'current', source: 'openapi/customers.openapi.json', manifestHash: manifest.schemaHash, specHash: manifest.schemaHash })
  })

  it('says when the spec changed since the code was generated (drift)', async () => {
    const file = 'openapi/customers.openapi.json'
    const spec = JSON.parse(read(file)) as { info: { version: string } }
    spec.info.version = '9.9.9'
    write(`${JSON.stringify(spec, null, 2)}\n`, file)
    const { drift } = (await get(socket, '/manifest')).body.data
    expect(drift.status).toBe('changed')
    expect(drift.specHash).not.toBe(drift.manifestHash)
    // Reformatting alone is no drift: the hash is of the canonical JSON.
    write(JSON.stringify({ ...spec, info: { ...spec.info, version: '1.4.0' } }), file)
    expect((await get(socket, '/manifest')).body.data.drift.status).toBe('current')
  })

  it('is null without a manifest, and drift is unknown when the spec is gone', async () => {
    fs.rmSync(path.join(root, 'openapi/customers.openapi.json'))
    expect((await get(socket, '/manifest')).body.data.drift).toMatchObject({ status: 'unknown', specHash: null })
    fs.rmSync(path.join(root, 'trivia.manifest.json'))
    expect((await get(socket, '/manifest')).body.data).toEqual({ manifest: null, drift: null })
  })
})

describe('selection', () => {
  it('starts empty, and keeps what the designer last posted', async () => {
    expect((await get(socket, '/selection')).body.data).toEqual({ selection: null, version: 0, by: null })
    const r = await post(socket, '/selection', { locator: SAVE, name: 'Button' })
    expect(r.status).toBe(200)
    expect(r.body.data).toEqual({ selection: { locator: SAVE, name: 'Button' }, version: 1, by: 'designer' })
    expect((await get(socket, '/selection')).body.data).toEqual(r.body.data)
    const cleared = await post(socket, '/selection', { locator: null })
    expect(cleared.body.data).toEqual({ selection: null, version: 2, by: 'designer' })
  })

  it('needs a locator string and its tag name, or null', async () => {
    for (const body of [{}, { locator: 3 }, { locator: SAVE }, { locator: SAVE, name: '' }]) {
      const r = await post(socket, '/selection', body)
      expect([r.status, r.body.error?.code], JSON.stringify(body)).toEqual([400, 'invalid_op'])
    }
    const garbage = await post(socket, '/selection', { locator: 'nope', name: 'Button' })
    expect([garbage.status, garbage.body.error?.code]).toEqual([400, 'invalid_locator'])
    expect((await get(socket, '/selection')).body.data.version).toBe(0)
  })

  it('is not moved by the designer’s own edits: the designer posts its selection itself', async () => {
    await post(socket, '/selection', { locator: CANCEL, name: 'Button' })
    await post(socket, '/apply', { op: { op: 'remove', target: CANCEL, expectedName: 'Button' } })
    expect((await get(socket, '/selection')).body.data).toMatchObject({ selection: { locator: CANCEL }, version: 1 })
  })
})

describe('only this machine may call the API', () => {
  const LAN = '192.168.1.66'
  // Script in a text node: written to source, it runs in the user's browser.
  const attack = { op: 'insert', target: APP_MAIN, placement: 'lastChild', snippet: '<p>{(() => "pwned")()}</p>' }
  const READS = ['/health', '/components', `/inspect?locator=${encodeURIComponent(SAVE)}`, '/history', '/selection', '/nope']
  const WRITES: [string, unknown][] = [
    ['/apply', { op: attack }],
    ['/batch', { ops: [attack] }],
    ['/undo', {}],
    ['/redo', {}],
    ['/selection', { locator: null }],
  ]

  it('refuses a write from another machine that sends no Origin (vite --host)', async () => {
    const appBefore = read('src/App.tsx')
    // A LAN peer addresses the server by its IP, which Vite's own host check lets through.
    const r = await post(socket, '/apply', { op: attack }, from(LAN, { host: '192.168.1.10:5173' }))
    expect([r.status, r.body.error?.code]).toEqual([403, 'forbidden'])
    expect(r.body.error.message).toContain(`refusing a request from ${LAN}`)
    expect(r.body.error.message).toContain('allowRemote')
    expect(read('src/App.tsx')).toBe(appBefore)
  })

  it('refuses every endpoint to any non-loopback address', async () => {
    await post(socket, '/apply', { op: setProp(SAVE, 'variant', 'outline') }) // something to undo
    const edited = read()
    for (const address of [LAN, '::ffff:192.168.1.66', '10.0.0.2', '0.0.0.0', 'fe80::1', '::', '2001:db8::1']) {
      for (const endpoint of READS) {
        const r = await get(socket, endpoint, from(address))
        expect([r.status, r.body.error?.code], `${address} GET ${endpoint}`).toEqual([403, 'forbidden'])
      }
      for (const [endpoint, body] of WRITES) {
        const r = await post(socket, endpoint, body, from(address))
        expect([r.status, r.body.error?.code], `${address} POST ${endpoint}`).toEqual([403, 'forbidden'])
      }
    }
    expect(read()).toBe(edited)
    expect((await get(socket, '/history')).body.data.undoLabel).toBe('Set variant')
  })

  it('refuses a client whose address is unknown (a Unix socket, a closed connection)', async () => {
    const r = await get(socket, '/health', from('none'))
    expect([r.status, r.body.error?.code]).toEqual([403, 'forbidden'])
    expect(r.body.error.message).toContain('unknown address')
  })

  it('answers loopback clients: 127.0.0.0/8, ::1, IPv4-mapped 127.x', async () => {
    for (const address of ['127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1']) {
      expect((await get(socket, '/health', from(address))).status, address).toBe(200)
    }
  })

  it('allowRemote: true serves other machines (the dangerous opt-in)', async () => {
    const open = await startServer(root, { allowRemote: true })
    try {
      expect((await get(open.socket, '/health', from(LAN))).status).toBe(200)
      const r = await post(open.socket, '/apply', { op: setProp(SAVE, 'variant', 'outline') }, from(LAN))
      expect([r.status, r.body.data?.changed]).toEqual([200, true])
      // The Origin rule still applies to remote browsers.
      const page = await get(open.socket, '/health', from(LAN, { origin: 'http://192.168.1.66:8000' }))
      expect([page.status, page.body.error?.code]).toEqual([403, 'forbidden'])
    } finally {
      await open.close()
    }
  })
})

describe('only hosts that name this machine (DNS rebinding)', () => {
  // A rebinding page is served from its own name, so the Host header names the attacker's
  // domain; a same-origin GET carries no Origin.
  const FOREIGN = ['evil.example', 'evil.example:5173', 'localhost.evil.example', 'localhost.', 'x@localhost', '[::1']

  it('refuses a foreign Host even where Vite does not check it (server.https)', async () => {
    const tls = await startServer(root, {}, { https: {} })
    try {
      for (const host of FOREIGN) {
        const r = await get(tls.socket, '/components', { host })
        expect([r.status, r.body.error?.code], JSON.stringify(host)).toEqual([403, 'forbidden'])
      }
      // (Without any Host, Node itself answers an HTTP/1.1 request with 400.)
      const empty = await request(tls.socket, '/@trivia/api/components', { headers: { host: '' }, setHost: false })
      expect([empty.status, empty.body.error?.code]).toEqual([403, 'forbidden'])
      expect(empty.body.error.message).toContain('host (none)')
      const write = await post(tls.socket, '/apply', { op: setProp(SAVE, 'variant', 'outline') }, { host: 'evil.example:5173' })
      expect([write.status, write.body.error?.code]).toEqual([403, 'forbidden'])
      expect(write.body.error.message).toContain('host evil.example:5173')
      expect(read()).toBe(original)
    } finally {
      await tls.close()
    }
  })

  it('accepts localhost and IP literals', async () => {
    for (const host of ['localhost', 'localhost:5173', '127.0.0.1:5173', '[::1]:5173', '192.168.1.10:5173']) {
      expect((await get(socket, '/health', { host })).status, host).toBe(200)
    }
  })

  it('accepts *.localhost, as Vite does (the name resolves to loopback, so it cannot be rebound)', async () => {
    const tls = await startServer(root, {}, { https: {} }) // the plugin's check alone
    try {
      for (const server of [socket, tls.socket]) {
        for (const host of ['app.localhost', 'app.localhost:5173', 'a.b.localhost:5173']) {
          const r = await get(server, '/health', { host })
          expect([r.status, r.body.error?.message], host).toEqual([200, undefined])
        }
      }
      // A name that only starts or ends like localhost is still foreign.
      for (const host of ['localhost.evil.example', 'evillocalhost', 'localhost.', 'app.localhost.evil.example:5173']) {
        expect((await get(tls.socket, '/health', { host })).status, host).toBe(403)
      }
    } finally {
      await tls.close()
    }
  })

  it("accepts Vite's resolved server.allowedHosts", async () => {
    const named = await startServer(root, {}, { allowedHosts: ['dev.example', '.corp.example'], https: {} })
    try {
      for (const host of ['dev.example', 'dev.example:5173', 'corp.example', 'a.corp.example:5173']) {
        expect((await get(named.socket, '/health', { host })).status, host).toBe(200)
      }
      expect((await get(named.socket, '/health', { host: 'evil.example' })).status).toBe(403)
    } finally {
      await named.close()
    }
    const any = await startServer(root, {}, { allowedHosts: true })
    try {
      expect((await get(any.socket, '/health', { host: 'evil.example' })).status).toBe(200)
    } finally {
      await any.close()
    }
  })
})

describe('api: false', () => {
  it('does not mount the API', async () => {
    const off = await startServer(root, { api: false })
    try {
      const r = await request(off.socket, '/@trivia/api/health')
      expect(r.status).toBe(404)
      expect(r.body?.ok).toBeUndefined()
    } finally {
      await off.close()
    }
  })
})
