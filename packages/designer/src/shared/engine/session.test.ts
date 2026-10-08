import { describe, expect, it } from 'vitest'

import { ApiError } from './client'
import { describeFailure } from './session'

describe('describeFailure', () => {
  const url = 'http://localhost:4400/@trivia/api/health'
  const nonJson = (status: number) =>
    new ApiError({ code: 'internal', message: `engine returned non-JSON (HTTP ${status}); is vite-plugin-ast-locator installed in the app?` }, status)

  it('blames the proxied dev server when the proxy answers 5xx without JSON', () => {
    // Vite's proxy answers 502 with an empty body when the target refuses the connection.
    expect(describeFailure(nonJson(502), url)).toEqual({
      url,
      kind: 'proxy',
      status: 502,
      message: "HTTP 502 from the designer's proxy instead of an engine response",
    })
  })

  it('blames a missing plugin when the dev server answers with something else', () => {
    expect(describeFailure(nonJson(200), url).kind).toBe('plugin')
    expect(describeFailure(nonJson(404), url).kind).toBe('plugin')
  })

  it('reports the designer itself when the request never completed', () => {
    expect(describeFailure(new ApiError({ code: 'io_error', message: 'engine unreachable' }, 0), url).kind).toBe('designer')
  })

  it('passes engine errors through', () => {
    const failure = describeFailure(new ApiError({ code: 'forbidden', message: 'refusing a request' }, 403), url)
    expect(failure).toEqual({ url, kind: 'engine', status: 403, message: 'refusing a request' })
  })
})
