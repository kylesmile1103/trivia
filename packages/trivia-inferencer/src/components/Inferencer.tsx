// What every inferencer renders (docs/product.md, slice 6): a banner saying where the page comes
// from, with View code and Eject to disk, above the page itself, live.

import { useState } from 'react'

import { useEjectToDisk } from '../hooks/useEjectToDisk'
import { useResourceContract } from '../hooks/useResourceContract'
import { CodeDrawer } from '../preview/CodeDrawer'
import { type ModuleLoader, PagePreview, importModule } from '../preview/PagePreview'
import { styles } from '../preview/styles'
import type { OpenApiInferencerProps, PageKind } from '../types'

export interface InferencerProps extends OpenApiInferencerProps {
  kind: PageKind
  /** How the page's module is loaded; tests stub it. */
  load?: ModuleLoader
  fetcher?: typeof fetch
}

const NOUN: Record<PageKind, string> = { list: 'list', create: 'create form', edit: 'edit form', show: 'details page' }

export function Inferencer({ kind, load = importModule, fetcher, ...props }: InferencerProps) {
  // Trivia's dev server stamps every element with its locator, which reaches a component as a
  // prop: the inferencer's own place in the app, for Eject to put the page there.
  const locator = (props as { 'data-ast-node'?: string })['data-ast-node']
  const contract = useResourceContract(kind, props, fetcher)
  const eject = useEjectToDisk(fetcher)
  const [showCode, setShowCode] = useState(false)
  const [target, setTarget] = useState<string | null>(null)
  const { page } = contract

  if (contract.resource === null) {
    return (
      <div role="alert" style={styles.error}>
        The inferencer found no resource: this route matches none of {'<Refine resources>'}. Pass one, e.g. {'<OpenApi…Inferencer resource="customers" />'}.
      </div>
    )
  }
  if (contract.error) {
    return (
      <div role="alert" style={styles.error}>
        Trivia couldn't infer the {contract.resource} {NOUN[kind]}: {contract.error.message}
      </div>
    )
  }
  if (contract.isLoading || !page) return <p style={styles.note}>Inferring the {contract.resource} {NOUN[kind]} from the contract…</p>

  const write = async () => {
    const file = target ?? page.file
    await eject.eject({
      resource: page.resource,
      kind,
      ...(file !== page.file || props.ejectPath ? { file } : {}),
      ...(props.hideFields ? { hideFields: props.hideFields } : {}),
      ...(props.title ? { title: props.title } : {}),
      ...(locator ? { locator } : {}),
    })
    setTarget(null)
  }

  return (
    <div data-trivia-inferencer={kind}>
      <section aria-label="Trivia inferencer" style={styles.banner}>
        <span style={styles.tag}>Trivia inferencer</span>
        <span>
          Inferred from the OpenAPI contract: {page.resource} {NOUN[kind]}
        </span>
        <span style={styles.spacer} />
        {eject.status === 'done' && eject.result ? (
          <span role="status">
            Wrote {page.file}. {eject.result.warnings.length > 0 ? eject.result.warnings.join(' ') : `The route now renders <${page.component} />.`}
          </span>
        ) : target !== null ? (
          <>
            <label>
              Write to{' '}
              <input aria-label="File to write" style={styles.input} value={target} onChange={(e) => setTarget(e.target.value)} />
            </label>
            <button type="button" style={styles.primary} disabled={eject.status === 'ejecting'} onClick={() => void write()}>
              {eject.status === 'ejecting' ? 'Writing…' : 'Write the file'}
            </button>
            <button type="button" style={styles.button} onClick={() => setTarget(null)}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button type="button" style={styles.button} onClick={() => setShowCode(true)}>
              View code
            </button>
            <button
              type="button"
              style={styles.primary}
              disabled={page.exists && !props.ejectPath}
              title={page.exists && !props.ejectPath ? `${page.file} already exists: pass ejectPath to write elsewhere` : `Write ${page.file} and render <${page.component} /> here`}
              onClick={() => setTarget(page.file)}
            >
              Eject to disk
            </button>
          </>
        )}
        {eject.error && (
          <span role="alert" style={{ flexBasis: '100%', color: '#7f1d1d' }}>
            Eject failed: {eject.error.message}
          </span>
        )}
      </section>
      <PagePreview page={page} load={load} />
      {showCode && <CodeDrawer code={page.code} file={page.file} onClose={() => setShowCode(false)} />}
    </div>
  )
}
