// A stand-in back-office API for this example: openapi/bank.openapi.json, in memory, served by
// the example's own Vite server (so the designer's proxy reaches it too). It resets when the dev
// server restarts, and its seed is fixed so tests can rely on it. Not part of Trivia: a real app
// has a real API.
//
// Lists take ?page&pageSize&sort&order&q and filters: `field=value` (a comma list means any of
// them), `field_like=text`, `field_gte=` and `field_lte=`. They answer { items, total }.

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Plugin } from 'vite'

type Row = Record<string, unknown> & { id: string }

interface Resource {
  rows: Row[]
  /** Fields a POST may set, with defaults for the rest of the entity. */
  create?: { fields: string[]; required: string[]; defaults: () => Record<string, unknown> }
  /** Fields a PUT may change. */
  update?: string[]
  remove?: boolean
}

const BASE = '/api/v1'

/** A stable UUID-shaped id: the seed must be the same on every start. */
const uuid = (kind: number, n: number) => `00000000-0000-4000-8000-${String(kind).padStart(4, '0')}${String(n).padStart(8, '0')}`
const day = (d: number) => new Date(Date.UTC(2026, 0, d)).toISOString()

function seed(): Record<string, Resource> {
  const people: Array<[string, string, string, string, string, number]> = [
    ['Ada Lovelace', 'ada@example.com', 'active', 'approved', 'private', 50000],
    ['Grace Hopper', 'grace@example.com', 'active', 'approved', 'retail', 7500],
    ['Alan Turing', 'alan@example.com', 'pending', 'in_review', 'retail', 2000],
    ['Katherine Johnson', 'katherine@example.com', 'active', 'not_started', 'business', 120000],
    ['Edsger Dijkstra', 'edsger@example.com', 'suspended', 'rejected', 'retail', 0],
    ['Barbara Liskov', 'barbara@example.com', 'active', 'approved', 'private', 80000],
    ['Donald Knuth', 'donald@example.com', 'active', 'approved', 'retail', 3000],
    ['Margaret Hamilton', 'margaret@example.com', 'pending', 'in_review', 'business', 25000],
  ]
  const customers: Row[] = people.map(([fullName, email, status, kycStatus, segment, creditLimit], i) => ({
    id: uuid(1, i + 1),
    fullName,
    email,
    phone: i % 3 === 0 ? null : `+44 20 7946 ${String(1000 + i * 37).slice(0, 4)}`,
    status,
    kycStatus,
    segment,
    creditLimit,
    birthDate: i % 4 === 3 ? null : `19${50 + i * 5}-0${(i % 9) + 1}-1${i}`,
    createdAt: day(i + 1),
  }))
  const currencies = ['EUR', 'USD', 'GBP']
  const accounts: Row[] = customers.flatMap((c, i) =>
    (i % 2 === 0 ? ['checking', 'savings'] : ['checking']).map((type, j) => ({
      id: uuid(2, i * 2 + j + 1),
      customerId: c.id,
      iban: `GB${String(29 + i).padStart(2, '0')}NWBK6016133192${String(i * 2 + j).padStart(4, '0')}`,
      type,
      currency: currencies[(i + j) % 3],
      balance: Math.round(((i + 1) * 1234.5 + j * 980) * 100) / 100,
      overdraftLimit: type === 'checking' ? 500 : 0,
      status: c.status === 'suspended' ? 'frozen' : 'open',
      openedAt: day(i + 2).slice(0, 10),
    })),
  )
  const counterparties = ['Acme Ltd', 'Payroll', 'Coffee Corner', 'City Rent', 'Tax Office', 'Bookshop']
  const transactions: Row[] = accounts.flatMap((a, i) =>
    [0, 1, 2].map((k) => ({
      id: uuid(3, i * 3 + k + 1),
      accountId: a.id,
      amount: Math.round((25 + ((i * 7 + k * 13) % 40) * 31.7) * 100) / 100,
      currency: a.currency,
      direction: k === 1 ? 'credit' : 'debit',
      status: (i + k) % 7 === 0 ? 'pending' : (i + k) % 11 === 0 ? 'reversed' : 'booked',
      counterparty: counterparties[(i + k) % counterparties.length],
      reference: k === 2 ? null : `REF-${1000 + i * 3 + k}`,
      bookedAt: new Date(Date.UTC(2026, 8, 1 + ((i + k) % 28), 9 + k)).toISOString(),
    })),
  )
  let next = 100
  return {
    customers: {
      rows: customers,
      create: {
        fields: ['fullName', 'email', 'phone', 'segment', 'creditLimit', 'birthDate'],
        required: ['fullName', 'email', 'segment'],
        defaults: () => ({ id: uuid(1, ++next), status: 'pending', kycStatus: 'not_started', createdAt: new Date().toISOString() }),
      },
      update: ['fullName', 'email', 'phone', 'status', 'segment', 'creditLimit', 'birthDate'],
      remove: true,
    },
    accounts: {
      rows: accounts,
      create: {
        fields: ['customerId', 'type', 'currency', 'overdraftLimit'],
        required: ['customerId', 'type', 'currency'],
        defaults: () => ({ id: uuid(2, ++next), iban: `GB00TRIV${String(next).padStart(14, '0')}`, balance: 0, status: 'open', openedAt: new Date().toISOString().slice(0, 10) }),
      },
      update: ['status', 'overdraftLimit'],
    },
    transactions: { rows: transactions },
  }
}

