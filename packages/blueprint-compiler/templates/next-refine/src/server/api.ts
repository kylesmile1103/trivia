import { headers } from 'next/headers'
import { notFound } from 'next/navigation'

import { apiOrigin } from './api-origin'

export function publicApiRequest() {
  const baseUrl = apiOrigin()
  if (!baseUrl) throw new Error('The API address is missing. Start the AppHost or set TRIVIA_API_ORIGIN.')
  return { baseUrl, cache: 'no-store' as const, redirect: 'error' as const }
}

export async function apiRequest() {
  const incoming = await headers()
  const forwarded: Record<string, string> = {}
  for (const name of ['cookie', 'authorization']) {
    const value = incoming.get(name)
    if (value !== null) forwarded[name] = value
  }
  return { ...publicApiRequest(), headers: forwarded }
}

export function apiData<T>({ data, response }: { data: T | undefined; response?: Response }): T {
  if (response?.status === 404) notFound()
  if (!response?.ok || data === undefined) throw new Error('The API request failed (' + (response?.status ?? 'network') + ').')
  return data
}

type Identity = { id: string | undefined; name: string | undefined; roles: string[] }

export async function readIdentity(): Promise<Identity> {
  const configuredPath = process.env.TRIVIA_IDENTITY_PATH
  const guest = { id: undefined, name: undefined, roles: [] }
  if (!configuredPath) return guest
  const { baseUrl, ...options } = await apiRequest()
  const url = new URL(configuredPath, baseUrl)
  if (!configuredPath.startsWith('/') || url.origin !== baseUrl || url.username || url.password) {
    throw new Error('TRIVIA_IDENTITY_PATH must be a path on the API origin.')
  }
  const response = await fetch(url, options)
  if (response.status === 401 || response.status === 403) return guest
  if (!response.ok) throw new Error('The identity request failed (' + response.status + ').')
  const data: unknown = await response.json()
  if (!data || typeof data !== 'object' || !('id' in data) || typeof data.id !== 'string') {
    throw new Error('The API identity response must contain a string id.')
  }
  return {
    id: data.id,
    name: 'name' in data && typeof data.name === 'string' ? data.name : undefined,
    roles: 'roles' in data && Array.isArray(data.roles) ? data.roles.filter((role): role is string => typeof role === 'string') : [],
  }
}
