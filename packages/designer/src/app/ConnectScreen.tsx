// Full-screen states shown before the workspace: connecting, and engine unreachable.

import { LoaderCircleIcon, RefreshCwIcon } from 'lucide-react'

import { TriviaMark } from '@/shared/components/Brand'
import { type EngineFailure, connect, useSession } from '@/shared/engine/session'
import { proxyTarget } from '@/shared/lib/env'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'

export function ConnectingScreen() {
  return (
    <Screen>
      <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <LoaderCircleIcon className="size-4 animate-spin" />
        Connecting to {proxyTarget ?? 'your app'}…
      </div>
    </Screen>
  )
}

export function UnreachableScreen() {
  const failure = useSession((s) => s.failure)
  const busy = useSession((s) => s.busy)
  const target = proxyTarget ?? 'http://localhost:5173'
  return (
    <Screen>
      <div className="grid w-full max-w-lg gap-5" role="alert">
        <div className="grid gap-1.5">
          <h1 className="text-base font-semibold">Can't reach the Trivia engine</h1>
          <p className="text-sm text-muted-foreground">{headline(failure, target)}</p>
        </div>

        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-lg border bg-muted/40 p-3 text-xs">
          <dt className="text-muted-foreground">Request</dt>
          <dd className="font-mono break-all">
            GET {failure?.url ?? '/@trivia/api/health'}
            {failure !== null && failure.status > 0 && <span className="text-muted-foreground"> → HTTP {failure.status}</span>}
          </dd>
          <dt className="text-muted-foreground">Proxied to</dt>
          <dd className="font-mono break-all">
            {target} <span className="font-sans text-muted-foreground">(TRIVIA_TARGET)</span>
          </dd>
          {failure !== null && (
            <>
              <dt className="text-muted-foreground">Error</dt>
              <dd className="font-mono break-words">{failure.message}</dd>
            </>
          )}
        </dl>

        <ol className="grid list-decimal gap-2 pl-5 text-sm text-muted-foreground marker:text-muted-foreground/70">
          <li>
            Start your app's Vite dev server with <code className="font-mono text-foreground">vite-plugin-ast-locator</code>{' '}
            in its <code className="font-mono text-foreground">plugins</code> (before the React plugin).
          </li>
          <li>
            Make sure it listens on <code className="font-mono text-foreground">{target}</code>, or restart the designer
            with <code className="font-mono text-foreground">TRIVIA_TARGET=&lt;your dev server URL&gt;</code>.
          </li>
        </ol>

        <div className="flex items-center gap-3">
          <Button size="sm" onClick={() => void connect({ manual: true })} disabled={busy}>
            <RefreshCwIcon className={cn(busy && 'animate-spin')} />
            Retry
          </Button>
          <span className="text-xs text-muted-foreground">Retrying automatically every few seconds.</span>
        </div>
      </div>
    </Screen>
  )
}

function headline(failure: EngineFailure | null, target: string): string {
  switch (failure?.kind) {
    case 'proxy':
      return `The designer is running, but nothing answered at ${target}. Your app's dev server isn't running there.`
    case 'plugin':
      return `${target} answered, but without the engine API. Is vite-plugin-ast-locator installed in that app?`
    case 'designer':
      return "The designer's own dev server stopped responding. Restart it, then retry."
    case 'engine':
      return 'The engine API answered with an error.'
    default:
      return 'The startup health check failed.'
  }
}

function Screen({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex h-svh flex-col bg-background text-foreground">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
        <TriviaMark />
        <span className="text-sm font-semibold tracking-tight">Trivia</span>
      </div>
      <div className="flex flex-1 items-center justify-center p-6">{children}</div>
    </main>
  )
}
