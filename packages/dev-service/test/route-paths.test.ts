import { describe, expect, it } from 'vitest'

import { joinPath, normalizePath, routeParams, tanstackPath, withoutSplat } from '../src/routes/paths.js'

describe('route paths', () => {
  it('joins a child onto its parent as React Router resolves it', () => {
    expect(joinPath('/', 'customers')).toBe('/customers')
    expect(joinPath('/customers', 'edit/:id')).toBe('/customers/edit/:id')
    expect(joinPath('/customers', '/accounts')).toBe('/accounts')
    expect(joinPath('/settings/*', 'profile')).toBe('/settings/profile')
    expect(joinPath('/', '')).toBe('/')
  })

  it('normalizes slashes, keeping the root', () => {
    expect(normalizePath('')).toBe('/')
    expect(normalizePath('/')).toBe('/')
    expect(normalizePath('a//b/')).toBe('/a/b')
  })

  it('takes the splat off the base a descendant <Routes> resolves against', () => {
    expect(withoutSplat('/settings/*')).toBe('/settings')
    expect(withoutSplat('/*')).toBe('/')
    expect(withoutSplat('/files')).toBe('/files')
  })

  it("lists a path's params in both routers' syntax; a splat is *", () => {
    expect(routeParams('/customers/edit/:id')).toEqual(['id'])
    expect(routeParams('/:org/repos/:repo?')).toEqual(['org', 'repo'])
    expect(routeParams('/files/*')).toEqual(['*'])
    expect(routeParams('/posts/$postId')).toEqual(['postId'])
    expect(routeParams('/docs/$')).toEqual(['*'])
    expect(routeParams('/blog/{-$lang}/latest')).toEqual(['lang'])
    expect(routeParams('/accounts')).toEqual([])
  })

  it('turns a TanStack route ID into its URL: pathless and group segments add nothing', () => {
    expect(tanstackPath('/')).toBe('/')
    expect(tanstackPath('/posts/')).toBe('/posts')
    expect(tanstackPath('/posts/$postId')).toBe('/posts/$postId')
    expect(tanstackPath('/_auth/dashboard')).toBe('/dashboard')
    expect(tanstackPath('/(admin)/users')).toBe('/users')
    expect(tanstackPath('/_auth')).toBe('/')
  })
})