function list(rows: Row[], params: URLSearchParams): { items: Row[]; total: number } {
  const reserved = new Set(['page', 'pageSize', 'sort', 'order', 'q'])
  let out = rows
  const q = params.get('q')?.toLowerCase()
  if (q) out = out.filter((r) => Object.values(r).some((v) => typeof v === 'string' && v.toLowerCase().includes(q)))
  for (const [key, value] of params) {
    if (reserved.has(key) || value === '') continue
    const [field, op] = key.endsWith('_like') ? [key.slice(0, -5), 'like'] : key.endsWith('_gte') ? [key.slice(0, -4), 'gte'] : key.endsWith('_lte') ? [key.slice(0, -4), 'lte'] : [key, 'eq']
    out = out.filter((r) => {
      const v = r[field!]
      if (op === 'like') return String(v ?? '').toLowerCase().includes(value.toLowerCase())
      if (op === 'gte') return typeof v === 'number' ? v >= Number(value) : String(v) >= value
      if (op === 'lte') return typeof v === 'number' ? v <= Number(value) : String(v) <= value
      return value.split(',').includes(String(v))
    })
  }
  const sort = params.get('sort')
  if (sort) {
    const dir = params.get('order') === 'desc' ? -1 : 1
    out = [...out].sort((a, b) => {
      const x = a[sort]
      const y = b[sort]
      if (x === y) return 0
      if (x === null || x === undefined) return 1
      if (y === null || y === undefined) return -1
      return (x < y ? -1 : 1) * dir
    })
  }
  const page = Math.max(1, Number(params.get('page') ?? 1) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(params.get('pageSize') ?? 20) || 20))
  return { items: out.slice((page - 1) * pageSize, page * pageSize), total: out.length }
}

export function mockApi(): Plugin {
  const db = seed()

  const send = (res: ServerResponse, status: number, body?: unknown) => {
    res.statusCode = status
    if (body === undefined) return res.end()
    res.setHeader('content-type', status >= 400 ? 'application/problem+json' : 'application/json')
    res.end(JSON.stringify(body))
  }
  const problem = (res: ServerResponse, status: number, title: string, detail?: string) =>
    send(res, status, { title, status, ...(detail ? { detail } : {}) })
  const read = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = []
    for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk)
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown
      return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }

  return {
    name: 'refine-admin:mock-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (!url.pathname.startsWith(`${BASE}/`)) return next()
        const [, name, id, extra] = url.pathname.slice(BASE.length).split('/')
        const resource = name ? db[name] : undefined
        if (!resource || extra !== undefined) return problem(res, 404, `No route for ${req.method} ${url.pathname}`)

        if (id === undefined) {
          if (req.method === 'GET') return send(res, 200, list(resource.rows, url.searchParams))
          if (req.method === 'POST' && resource.create) {
            const input = await read(req)
            const missing = resource.create.required.filter((f) => input[f] === undefined || input[f] === '')
            if (missing.length) return problem(res, 422, `Invalid ${name}`, `${missing.join(', ')} required`)
            const row: Row = { ...(resource.create.defaults() as Row) }
            for (const f of resource.create.fields) if (input[f] !== undefined) row[f] = input[f]
            resource.rows.push(row)
            return send(res, 201, row)
          }
          return problem(res, 405, `${req.method} not allowed on ${url.pathname}`)
        }

        const row = resource.rows.find((r) => r.id === id)
        if (!row) return problem(res, 404, `No ${name} ${id}`)
        if (req.method === 'GET') return send(res, 200, row)
        if (req.method === 'PUT' && resource.update) {
          const input = await read(req)
          for (const f of resource.update) if (input[f] !== undefined) row[f] = input[f]
          return send(res, 200, row)
        }
        if (req.method === 'DELETE' && resource.remove) {
          resource.rows.splice(resource.rows.indexOf(row), 1)
          return send(res, 204)
        }
        return problem(res, 405, `${req.method} not allowed on ${url.pathname}`)
      })
    },
  }
}
