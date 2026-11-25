import { headers } from 'next/headers'
import { notFound } from 'next/navigation'

import { apiOrigin } from './api-origin'

export async function apiRequest() {
  const baseUrl = apiOrigin()
  if (!baseUrl) throw new Error('The API address is missing. Start the AppHost or set TRIVIA_API_ORIGIN.')
  const incoming = await headers()
  const forwarded: Record<string, string> = {}
  for (const name of ['cookie', 'authorization']) {
    const value = incoming.get(name)
    if (value !== null) forwarded[name] = value
  }
  return { baseUrl, headers: forwarded, cache: 'no-store' as const, redirect: 'error' as const }
}

export function apiData<T>({ data, response }: { data: T | undefined; response?: Response }): T {
  if (response?.status === 404) notFound()
  if (!response?.ok || data === undefined) throw new Error('The API request failed (' + (response?.status ?? 'network') + ').')
  return data
}
