import type { InferredPage } from './refine/index.js'
import type { RouteEntry, RoutesHost } from './routes/index.js'

/** Read-only engine access for a host's route discovery. */
export type RouteSource = Pick<RoutesHost, 'outline' | 'inspect' | 'describeValues'>

export interface PreviewHost {
  /** This app host can inject the Vite blueprint route. */
  blueprints?: true
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
   * The project-relative files a successful edit, undo or redo just wrote. A host reloads them
   * itself instead of waiting for its file watcher, which can miss a write (an edit and its undo
   * a few milliseconds apart) and then keep serving the module it transformed before. Must not
   * throw: the write has already happened.
   */
  filesChanged?(files: readonly string[]): void
}
