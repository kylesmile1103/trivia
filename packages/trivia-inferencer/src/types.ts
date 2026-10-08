// What the inferencer and Trivia's dev server say to each other (docs/api.md `refine/preview`).

export type PageKind = 'list' | 'create' | 'edit' | 'show'

/** The props every inferencer takes. */
export interface OpenApiInferencerProps {
  /** The Refine resource (`customers`) or the contract's (`Customer`); default: the route's. */
  resource?: string
  /** Where Eject writes the page (project-relative, under `src/`); default: next to the other pages. */
  ejectPath?: string
  /** Contract fields to leave out of the page. */
  hideFields?: string[]
  /** The page's title. */
  title?: string
}

/** A page generated from the contract (the plugin's `InferredPage`). */
export interface InferredPage {
  /** The contract resource (`Customer`) and its Refine name (`customers`). */
  resource: string
  name: string
  kind: PageKind
  /** The component the page exports (`CustomerList`) and the path it is imported from. */
  component: string
  importPath: string
  /** Where Eject writes it, and whether a file is there already (Eject then refuses). */
  file: string
  exists: boolean
  /** The route Refine conventionally gives it. */
  route: string
  /** The dev server's module for it (`/@trivia/preview/<id>.tsx`): the code, compiled. */
  module: string
  code: string
}

/** Ops the dev server applies as one undo entry (`/batch`). */
export interface Plan {
  ops: unknown[]
  label: string
  /** What is left for the developer to do by hand. */
  warnings?: string[]
}
