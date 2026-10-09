// URL patterns as the two routers write them. React Router: `:id`, `:id?`, a trailing `*`.
// TanStack Router: `$id`, `{-$id}` (optional), a lone `$` (splat); its route IDs also carry
// pathless layouts (`_auth`) and groups (`(admin)`), which add nothing to the URL.

/** One leading slash, no doubled or trailing ones (the root stays `/`). */
export function normalizePath(path: string): string {
  const joined = `/${path}`.replace(/\/{2,}/g, '/')
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined
}

/** `path` without a trailing splat: the base that routes nested under it resolve against. */
export function withoutSplat(path: string): string {
  return normalizePath(path.replace(/\/?\*$/, ''))
}

/** A child's path resolved against its parent's, as React Router does: absolute paths stand alone. */
export function joinPath(parent: string, child: string): string {
  return child.startsWith('/') ? normalizePath(child) : normalizePath(`${withoutSplat(parent)}/${child}`)
}

/** The params a URL for `path` needs, in order; a splat is `*`. */
export function routeParams(path: string): string[] {
  const params: string[] = []
  for (const segment of path.split('/')) {
    const named = /^:([\w$-]+)\??$/.exec(segment) ?? /^\{-\$([\w-]+)\}$/.exec(segment) ?? /^\$([\w-]+)$/.exec(segment)
    if (named?.[1]) params.push(named[1])
    else if (segment === '*' || segment === '$') params.push('*')
  }
  return params
}

/** A TanStack Router route ID (`/_auth/posts/$postId`, `/posts/`) as the URL pattern it serves. */
export function tanstackPath(id: string): string {
  const segments = id.split('/').filter((s) => s !== '' && !s.startsWith('_') && !/^\(.*\)$/.test(s))
  return normalizePath(segments.join('/'))
}
