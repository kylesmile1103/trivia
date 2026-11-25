// The Pages tab: the app's routes, read from its source (plugin `GET /routes`: React Router,
// TanStack Router, Refine's resource labels), to move the canvas between pages. A route without
// params loads on click. One with params asks for them first, prefilled from the canvas URL when
// it is on that route, else with the last value given for that param. The path field shows where
// the canvas is and loads any path typed into it, for routes the source doesn't declare.

import { ArrowRightIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { canvas } from '@/shared/canvas'
import { engine } from '@/shared/engine/client'
import type { AppRoute } from '@/shared/engine/types'
import { cn } from '@/shared/lib/utils'
import { useDesigner } from '@/shared/state/store'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'

import { fillRoute, matchRoute } from './route-url'

/** Values given for params, by name, for this session: an `id` given once prefills the next. */
const remembered = new Map<string, string>()

type Loaded = { routes: AppRoute[] } | { error: string } | null

export function PagesPanel() {
  const revision = useDesigner((s) => s.revision)
  const canvasPath = useDesigner((s) => s.canvasPath)
  const next = useDesigner((s) => s.health?.host === 'next')
  const [loaded, setLoaded] = useState<Loaded>(null)
  /** The route whose params are being asked for. */
  const [asking, setAsking] = useState<string | null>(null)

  // Routes change with the source (a page added from the Data tab): read them after re-renders.
  useEffect(() => {
    let live = true
    engine.routes().then(
      (routes) => live && setLoaded({ routes }),
      (error: unknown) => live && setLoaded({ error: error instanceof Error ? error.message : String(error) }),
    )
    return () => {
      live = false
    }
  }, [revision])

  const routes = useMemo(() => (loaded !== null && 'routes' in loaded ? loaded.routes : []), [loaded])
  const pathname = canvasPath === null ? null : canvasPath.split(/[?#]/)[0]!
  // A catch-all matches every URL: it is where the canvas is only when nothing else is.
  const current = useMemo(() => {
    if (pathname === null) return null
    const on = (r: AppRoute) => matchRoute(r.path, pathname) !== null
    return routes.find((r) => !r.catchAll && on(r)) ?? routes.find((r) => r.catchAll && on(r)) ?? null
  }, [routes, pathname])

  const go = (url: string) => {
    const path = url.trim()
    if (path !== '') canvas.navigate(path.startsWith('/') ? path : `/${path}`)
  }

  const initialParams = (route: AppRoute): Record<string, string> => {
    const fromUrl = route === current && pathname !== null ? matchRoute(route.path, pathname) : null
    return Object.fromEntries(route.params.map((p) => [p, fromUrl?.[p] ?? remembered.get(p) ?? '']))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <form
        className="flex shrink-0 items-center gap-1 border-b p-2"
        onSubmit={(e) => {
          e.preventDefault()
          go(String(new FormData(e.currentTarget).get('path') ?? ''))
        }}
      >
        <Input
          key={canvasPath ?? ''}
          name="path"
          aria-label="Path"
          defaultValue={canvasPath ?? ''}
          placeholder="/"
          spellCheck={false}
          className="h-7 font-mono text-xs"
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            e.preventDefault()
            go(e.currentTarget.value)
          }}
        />
        <Button type="submit" variant="ghost" size="icon" className="size-7 shrink-0" aria-label="Open path" title="Open this path in the canvas">
          <ArrowRightIcon className="size-3.5" />
        </Button>
      </form>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1 [scrollbar-width:thin]">
        {loaded === null ? (
          <p className="px-1 py-2 text-xs text-muted-foreground">Reading the app's routes…</p>
        ) : 'error' in loaded ? (
          <p className="px-1 py-2 text-xs text-destructive">Couldn't read the routes: {loaded.error}</p>
        ) : routes.length === 0 ? (
          <p className="px-1 py-2 text-xs text-muted-foreground">
            {next
              ? 'No App Router routes found. The Pages Router is unsupported.'
              : 'No routes found under src/. React Router and TanStack Router routes show here; type a path above to open any other.'}
          </p>
        ) : (
          <ul aria-label="Routes" className="m-0 list-none p-0">
            {routes.map((route) => {
              const needsParams = route.params.length > 0
              const open = needsParams && asking === route.path
              return (
                <li key={route.path}>
                  <button
                    type="button"
                    data-route={route.path}
                    aria-current={route === current ? 'page' : undefined}
                    aria-expanded={needsParams ? open : undefined}
                    title={needsParams ? `Open ${route.path} (needs ${route.params.join(', ')})` : `Open ${route.path}`}
                    className={cn(
                      'flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left',
                      route === current ? 'bg-primary/10' : 'hover:bg-accent/60',
                    )}
                    onClick={() => (needsParams ? setAsking(open ? null : route.path) : go(route.path))}
                  >
                    <span data-label className="w-full truncate text-xs font-medium">
                      {label(route)}
                    </span>
                    <span className="w-full truncate font-mono text-[11px] text-muted-foreground">{route.path}</span>
                    {route.file !== null && (
                      <span className="w-full truncate text-[10px] text-muted-foreground" title={route.file}>
                        {route.file.replace(/^src\//, '')}
                      </span>
                    )}
                  </button>
                  {open && (
                    <ParamsForm
                      route={route}
                      initial={initialParams(route)}
                      onGo={(url, values) => {
                        for (const [name, value] of Object.entries(values)) if (value.trim() !== '') remembered.set(name, value.trim())
                        go(url)
                      }}
                    />
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

function ParamsForm({
  route,
  initial,
  onGo,
}: {
  route: AppRoute
  initial: Record<string, string>
  onGo: (url: string, values: Record<string, string>) => void
}) {
  const [values, setValues] = useState(initial)
  const url = fillRoute(route.path, values)
  const submit = () => {
    if (url !== null) onGo(url, values)
  }
  return (
    <form
      className="flex items-center gap-1 px-2 pt-0.5 pb-2"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      {route.params.map((name, i) => (
        <Input
          key={name}
          aria-label={name === '*' ? 'Rest of the path' : name}
          placeholder={name === '*' ? 'rest/of/path' : name}
          autoFocus={i === 0}
          spellCheck={false}
          value={values[name] ?? ''}
          className="h-7 font-mono text-xs"
          onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            e.preventDefault()
            submit()
          }}
        />
      ))}
      <Button
        type="submit"
        variant="secondary"
        size="icon"
        className="size-7 shrink-0"
        aria-label={`Open ${route.path}`}
        title={url ?? 'Fill in every param first'}
        disabled={url === null}
      >
        <ArrowRightIcon className="size-3.5" />
      </Button>
    </form>
  )
}

/** "Customers · Edit" for a Refine resource's route, else the component it renders, else its URL. */
function label(route: AppRoute): string {
  if (route.resource !== null) return `${title(route.resource.name)} · ${title(route.resource.action)}`
  return route.component ?? route.path
}

function title(word: string): string {
  return word.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}
