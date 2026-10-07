// The inspector panel: engine details for the selected node joined with the component's prop
// schema, one setter per prop, the className manager and the style panel. Every edit is one
// `updateProp` through the action bus (./commit); the source on disk stays the truth, and the
// panel re-reads it after each commit and on every canvas revision (HMR).

import { MousePointerClick, RefreshCw, SearchX, TriangleAlert } from 'lucide-react'
import { useCallback, useMemo, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { JsonValue, NodeDetails } from '@/bridge/types'
import { canvas } from '@/canvas/api'
import { useDesigner } from '@/state/store'

import { AddProp } from './AddProp'
import { ClassManager } from './ClassManager'
import { commitProp, type CommitProp } from './commit'
import { installDebugHandle } from './debug'
import { Header } from './Header'
import { buildModel, isIntrinsic } from './model'
import { PropField, ROW, RowHint, SourceCode } from './PropField'
import { StylePanel } from './style/StylePanel'
import { useSelectedDetails, type LoadFailure } from './useNodeDetails'

installDebugHandle()

export function Inspector() {
  const { status, reload } = useSelectedDetails()
  return (
    <aside aria-label="Inspector" className="flex w-80 shrink-0 flex-col border-l bg-background text-sm">
      {status.status === 'idle' && <EmptyState />}
      {status.status === 'loading' && <LoadingState />}
      {status.status === 'error' && <ErrorState locator={status.locator} failure={status.failure} onRetry={reload} />}
      {status.status === 'ready' && (
        <NodeInspector key={status.details.locator} details={status.details} refreshing={status.refreshing} reload={reload} />
      )}
    </aside>
  )
}

function NodeInspector({ details, refreshing, reload }: { details: NodeDetails; refreshing: boolean; reload(): void }) {
  // Own keys only: `componentsByName` is a plain object, and a tag must never resolve to a
  // prototype member.
  const schema = useDesigner((s) => (Object.hasOwn(s.componentsByName, details.name) ? s.componentsByName[details.name] : null)) ?? null
  const schemasLoaded = useDesigner((s) => s.components.length > 0)
  const model = useMemo(() => buildModel(details, schema), [details, schema])
  const intrinsic = isIntrinsic(details.name)

  const commit = useCallback<CommitProp>(
    async (prop: string, value: JsonValue) => {
      const ok = await commitProp(details, prop, value)
      // Re-read the source either way: on success to show what was written, on failure because
      // the refusal (stale locator, conflict) usually means the file changed underneath us.
      reload()
      return ok
    },
    [details, reload],
  )
  const commitClassName = useCallback((value: string | null) => commit('className', value), [commit])
  const commitStyle = useCallback(
    async (next: string) => {
      await commitClassName(next.trim() === '' ? null : next)
      canvas.clearPreviews()
    },
    [commitClassName],
  )

  if (details.isFragment) {
    return (
      <>
        <Header details={details} refreshing={refreshing} />
        <p className="px-3 py-4 text-xs text-muted-foreground">Fragments (&lt;&gt;) can’t carry props or classes.</p>
      </>
    )
  }

  const className = model.className
  const authored = className?.state === 'literal' ? className.value : ''
  const hasRows = model.props.length + model.extra.length + model.spreads.length > 0

  return (
    <>
      <Header details={details} refreshing={refreshing} />
      <ScrollArea className="min-h-0 flex-1">
        <Section title={intrinsic ? 'Attributes' : 'Props'}>
          {!intrinsic && schema === null && (
            <Note>
              {schemasLoaded
                ? `No prop schema for ${details.name} — showing the attributes written in source.`
                : 'Prop schemas aren’t loaded — showing the attributes written in source.'}
            </Note>
          )}
          {schema?.unresolvedTypes !== undefined && schema.unresolvedTypes.length > 0 && (
            <Note>
              Some props come from types the analyzer can’t expand:{' '}
              <span className="font-mono">{schema.unresolvedTypes.join(', ')}</span>
            </Note>
          )}
          <div className="space-y-1">
            {model.props.map((row) => (
              <PropField key={row.name} row={row} details={details} commit={commit} />
            ))}
            {model.extra.length > 0 && !intrinsic && schema !== null && <SubHeading>Other attributes</SubHeading>}
            {model.extra.map((row) => (
              <PropField key={row.name} row={row} details={details} commit={commit} />
            ))}
            {model.spreads.map((source, index) => (
              <div key={`spread-${index}`} className={ROW}>
                <span className="flex h-7 items-center font-mono text-[11px] text-muted-foreground">spread</span>
                <SourceCode source={source} />
                <span />
                <RowHint>Spread props — edit in code.</RowHint>
              </div>
            ))}
            {!hasRows && (
              <p className="text-xs text-muted-foreground">{intrinsic ? 'No attributes written.' : 'No props written.'}</p>
            )}
          </div>
          <div className="mt-1.5">
            <AddProp written={model.written} commit={commit} />
          </div>
        </Section>

        {className !== null && (
          <Section title="Classes" aside={<span className="font-mono normal-case">className</span>}>
            {className.state === 'readonly' ? (
              <>
                <SourceCode source={className.source} />
                <p className="mt-1 text-[11px] leading-4 text-muted-foreground">className is an expression — edit in code.</p>
              </>
            ) : (
              <ClassManager details={details} authored={authored} commit={commitClassName} />
            )}
          </Section>
        )}

        {className !== null && className.state !== 'readonly' && (
          <StylePanel
            locator={details.locator}
            className={authored}
            onPreview={(style) => canvas.previewStyle(details.locator, style)}
            onCommit={(next) => void commitStyle(next)}
          />
        )}

        {details.text !== null && (
          <Section title="Text">
            <p className="rounded-md border bg-muted/40 px-2 py-1.5 text-xs break-words">{details.text}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">Read-only for now — edit text in code.</p>
          </Section>
        )}
      </ScrollArea>
    </>
  )
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="border-b px-3 py-3">
      <div className="mb-2 flex items-center justify-between text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        <h3>{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  )
}

function SubHeading({ children }: { children: ReactNode }) {
  return <p className="pt-2 pb-0.5 text-[11px] text-muted-foreground">{children}</p>
}

function Note({ children }: { children: ReactNode }) {
  return <p className="mb-2 text-[11px] leading-4 text-muted-foreground">{children}</p>
}

function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-8 text-center">
      <MousePointerClick className="mb-1 size-5 text-muted-foreground" aria-hidden />
      <p className="text-sm font-medium">Nothing selected</p>
      <p className="text-xs text-muted-foreground">Click an element on the canvas to inspect and edit its props.</p>
    </div>
  )
}

