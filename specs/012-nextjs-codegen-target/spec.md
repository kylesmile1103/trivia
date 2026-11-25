# Feature Specification: Next.js code generation target

**Feature Branch**: `012-nextjs-codegen-target`
**Created**: 2026-11-25
**Status**: Draft
**Phase**: 3
**Input**: The same blueprint compiles to a Next.js App Router app, rendering on the server
whatever the blueprint allows. (BR-10)

## User Scenarios & Testing

### User Story 1 - Emit the app for Next.js (Priority: P1)

**Independent Test**: Compile the MVP and kit fixtures with `targets.web: "next-refine"`, then
run `tsc` and `next build`.

**Acceptance Scenarios**:

1. **Given** the MVP blueprint with only `targets.web` changed, **When** it is ejected into the
   Next.js template, **Then** each page is an `app/**/page.tsx` server entry with a client
   view, the resources are registered in `app/providers.tsx`, and `tsc` and `next build` pass.
2. **Given** the Vite target's golden files before this feature, **When** the compiler is
   refactored onto the target interface, **Then** they are unchanged.
3. **Given** the same blueprint, **When** compiled for both targets, **Then** no blueprint
   document differs.

### User Story 2 - Put on the server what can be there (Priority: P1)

**Acceptance Scenarios**:

1. **Given** a custom page with a static header above a table, **When** compiled, **Then** the
   header is in the server component and only the table subtree is a client module.
2. **Given** two inputs under a static card that share a state entry, **When** compiled,
   **Then** one client boundary wraps both, at their lowest common ancestor.
3. **Given** a page with no client need at all, **When** compiled, **Then** it has no
   `"use client"` module.
4. **Given** a function-valued prop that would cross a boundary, **When** compiled, **Then**
   `boundary_not_serializable` names the node.

### User Story 3 - First response has the data (Priority: P1)

**Acceptance Scenarios**:

1. **Given** a show page whose query depends only on `params.id`, **When** its URL is fetched
   with a plain HTTP client, **Then** the HTML already contains the record's fields.
2. **Given** that page, **When** it hydrates, **Then** the client does not refetch at once.
3. **Given** a signed-in user, **When** the server fetches for them, **Then** the request to
   the API carries their cookie or bearer token.
4. **Given** an id that does not exist, **Then** the response is the app's not-found page.

### User Story 4 - One origin for the browser (Priority: P1)

**Acceptance Scenarios**:

1. **Given** the app under the AppHost, **When** the browser calls `/api/v1/customers`,
   **Then** Next.js rewrites it to the API, and the data provider is the same file as on Vite.

### User Story 5 - Cache only what is public (Priority: P2)

**Acceptance Scenarios**:

1. **Given** a page without `public: true`, **Then** no caching directive is emitted.
2. **Given** a `public` page whose server part reads `user`, **Then** validation reports
   `public_page_uses_user`.
3. **Given** a `public` page with no user dependency, **Then** its data function is cached
   with the default lifetime.

### User Story 6 - Preview drafts on Next.js (Priority: P2)

**Acceptance Scenarios**:

1. **Given** a draft page, **When** previewed, **Then** it renders at `/__blueprint/<Name>`,
   and its files are gone after eject and after the dev service stops.
2. **Given** leftover preview files, **When** `next build` runs, **Then** it fails with a
   message that says to delete them.

### Edge Cases

- A contract page (all client) still gets a server `page.tsx`.
- A route with a catch-all segment.
- A query of tier `server` that fails with a 500.
- A page whose client region needs a server-tier value: it arrives as a serializable prop.

## Requirements

Full text in `docs/blueprint/SRS.md` section 3.12: **FR-NX-01** to **FR-NX-08**.

### Key Entities

- **Target** interface. **Boundary**: a client subtree and the props that cross into it.
  **Server query**: awaited in `page.tsx` and passed as initial data.

## Success Criteria

- **SC-001**: Both fixtures compile for both targets from identical documents.
- **SC-002**: `tsc` and `next build` pass on the emitted MVP app.
- **SC-003**: The show page's first HTML response contains its record, with JavaScript off.
- **SC-004**: The Vite golden files are byte-identical before and after the refactor.

## Assumptions and out of scope

- Refine with its Next.js router binding (⚑ ADR-0009). Mutations stay in Refine hooks, not
  server actions.
- No streaming with `<Suspense>` in the first version.
- Editing Next.js apps in the designer is spec 013.
