import type { PageSource } from '@trivia/blueprint-compiler'

import type { InferredPage } from './refine/index.js'
import type { RouteEntry, RoutesHost } from './routes/index.js'

/** Read-only engine access for a host's route discovery. */
export type RouteSource = Pick<RoutesHost, 'outline' | 'inspect' | 'describeValues'>

export interface PreviewHost {
  /** This app host can render compiled blueprint drafts. */
  blueprints?: true
  publishBlueprint?(name: string, files: readonly PageSource[]): void
  removeBlueprint?(name: string): void
  invalidateBlueprints?(): void
  /** Make the compiled preview available to the app and return its URL. */
  publish(id: string, page: Pick<InferredPage, 'code' | 'component'>): string | Promise<string>
  /** Release resources owned by this host. */
  close?(): void | Promise<void>
}

export interface DevHost {
  root: string
  kind: 'vite' | 'next'
  uiDir: string
  importBase: string
  /** The app's import resolution, returning a project-relative file. */
  resolveModule(specifier: string, from: string): Promise<string | null>
  readRoutes(source: RouteSource): Promise<RouteEntry[]>
  preview: PreviewHost
  allowedHosts: readonly string[] | true
  /** Capture host state before file creation/removal. The callback runs after a successful write. */
  trackFileWrites?(creating: readonly string[], removing: readonly string[]): () => void
  /**
   * The project-relative files a successful edit, undo or redo just wrote, before the call that
   * wrote them is answered. A host whose dev server caches transformed modules drops them here,
   * so a request right after the answer gets the new source, though its file watcher may not
   * have reported the write yet. It sends no update: the watcher does. Must not throw.
   */
  filesWritten?(files: readonly string[]): void
}