function LoadingState() {
  return (
    <div className="space-y-2 px-3 py-3" aria-busy="true" aria-label="Loading element">
      <div className="h-4 w-28 animate-pulse rounded bg-muted" />
      <div className="h-3 w-44 animate-pulse rounded bg-muted" />
      <div className="h-3 w-36 animate-pulse rounded bg-muted" />
    </div>
  )
}

function ErrorState({ locator, failure, onRetry }: { locator: string; failure: LoadFailure; onRetry(): void }) {
  const select = useDesigner((s) => s.select)
  const notFound = failure.code === 'node_not_found'
  const parent = failure.last?.parent ?? null
  const title = notFound
    ? 'Element not found'
    : failure.code === 'parse_error'
      ? 'The file doesn’t parse'
      : 'Couldn’t inspect this element'
  const body = notFound
    ? 'Nothing is at this position any more — an edit (here or in your editor) moved or removed it.'
    : failure.code === 'parse_error'
      ? 'Fix the syntax error in your editor; the inspector re-reads the file when it changes.'
      : null
  const Icon = notFound ? SearchX : TriangleAlert
  return (
    <div role="alert" className="space-y-3 px-3 py-4">
      <div className="flex items-center gap-2">
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <p className="text-sm font-medium">{title}</p>
      </div>
      {body !== null && <p className="text-xs text-muted-foreground">{body}</p>}
      {!notFound && (
        <code className="block rounded-md border bg-muted/50 px-2 py-1.5 font-mono text-[11px] break-words whitespace-pre-wrap">
          {failure.message}
        </code>
      )}
      <p className="font-mono text-[11px] break-all text-muted-foreground">{locator}</p>
      <div className="flex flex-wrap gap-1.5">
        {parent !== null && (
          <Button variant="outline" size="xs" onClick={() => select(parent)}>
            Select parent
          </Button>
        )}
        <Button variant="outline" size="xs" onClick={onRetry}>
          <RefreshCw />
          Retry
        </Button>
        <Button variant="ghost" size="xs" onClick={() => select(null)}>
          Clear selection
        </Button>
      </div>
    </div>
  )
}
