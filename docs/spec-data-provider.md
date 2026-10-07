# Trivia — Data Provider Brief (original, 2026-10-07)

This is the user's brief for the data provider and contract sync subsystem, kept verbatim in
substance. The user presented it as recommendations, open to pushback. The corrections below
were verified against `references/openapi-ts` (`@hey-api/openapi-ts` 0.99.0, the current npm
release) and win over the brief. The design doc is `docs/data-provider.md`.

## Corrections to the brief

1. **No `oxc_codegen` serialization.** Hook injection and prop binding use span splicing
   (CLAUDE.md rule 1), like every other engine op.
2. **The "after injection" example is garbled.** `columns="{columns}"` should be
   `columns={columns}`, and `<DataTable ?? []} …` is broken. It also writes `data-ast-node` to
   disk; that attribute is injected at dev time only and must never reach source.
3. **hey-api facts.**
   - `createClient` is the programmatic API.
   - The SDK file is `sdk.gen.ts`, not `services.gen.ts`.
   - Option names are `{{name}}Options` / `{{name}}Mutation` (camelCase), e.g.
     `listCustomersOptions`, `createCustomerMutation`.
   - The fetch client is bundled into the generated output, so user code needs no `@hey-api/*`
     runtime package.
   - Swagger 2.0, OpenAPI 3.0 and 3.1 inputs are all supported.
4. **Deterministic manifest.** No `generatedAt`; use a hash of the schema.
5. **Supabase/PostgREST.**
   - It serves Swagger 2.0.
   - It has no `/{id}` item paths: CRUD runs on the collection with row filters (`id=eq.1`), and
     a single-row GET uses `Accept: application/vnd.pgrst.object+json`.
   - The adapter maps this explicitly instead of reusing the REST item-path heuristic.
6. **The manifest records what the binder needs.** That means `listItemsPath` (`items`, `data`,
   or a bare array) and the real id parameter name. Its function names are reconciled against
   what the code generator actually exports, including operations that have no `operationId`.
7. **GraphQL is deferred.** `@graphql-codegen/typescript-react-query` is superseded by the
   client preset, and the hook shapes differ.
8. **shadcn ships neither `ui/data-table` nor AutoForm.** DataTable is a docs pattern on
   TanStack Table (now v9, while the shadcn guide targets v8). Trivia has to generate the
   component and its columns.

---

## Brief

### Goal

Design and implement the **Data Provider Subsystem**: the single source of truth for data
binding, schema discovery and contract sync. It replaces NetEase Tango's `@tangojs/boot` and
rejects Refine's runtime `dataProvider`. It is a **zero-runtime-lock-in contract pipeline** built
on OpenAPI 3.1, `@hey-api/openapi-ts`, `@tanstack/react-query` v5 and the Rust/OXC engine.

### Decision records

- **`@tangojs/boot` is banned.** Its imperative runtime (`defineServices`, `defineStores`, `run`)
  meant exported code couldn't run without it. Trivia's generated code uses no proprietary
  runtime packages: vanilla React 18/19, TypeScript and `@tanstack/react-query`.
- **Refine's runtime `dataProvider` is rejected.** Its generic REST resource model
  (`getList`/`create`) breaks typed, operation-centric backends such as
  `POST /api/v1/customers/{id}/approve-kyc`, and it needs root wrappers (`<Refine>`, providers).
  Trivia keeps only the idea of a **static resource manifest** (`trivia.manifest.json`).
- **Typed contract-to-AST compilation.**
  1. An OpenAPI spec (file or URL) is the source of truth.
  2. `@hey-api/openapi-ts` (fetch client and TanStack Query plugins) generates types, a client
     and query/mutation option factories into `src/api/generated/`.
  3. A build-time scanner generates `trivia.manifest.json`, splitting endpoints into CRUD and
     custom RPC operations.
  4. Binding a UI element on the canvas makes the engine write idiomatic `useQuery`/`useMutation`
     hooks into the `.tsx`.

### Layout

