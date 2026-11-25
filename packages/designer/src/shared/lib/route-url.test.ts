import { describe, expect, it } from 'vitest'

import { fillRoute, matchRoute } from './route-url'

describe('matching a URL to a route', () => {
  it('matches static paths, params and the root', () => {
    expect(matchRoute('/', '/')).toEqual({})
    expect(matchRoute('/customers', '/customers')).toEqual({})
    expect(matchRoute('/customers', '/customers/')).toEqual({})
    expect(matchRoute('/customers', '/accounts')).toBeNull()
    expect(matchRoute('/customers/edit/:id', '/customers/edit/42')).toEqual({ id: '42' })
    expect(matchRoute('/customers/edit/:id', '/customers/edit')).toBeNull()
    expect(matchRoute('/posts/$postId', '/posts/hello%20world')).toEqual({ postId: 'hello world' })
  })

  it('takes optional params and splats', () => {
    expect(matchRoute('/:lang?/about', '/about')).toEqual({})
    expect(matchRoute('/:lang?/about', '/fr/about')).toEqual({ lang: 'fr' })
    expect(matchRoute('/blog/{-$lang}/latest', '/blog/latest')).toEqual({})
    expect(matchRoute('/files/*', '/files/a/b.txt')).toEqual({ '*': 'a/b.txt' })
    expect(matchRoute('/*', '/anything/at/all')).toEqual({ '*': 'anything/at/all' })
    expect(matchRoute('/docs/$', '/docs')).toEqual({ '*': '' })
  })
})

describe('filling a route', () => {
  it('builds the URL, encoding each value', () => {
    expect(fillRoute('/customers', {})).toBe('/customers')
    expect(fillRoute('/customers/edit/:id', { id: '42' })).toBe('/customers/edit/42')
    expect(fillRoute('/posts/$postId', { postId: 'a b' })).toBe('/posts/a%20b')
    expect(fillRoute('/files/*', { '*': 'a/b c.txt' })).toBe('/files/a/b%20c.txt')
  })

  it('leaves out an empty optional param, and has no URL while a required one is empty', () => {
    expect(fillRoute('/:lang?/about', {})).toBe('/about')
    expect(fillRoute('/:lang?/about', { lang: 'fr' })).toBe('/fr/about')
    expect(fillRoute('/customers/edit/:id', { id: '  ' })).toBeNull()
    expect(fillRoute('/*', {})).toBe('/')
  })
})
