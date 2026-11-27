// A Refine page Trivia cannot read says why (GET /refine/unread, trivia_get_page's `unread`):
// on a copy of examples/refine-admin, one page file for each shape the adapter skips. Its own
// pages are all read, a file that imports Refine but calls neither hook says nothing, and a
// plain react-hook-form dialog is no Refine page.

import fs from 'node:fs'
import path from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { afterAll, beforeAll, expect, it } from 'vitest'

import { copyRefineAdmin, get, socketFetch, startServer, type TestServer } from './helpers.js'

let root: string
let server: TestServer

const TABLE = 'import { useTable } from "@refinedev/react-table"\n'
const FORM = 'import { useForm } from "@refinedev/react-hook-form"\n'
const PAGES: Record<string, string> = {
  'src/pages/orders/list.tsx': `${TABLE}import { columns } from "./columns"\n\nexport function OrderList() {\n  const table = useTable({ columns })\n  return <div>{table.getRowCount()}</div>\n}\n`,
  'src/pages/invoices/list.tsx': `${TABLE}import { getColumns } from "./columns"\n\nexport function InvoiceList() {\n  const table = useTable({ columns: getColumns("invoice") })\n  return <div>{table.getRowCount()}</div>\n}\n`,
  'src/pages/notes/list.tsx': `${TABLE}import { noteTable } from "./options"\n\nexport function NoteList() {\n  const table = useTable(noteTable)\n  return <div>{table.getRowCount()}</div>\n}\n`,
  'src/pages/notes/create.tsx': `${FORM}\nexport function NoteCreate() {\n  const { register } = useForm({ refineCoreProps: { resource: "notes" } })\n  return <input {...register("title")} />\n}\n`,
  'src/pages/tags/create.tsx': `${FORM}import { yupResolver } from "@hookform/resolvers/yup"\nimport { tagSchema } from "./schema"\n\nexport function TagCreate() {\n  const form = useForm({ resolver: yupResolver(tagSchema) })\n  return <form>{String(form.formState.isDirty)}</form>\n}\n`,
  'src/pages/tags/edit.tsx': `${FORM}import { zodResolver } from "@hookform/resolvers/zod"\nimport { z } from "zod"\n\nexport function TagEdit() {\n  const form = useForm({ resolver: zodResolver(z.object({ name: z.string() })) })\n  return <form>{String(form.formState.isDirty)}</form>\n}\n`,
  // Imports Refine, calls neither hook: nothing to say.
  'src/pages/tags/show.tsx': `${TABLE}\nexport function TagShow() {\n  return <div>tag</div>\n}\n`,
  // A list page's dialog with plain react-hook-form, no resolver: not a Refine form.
  'src/pages/tags/list.tsx': `${TABLE}import { useForm } from "react-hook-form"\n\nexport function TagFilter() {\n  const { register } = useForm()\n  return <input {...register("q")} />\n}\n`,
}

beforeAll(async () => {
  root = copyRefineAdmin()
  for (const [file, text] of Object.entries(PAGES)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), text)
  }
  server = await startServer(root)
})

afterAll(async () => {
  await server.close()
  fs.rmSync(root, { recursive: true, force: true })
})

type Unread = { file: string; component: string; hook: string; line: number; reason: string }
const unread = async (file?: string): Promise<Unread[]> => {
  const reply = await get(server.socket, '/refine/unread' + (file ? `?file=${encodeURIComponent(file)}` : ''))
  expect(reply.status, JSON.stringify(reply.body)).toBe(200)
  return reply.body.data
}

it('lists each page it cannot read, once, with the hook, the line and why', async () => {
  const all = await unread()
  expect(all.map((u) => [u.file, u.component, u.hook, u.line])).toEqual([
    ['src/pages/invoices/list.tsx', 'InvoiceList', 'useTable', 5],
    ['src/pages/notes/create.tsx', 'NoteCreate', 'useForm', 4],
    ['src/pages/notes/list.tsx', 'NoteList', 'useTable', 5],
    ['src/pages/orders/list.tsx', 'OrderList', 'useTable', 5],
    ['src/pages/tags/create.tsx', 'TagCreate', 'useForm', 6],
    ['src/pages/tags/edit.tsx', 'TagEdit', 'useForm', 6],
  ])
  const why = Object.fromEntries(all.map((u) => [u.component, u.reason]))
  expect(why.OrderList).toMatch(/^the columns come from `columns`, which is not declared in this file \(imported\?\); Trivia reads columns written as an array literal/)
  expect(why.InvoiceList).toMatch(/^the columns are `getColumns\("invoice"\)`; Trivia reads/)
  expect(why.NoteList).toMatch(/^useTable's options are `noteTable`, not an object literal written in the call/)
  expect(why.NoteCreate).toMatch(/^the form has no resolver \(a register\(\) form\?\); Trivia reads forms validated with zodResolver\(schema\)/)
  expect(why.TagCreate).toMatch(/^the resolver is `yupResolver\(tagSchema\)`; Trivia reads/)
  expect(why.TagEdit).toMatch(/^the schema is written inside `zodResolver\(z\.object\(\{ name: z\.string\(\) \}\)\)`; Trivia reads/)
})

it('says nothing about the pages it reads, and answers for one file', async () => {
  const read = (await get(server.socket, '/refine/pages')).body.data as Array<{ file: string }>
  const files = new Set(read.map((p) => p.file))
  expect(files.has('src/pages/customers/list.tsx')).toBe(true)
  expect((await unread()).some((u) => files.has(u.file))).toBe(false)
  expect(await unread('src/pages/customers/list.tsx')).toEqual([])
  expect((await unread('src/pages/orders/list.tsx')).map((u) => u.component)).toEqual(['OrderList'])
  expect(await unread('src/pages/tags/show.tsx')).toEqual([])
  expect(await unread('src/pages/tags/list.tsx')).toEqual([]) // plain react-hook-form
})

it('tells an agent too: trivia_get_page has the page it cannot read and why, instead of saying there is none', async () => {
  const client = new Client({ name: 'refine-unread-test', version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost/@trivia/mcp'), { fetch: socketFetch(server.socket) }) as unknown as Transport)
  try {
    const r = (await client.callTool({ name: 'trivia_get_page', arguments: { file: 'src/pages/orders/list.tsx' } })) as {
      isError?: boolean; content: Array<{ text?: string }>; structuredContent?: any
    }
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy()
    expect(r.structuredContent.pages).toEqual([])
    expect(r.structuredContent.unread).toEqual([expect.objectContaining({ component: 'OrderList', hook: 'useTable', line: 5 })])
    expect(r.structuredContent).not.toHaveProperty('hint')
    expect(r.content[0]?.text).toContain('OrderList (src/pages/orders/list.tsx:5), useTable not read: the columns come from `columns`')
  } finally {
    await client.close()
  }
})