- `crates/…_engine/src/data_binder.rs`: injects TanStack Query hooks and imports.
- `packages/trivia-contract-sync/`:
  - `index.ts`, `codegen.ts`, `manifest-generator.ts`;
  - `adapters/rest-adapter.ts`, `adapters/supabase-adapter.ts`.
- Designer:
  - `data-explorer/` with `ResourceTree.tsx`, `OperationCard.tsx`, `SchemaViewer.tsx`;
  - `bridge/data-contract-client.ts`.

### Phase 1: contract sync and codegen

`runContractSync({ input, outputDir, client? })` calls `createClient` with the plugins
`[client ?? "@hey-api/client-fetch", "@tanstack/react-query"]`. Output must be deterministic and
include:
- types;
- core fetch functions;
- `@tanstack/react-query.gen.ts` option factories (`listCustomersOptions`,
  `getCustomerByIdOptions`, `createCustomerMutation`, …).

### Phase 2: static resource manifest

`trivia.manifest.json` lists resources. Each resource has:
- `name`, `tag`, `schemaRef`, `primaryKey`;
- `operations` (`list` with pagination info, `get`, `create`, `update`, `delete`), each with
  `operationId`, a function name, method, path, parameters and payload ref;
- `customOperations` (e.g. `approveKyc`);
- optional `views`.

Classification heuristics:
- Group by `x-trivia-resource`, then `tags[0]`, then path prefix.
- `list`: GET returning an array, or an object with an `items`/`data` array.
- `get`: GET on `/{id}`.
- `create`: POST on the collection.
- `update`: PUT/PATCH on the item.
- `delete`: DELETE on the item.
- Anything else goes to `customOperations`.

### Phase 3: data binder in Rust/OXC

Binding e.g. a `DataTable` to `Customer.operations.list` produces these edits:
1. Find the enclosing component.
2. Insert
   `const { data: customerData, isLoading: isCustomerLoading } = useQuery({ ...listCustomersOptions({ query: { page: 1, pageSize: 20 } }) })`
   at the top of its body, unless an equivalent hook already exists.
3. Ensure `import { useQuery } from "@tanstack/react-query"` and
   `import { listCustomersOptions } from "@/api/generated/@tanstack/react-query.gen"`.
4. On the element, set `data={customerData?.items ?? []}` (or the field the schema determines)
   and `isLoading={isCustomerLoading}`.
5. Write atomically so Vite hot-reloads.

### Phase 4: adapters

- **REST** (ASP.NET Core, Spring, FastAPI, …): point at the OpenAPI/Swagger JSON and run phases
  1–2.
- **Supabase:** fetch PostgREST's OpenAPI from `GET https://<ref>.supabase.co/rest/v1/?apikey=…`
  and generate typed hooks without `@supabase/supabase-js`.
- **GraphQL** (bridge): `@graphql-codegen/typescript-react-query` writes to the same directory
  (deferred; see corrections).

### Designer integration

A Data Explorer drawer:
- A resource tree built from the manifest.
- Drag-to-bind:
  - drop a resource as a DataTable (list) or AutoForm (create/edit), which injects the component,
    its columns and the hook;
  - drop a field into a container, which renders a connected `<Input {...field} />`.
- Contract drift: watch the spec, and badge canvas elements whose bindings point at renamed or
  removed fields.

### Acceptance

1. **Codegen.** A Customer CRUD + `/approve-kyc` OpenAPI 3.1 fixture generates code with zero
   `tsc --noEmit` errors, and `/approve-kyc` lands in `customOperations` in the manifest.
2. **Binder.** For an unbound `<DataTable />`, `bind_query_to_element` adds both imports, adds
   the hook as the first statement, and adds `data={customerData?.items ?? []}` and
   `isLoading={isCustomerLoading}`. Comments, formatting and surrounding JSX are preserved.
3. **Runtime independence.** The template's `package.json` has no `@tangojs/boot` or
   `@refinedev/core`. The only data-fetching runtime allowed is `@tanstack/react-query`.
