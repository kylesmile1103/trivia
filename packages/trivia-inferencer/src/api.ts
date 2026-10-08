// Calls to Trivia's dev-server API (docs/api.md), which the app's own Vite dev server serves at
// /@trivia/api when it runs @trivia/vite-plugin-ast-locator.

/** Where the plugin serves its API, on the app's own origin. */
export const API = '/@trivia/api'

/** A failed call: the API's error code (`conflict`, `node_not_found`…) or `unreachable`, `no_plugin`. */
export class TriviaApiError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'TriviaApiError'
    this.code = code
  }
}

type Envelope = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } }

function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== 'object' || value === null || typeof (value as { ok?: unknown }).ok !== 'boolean') return false
  const v = value as { ok: boolean; error?: { code?: unknown; message?: unknown } }
  return v.ok || (typeof v.error?.code === 'string' && typeof v.error.message === 'string')
}

/** POST `body` to an API route and unwrap its envelope; every failure is a `TriviaApiError` that says what to do. */
export async function post<T>(route: string, body: unknown, fetcher: typeof fetch = fetch): Promise<T> {
  let response: Response
  try {
    response = await fetcher(`${API}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  } catch (error) {
    throw new TriviaApiError(
      'unreachable',
      `Trivia's dev server can't be reached (${error instanceof Error ? error.message : String(error)}). The inferencer runs on the app's Vite dev server with @trivia/vite-plugin-ast-locator.`,
    )
  }
  let envelope: unknown = null
  try {
    envelope = await response.json()
  } catch {
    // Not the API: an HTML fallback page, or nothing.
  }
  if (isEnvelope(envelope)) {
    if (envelope.ok) return envelope.data as T
    throw new TriviaApiError(envelope.error.code, envelope.error.message)
  }
  throw new TriviaApiError(
    'no_plugin',
    `No Trivia API at ${API} (HTTP ${response.status}): add astLocator() from @trivia/vite-plugin-ast-locator to the app's Vite plugins, and run the dev server.`,
  )
}
