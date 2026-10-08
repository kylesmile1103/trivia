// A stand-in backend for the playground: the customers API of openapi/customers.openapi.json,
// in memory, served by the playground's own Vite server (so the designer's proxy reaches it
// too). It resets when the dev server restarts. Not part of Trivia: a real app has a real API.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'

import type { Plugin } from 'vite'

type Status = 'pending' | 'active' | 'suspended'
type Kyc = 'not_started' | 'in_review' | 'approved' | 'rejected'

interface Customer {
  id: string
  fullName: string
  email: string
  phone?: string | null
  status: Status
  kycStatus: Kyc
  creditLimit?: number
  birthDate?: string | null
  tags?: string[]
  createdAt: string
}

const SEED: Array<Pick<Customer, 'fullName' | 'email' | 'status' | 'kycStatus'> & { creditLimit: number }> = [
  { fullName: 'Ada Lovelace', email: 'ada@example.com', status: 'active', kycStatus: 'approved', creditLimit: 5000 },
  { fullName: 'Grace Hopper', email: 'grace@example.com', status: 'active', kycStatus: 'approved', creditLimit: 7500 },
  { fullName: 'Alan Turing', email: 'alan@example.com', status: 'pending', kycStatus: 'in_review', creditLimit: 2000 },
  { fullName: 'Katherine Johnson', email: 'katherine@example.com', status: 'active', kycStatus: 'not_started', creditLimit: 3000 },
  { fullName: 'Edsger Dijkstra', email: 'edsger@example.com', status: 'suspended', kycStatus: 'rejected', creditLimit: 0 },
]

const BASE = '/api/v1'

export function mockApi(): Plugin {
  const customers: Customer[] = SEED.map((c, i) => ({ ...c, id: randomUUID(), createdAt: new Date(Date.UTC(2026, 0, i + 1)).toISOString() }))

  const send = (res: ServerResponse, status: number, body?: unknown) => {
    res.statusCode = status
    if (body === undefined) return res.end()
    res.setHeader('content-type', status >= 400 ? 'application/problem+json' : 'application/json')
    res.end(JSON.stringify(body))
  }
  const problem = (res: ServerResponse, status: number, title: string, detail?: string) => send(res, status, { title, status, ...(detail ? { detail } : {}) })
  const body = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = []
    for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk)
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown
      return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
  const editable = ['fullName', 'email', 'phone', 'birthDate', 'creditLimit', 'status'] as const

  return {
    name: 'playground:mock-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (!url.pathname.startsWith(`${BASE}/`)) return next()
        const path = url.pathname.slice(BASE.length)
        const one = /^\/customers\/([^/]+)$/.exec(path)
        const found = one ? customers.find((c) => c.id === one[1]) : undefined

        if (path === '/health' && req.method === 'GET') return send(res, 200, { status: 'ok' })
        if (path === '/customers' && req.method === 'GET') {
          const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1)
          const pageSize = Math.max(1, Number(url.searchParams.get('pageSize') ?? 20) || 20)
          const search = (url.searchParams.get('search') ?? '').toLowerCase()
          const status = url.searchParams.get('status')
          const rows = customers.filter(
            (c) => (!search || `${c.fullName} ${c.email}`.toLowerCase().includes(search)) && (!status || c.status === status),
          )
          return send(res, 200, { items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize })
        }
        if (path === '/customers' && req.method === 'POST') {
          const input = await body(req)
          if (typeof input['fullName'] !== 'string' || !input['fullName'] || typeof input['email'] !== 'string' || !input['email']) {
            return problem(res, 422, 'Invalid customer', 'fullName and email are required')
          }
          const created: Customer = { id: randomUUID(), status: 'pending', kycStatus: 'not_started', createdAt: new Date().toISOString(), fullName: input['fullName'], email: input['email'] }
          for (const key of editable) if (input[key] !== undefined && key !== 'status') Object.assign(created, { [key]: input[key] })
          customers.push(created)
          return send(res, 201, created)
        }
        if (one && !found) return problem(res, 404, 'Customer not found')
        if (found && req.method === 'GET') return send(res, 200, found)
        if (found && req.method === 'PUT') {
          const input = await body(req)
          for (const key of editable) if (input[key] !== undefined) Object.assign(found, { [key]: input[key] })
          return send(res, 200, found)
        }
        if (found && req.method === 'DELETE') {
          customers.splice(customers.indexOf(found), 1)
          return send(res, 204)
        }
        const kyc = /^\/customers\/([^/]+)\/approve-kyc$/.exec(path)
        if (kyc && req.method === 'POST') {
          const customer = customers.find((c) => c.id === kyc[1])
          if (!customer) return problem(res, 404, 'Customer not found')
          if (customer.kycStatus === 'approved') return problem(res, 409, 'KYC already approved')
          customer.kycStatus = 'approved'
          return send(res, 200, customer)
        }
        return problem(res, 404, `No route for ${req.method} ${url.pathname}`)
      })
    },
  }
}
