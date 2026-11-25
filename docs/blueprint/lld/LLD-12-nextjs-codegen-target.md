# LLD-12: Next.js code generation target

- Spec: `specs/012-nextjs-codegen-target` · Requirements: FR-NX-01 to FR-NX-08 ·
  ADR-0008, ADR-0009
- Code: `packages/blueprint-compiler/src/targets/next-refine/` and
  `packages/blueprint-compiler/templates/next-refine/`.

## 0. Framework versions and APIs

⚑ Match the installed and exercised App Router host from LLD-13. Pin `next@16.4.6`,
`react@19.2.7`, `react-dom@19.2.7`, `@refinedev/core@5.0.12`,
`@refinedev/nextjs-router@7.0.5`, `@refinedev/react-hook-form@5.0.4` and
`@tanstack/react-query@5.103.2`. The current Next.js documentation covers this installed
release.

- The root layout owns `html` and `body`. A `page.tsx` creates a route and a parenthesized
  route group is omitted from its URL. An underscore-prefixed URL segment must have its leading
  underscore escaped as `%5F` on disk. Await `params` and `searchParams`; a catch-all parameter
  is an array and repeated search keys also produce arrays.
  [Project structure](https://nextjs.org/docs/app/getting-started/project-structure),
  [page props](https://nextjs.org/docs/app/api-reference/file-conventions/page),
  [dynamic segments](https://nextjs.org/docs/app/api-reference/file-conventions/dynamic-routes).
- A `next.config.ts` rewrite can send a wildcard path to an external origin. Next.js 16
  renamed Middleware to `proxy.ts`, which runs on Node. The API forwarding here only needs
  a configuration rewrite. [Rewrites](https://nextjs.org/docs/app/api-reference/config/next-config-js/rewrites),
  [Proxy](https://nextjs.org/docs/app/api-reference/file-conventions/proxy).
- Cache Components is opt-in through `cacheComponents`. Its `'use cache'` directive supports
  `cacheLife`; a shared cached function cannot read request headers or cookies. With Cache
  Components enabled, runtime data outside cached functions can require a Suspense boundary.
  [Caching](https://nextjs.org/docs/app/getting-started/caching),
  [cacheLife](https://nextjs.org/docs/app/api-reference/functions/cacheLife).
- Refine runs in a client provider with the App Router binding. The installed router exports
  the same binding from its root and `/app`. The server entry can await a fetch before rendering
  the client view. The installed `useShow` and core `useForm` forward `queryOptions` to
  `useOne`, and the React Hook Form adapter supplies core options through `refineCoreProps`.
  Initial single-record data has the shape `{ data: record }`. TanStack Query treats initial
  data as immediately stale by default, so pass a freshness option to avoid the mount refetch.
  [Refine Next.js guide](https://refine.dev/core/docs/routing/integrations/next-js/),
  [Refine useOne](https://refine.dev/core/docs/data/hooks/use-one/#queryoptions),
  [TanStack initial data](https://tanstack.com/query/latest/docs/framework/react/guides/initial-query-data).

## 1. What a target is

The compiler's stages before printing are shared. Custom pages lower to `PageIR` (LLD-05).
Contract pages use the shared Refine scaffolder. A target supplies:

```ts
interface Target {
  name: 'vite-refine' | 'next-refine'
  files(page: LoweredPage, facts: ProjectFacts): [EmittedModule, ...PageSource[]]
  routeOps(files: readonly RouteRegistration[], anchor: RouteAnchor): Op[]
  hooks: RefineHookMap                                         // router binding differences
  preview(page: string): PreviewPlan
}
```

⚑ The target consumes a discriminated input for custom IR and shared contract source. The
Vite target continues to expose one primary module with its original shape. The shared
lowerer receives the target's Refine hook map for client route and query bindings.

## 2. File layout

```
web/
  next.config.ts               rewrites for /api, the Trivia dev wrapper
  app/layout.tsx               server: html, fonts, the theme stylesheet, <Providers>
  app/providers.tsx            "use client": <Refine> with the Next.js router binding,
                               the data provider, notifications, the resources array
  app/(app)/layout.tsx         the refine-ui shell
  app/(app)/customers/page.tsx           server entry
  app/(app)/customers/view.tsx           "use client": the page's client region
  app/(app)/customers/[id]/edit/page.tsx
  src/components/ui/           the user's shadcn components
  src/providers/data-provider.ts
```

Routes are files, so `routeOps` returns no `<Route>` insert. It still registers the resource:
a value op on the `resources` array in `app/providers.tsx`, with the same guards as the Vite
target.

## 3. Splitting server and client (FR-NX-02)

Input: the IR, with every expression's tier (LLD-03) and every node's `client` flag from its
manifest.

1. A node **needs the client** when its manifest says so, when it has an event or an exposed
   value, or when any of its props, `when` or `each` has tier `client`.
2. Client nodes that share a dependency (a state entry, an exposed value, a client-tier
   query, a handler) are joined into one group, with union-find.
3. A group's **boundary** is the lowest common ancestor of its members. A boundary inside
   another one merges into it.
4. Each boundary becomes a client module (`view.tsx`, or `view.<name>.tsx` when a page has
   several), holding that subtree with its state, queries and handlers, exactly as the Vite
   target would print it.
5. Everything above the boundaries is the server component in `page.tsx`: static nodes, and
   expressions of tier `static` and `server`, evaluated with the route's `params`,
   `searchParams` and the user.

Values cross a boundary as props, and must be serializable. A server-tier expression used
inside a client subtree is evaluated on the server and passed down under a generated prop
name. A function-valued prop that would cross is a compiler error at lowering,
`boundary_not_serializable`, with the node named.

Contract pages (`list`, `create`, `edit`, `show`) are one client region: Refine's hooks run on
the client. Their `page.tsx` is a thin server entry.

⚑ The compiler keeps the primary module API and returns sibling views in `additional`.
Each sibling passes the same parser and import checks as the entry. The MVP golden inputs
are the five spec 011 pages and model from commit `a460060`; the fixture changes only the
app target in its temporary test copy. Its list Refresh action uses Refine's existing
table query, matching the change in the sibling spec.

A page that is entirely client still gets a server `page.tsx` that renders its view. One
shape for every page is easier to read and to edit later.

## 4. Data on the server (FR-NX-03, FR-NX-04)

- A query of tier `server` (its parameters depend only on `params`, `search` and `user`) is
  awaited in `page.tsx` through the generated typed client, with the API's internal address
  from Aspire's service discovery variables. The request forwards the incoming `cookie` and
  `authorization` headers.
- The result is passed to the client region and handed to the Refine hook as initial data, so
  the first render has content and the client does not refetch at once. The option names come
  from the pinned Refine version's types, kept in `RefineHookMap`.
- For contract pages the first version prefetches `show` and `edit` (one record by id).
  Prefetching a list's first page from the search parameters is a should.
- In the browser, calls go to `/api/...` on the app's own origin. `next.config.ts` rewrites
  that path to the API. The data provider is the same file as the Vite target's.

Errors from a server fetch: a 404 calls `notFound()`. Anything else is thrown to the nearest
`error.tsx`, which the template provides.

## 5. Caching (FR-NX-05)

Nothing is cached by default: internal tools show live, per-user data. A page with
`"public": true` whose server part has no dependency on `user` or cookies gets its data
function marked for caching with a short default lifetime, and the template then enables Cache
Components. A `public` page that does depend on the user is a validation error,
`public_page_uses_user`. This is the only place the compiler emits a caching directive.

## 6. Preview

The Vite target serves previews as virtual modules. Next.js compiles files from disk, so:

- the dev service writes a draft's compiled files under `app/(blueprint-preview)/__blueprint/<Name>/`,
  a gitignored folder, outside the undo history;
- the canvas navigates to `/__blueprint/<Name>`;
- the stamping loader skips that folder, so previews carry no locators, as on Vite;
- the files are removed on eject, when the draft is deleted, and when the dev service stops.
  `withTrivia` (LLD-13) fails a production build that finds the folder, with a message that
  says to delete it.

⚑ This is the least proven part of the design. It is validated in the same spike as the
loader of LLD-13.

## 7. Template and AppHost (FR-NX-06)

`templates/next-refine/` mirrors the Vite template: App Router, Tailwind v4, `components.json`
with `rsc: true`, Refine with its Next.js router binding, the layout shell, an empty resources
array, `error.tsx` and `not-found.tsx`, and the `sync` script. The AppHost scaffold picks the
JavaScript app resource running the `dev` script when `targets.web` is `next-refine` (LLD-10).

⚑ The root layout awaits `connection()` so Refine's App Router binding can read search
parameters during request-time rendering. Static prerendering fails on the binding's
`useSearchParams()`, and wrapping the app in a streaming fallback would hide the server
content in the first HTML. [Next.js connection](https://nextjs.org/docs/app/api-reference/functions/connection).

⚑ The template reserves no root page, so a blueprint can own `/`. Its Next configuration is
shipped as `next.config.ts.template`, following the Vite template's convention. Nx would
otherwise read the dev wrapper import as a compiler dependency and form a build cycle.
The config disables Next's automatic agent-instruction file so starting the app only
writes development artifacts.

## 8. One blueprint, two targets (FR-NX-07)

Nothing in a blueprint names a target except `app.targets.web`. Target-only validation:
`public_page_uses_user` and `boundary_not_serializable` appear only for `next-refine`. A test
compiles the kit fixture and the MVP fixture for both targets from the same documents.

⚑ Validation runs a sixth layer only when the app selects `next-refine`. It reports
`invalid_next_route` at `/route` for dot segments, repeated parameter names, and
conflicting names for the same dynamic folder. The layer also accepts an injected compiler
check, so target-specific checks can use manifest and expression facts while the schema
package stays independent of the compiler.

## 9. Tests

- Boundary algorithm: unit tests on small trees (two inputs sharing state under a static
  card, a static header above a table, a fully static page, nested groups).
- Golden files for the kit and MVP fixtures on this target. `tsc` and `next build` on the
  emitted app (FR-NX-08), the build in CI only.
- Serialization: a function prop crossing a boundary is refused with the node named.
- e2e: under the AppHost with the fixture API, the show page's first HTML response already
  contains the record's fields, checked with a plain HTTP request and no JavaScript.
- Preview files: created, visible at the preview route, removed on eject and on stop.

## 10. Open points

- Streaming with `<Suspense>` around slow server queries. Left out: one awaited block per page.
- Server actions for mutations. Not used: mutations stay in Refine's hooks through the BFF
  rewrite, so both targets share handlers.
