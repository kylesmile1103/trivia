# Data provider: contract sync and the resource manifest

Status: implemented in `packages/trivia-contract-sync` (`@trivia/contract-sync`). The Rust data
binder (`bind_query`) is specified here and implemented separately. The brief and its verified
corrections are in `docs/spec-data-provider.md`.

## The idea

The API contract (OpenAPI 3.0/3.1 or Swagger 2.0) is the source of truth. Trivia never adds a
runtime of its own to the user's app:

- **Codegen.** [`@hey-api/openapi-ts`](https://heyapi.dev) **0.99.0** (pinned exactly) writes
  typed fetch functions and TanStack Query v5 option factories into the user's
  `src/api/generated/`.
- **Manifest.** `trivia.manifest.json` is a static, deterministic index of resources and
  operations. It records the exact names hey-api exported, so the designer and the binder never
  have to read the spec or guess at names.
- **Binding.** The Rust engine writes ordinary `useQuery` / `useMutation` code that uses those
  factories. It edits by span splicing, never by reprinting (CLAUDE.md rule 1).

```
spec (file | URL | Supabase)
  └─ adapters ── load JSON/YAML, or fetch PostgREST's Swagger 2.0 from <project>/rest/v1/
       ├─ codegen ── hey-api into a staging dir next to src/api/generated
       │     plugins: @hey-api/client-fetch, @hey-api/typescript, @hey-api/sdk, @tanstack/react-query
       │     verify: required files present, imports limited to ./ ../ @tanstack/react-query
       ├─ manifest ── classify the RAW spec, then read names back from the STAGED code
       │     fail loudly on any mismatch → nothing in the project changes
       └─ commit ── swap the staged dir into place (rename), write trivia.manifest.json (rename)
```

## Usage

```sh
pnpm --filter @trivia/contract-sync build
trivia-contract-sync --input openapi/customers.openapi.json            # → src/api/generated, trivia.manifest.json
trivia-contract-sync --input https://api.example.com/openapi.json --output src/api/generated
trivia-contract-sync --supabase-url https://<ref>.supabase.co --supabase-key "$SECRET"   # or TRIVIA_SUPABASE_KEY
trivia-contract-sync --input spec.yaml --cwd ../my-app --import-alias '~/=app'
```

Exit codes: 0 ok, 1 failure (`error[<code>]: <message>` plus `hint: …`), 2 usage error.

Programmatic API (`src/index.ts`):

| Function | Does |
|---|---|
| `runContractSync({ input, outputDir, client?, cwd?, excludeOperations?, headers? })` | Codegen only. Returns `{ outputDir, files, modules: { queries, sdk, types, client, index }, spec, source }`. |
| `generateManifest(spec, { schemaSource, generatedDir, importBase?, projectRoot?, style?, excludeOperations?, client? })` | Manifest from a raw spec and already-generated code. Pure; it doesn't write. |
| `syncContract({ input \| supabase, outputDir?, manifestPath?, cwd?, importBase?, … })` | The full, all-or-nothing pipeline the CLI runs. |
| `loadSpec(pathOrUrl)`, `fetchSupabaseSpec({ url, key })` | The adapters. |

`client` accepts only `@hey-api/client-fetch` (default) and `@hey-api/client-next`. In 0.99.0
these are the only bundled clients that import no third-party package; axios, ky, ofetch, nuxt
and angular all do (checked in `dist/clients/*`). Anything else is refused.

## What gets generated

hey-api 0.99.0 writes 17 files: `types.gen.ts`, `sdk.gen.ts`, `client.gen.ts`, the bundled
client in `client/` and `core/`, `@tanstack/react-query.gen.ts` and `index.ts`.

- **GET operations** get `{{name}}Options` and `{{name}}QueryKey`. They also get
  `{{name}}InfiniteOptions` and `{{name}}InfiniteQueryKey` when hey-api finds a pagination
  keyword (`after`, `before`, `cursor`, `offset`, `page`, `start`).
- **Other methods** get `{{name}}Mutation`.
- **`{{name}}`** is the camelCased `operationId`. Without one, hey-api derives it from the method
  and path: `GET /orders/{orderNumber}` becomes `getOrdersByOrderNumber`. Duplicates get numeric
  suffixes in encounter order. That is why the manifest reads the names back from the generated
  code instead of re-deriving them.

## The manifest

The schema is `packages/trivia-contract-sync/manifest.schema.json`
(`$id: https://trivia.dev/schemas/manifest.v1.json`, JSON Schema 2020-12), mirrored by
`src/manifest-types.ts`. Every generated manifest in the tests validates against it, using ajv in
strict mode. Excerpt (trimmed) from the customers fixture:

```json
{
  "$schema": "https://trivia.dev/schemas/manifest.v1.json",
  "manifestVersion": 1,
  "generator": { "name": "@trivia/contract-sync", "version": "0.1.0", "heyApi": "0.99.0",
                 "plugins": ["@hey-api/client-fetch", "@hey-api/typescript", "@hey-api/sdk", "@tanstack/react-query"] },
  "source": { "location": "openapi/customers.openapi.json", "format": "openapi-3.1", "specVersion": "3.1.0",
              "title": "Customer API", "apiVersion": "1.4.0", "style": "rest", "excludedOperations": [] },
  "schemaHash": "sha256:d3bd9e5e290edb63e306cd12f7ecc164e5544be43778bc5e91e78cd8bafb80dc",
  "modules": {
    "outputDir": "src/api/generated",
    "queries": { "file": "src/api/generated/@tanstack/react-query.gen.ts",
                 "importPath": "@/api/generated/@tanstack/react-query.gen" }
  },
  "resources": [{
    "name": "Customer", "groupedBy": "tag", "tag": "Customers", "style": "rest",
    "basePath": "/api/v1/customers", "itemPath": "/api/v1/customers/{id}", "primaryKey": "id",
    "entity": { "schemaRef": "#/components/schemas/CustomerDto", "typeName": "CustomerDto", "fields": [
      { "name": "status", "type": "string", "format": null, "required": true, "nullable": false, "readOnly": false,
        "enum": ["pending", "active", "suspended"], "ref": "#/components/schemas/CustomerStatus",
        "items": null, "description": null }
    ] },
    "operations": {
      "list": {
        "kind": "list", "method": "GET", "path": "/api/v1/customers", "operationId": "listCustomers",
        "sdkFn": "listCustomers", "queryOptionsFn": "listCustomersOptions", "queryKeyFn": "listCustomersQueryKey",
        "infiniteQueryOptionsFn": "listCustomersInfiniteOptions", "infiniteQueryKeyFn": "listCustomersInfiniteQueryKey",
        "mutationFn": null,
        "parameters": [{ "name": "pageSize", "in": "query", "required": false, "type": "integer",
                         "format": null, "enum": null, "default": 20 }],
        "response": { "status": "200", "contentType": "application/json",
                      "schemaRef": "#/components/schemas/CustomerPage", "isArray": false },
        "listItemsPath": "items",
        "pagination": { "style": "page", "pageParam": "page", "pageSizeParam": "pageSize", "limitParam": null,
                        "offsetParam": null, "cursorParam": null, "totalPath": "total", "nextCursorPath": null },
        "postgrest": null
      },
      "get": { "kind": "get", "path": "/api/v1/customers/{id}", "queryOptionsFn": "getCustomerByIdOptions",
               "idParam": "id" },
      "create": { "kind": "create", "mutationFn": "createCustomerMutation" },
      "update": { "kind": "update", "mutationFn": "updateCustomerMutation", "idParam": "id" },
      "delete": { "kind": "delete", "mutationFn": "deleteCustomerMutation", "idParam": "id" }
    },
    "customOperations": [{ "kind": "custom", "method": "POST", "path": "/api/v1/customers/{id}/approve-kyc",
                           "sdkFn": "approveCustomerKyc", "mutationFn": "approveCustomerKycMutation" }]
  }]
}
```

Fields by level:

- **Resource:** `name` is PascalCase and singular; binders derive identifiers from it.
  `operations` always has all five slots (`null` when absent). `customOperations` are sorted by
  path, then method.
- **Operation, every kind:** method, path, `operationId` (`null` when the spec has none), the six
  function names (each `null` when not generated), `parameters` (with spec `default`s),
  `requestBody`, and `response` (the lowest 2xx that has a body).
- **`list` only:** `listItemsPath` (the property that holds the rows, or `null` for a bare array)
  and `pagination`.
- **`get`, `update`, `delete`:** `idParam`, the real path parameter or PostgREST filter column.
  It is not always `id`.
- **PostgREST operations:** a `postgrest` block (see below).
- **Entity fields:** name, type, format, required, nullable, readOnly, enum, ref, item summary,
  description and `default`. These let the designer build columns and forms without the spec.

## Heuristics

All classification reads the **raw** spec (Swagger 2.0 `definitions`, `in: body`, response
`schema`; OpenAPI 3.x `components`, `requestBody`, response `content`). Local `$ref`s are
resolved one hop at a time with a visited set, so `A → B → A` fails with `ref_cycle`.
Self-referencing schemas (`LineItem.components: LineItem[]`) are fine. External refs fail with
`unsupported_ref`; bundle the spec first.

**Grouping.** Precedence is `x-trivia-resource` (on the operation or path item; must be an
identifier) > `tags[0]` > the first static path segment after `api`/`rest`/`vN`. Groups whose
keys differ only in spelling merge: `Customers` (tag), `customers` (path) and
`customer-controller` (springdoc). Two groups that end up with the same name fail with
`classification_conflict`; use `x-trivia-resource` to separate them.

**Naming.** The name comes from `x-trivia-resource` if set. Otherwise it comes from the entity
schema, with `Dto`/`Model`/`Entity`/`Response`/… stripped (`CustomerDto` → `Customer`).
Otherwise it is the singularized tag or path key (`orgs` → `Org`). The singularizer is a small
rule set, not English; override it with `x-trivia-resource`.

**Classification (REST).** The base path is the collection that the most CRUD-shaped operations
hang off. Ties go to the shorter path, then lexicographic order. The item path is
`<base>/{param}`. Then:

- `list`: GET on the base whose response is an array, or an object with an array property.
  Preferred names are `items`, `data`, `results`, `records`, `rows`, `content`, `list`,
  `entries`, `values`; otherwise the only array property. `allOf` envelopes are merged.
- `get`: GET on the item path.
- `create`: POST on the base.
- `update`: PUT, else PATCH, on the item path. When both exist, PUT wins and PATCH becomes
  custom.
- `delete`: DELETE on the item path.
- Everything else is custom: `POST /customers/{id}/approve-kyc`, non-list GETs,
  sub-collections.

**Pagination.** Query parameters are matched case-insensitively:

- page: `page`, `pageNumber`, …
- pageSize: `pageSize`, `per_page`, `size`, …
- limit: `limit`, `take`, `$top`, …
- offset: `offset`, `skip`, `start`, …
- cursor: `cursor`, `after`, `pageToken`, …

The style is `cursor`, else `page`, else `offset`, else `limit`. `totalPath` is a numeric
`total`/`totalCount`/`count`/… property of the list response. `nextCursorPath` is a string
`nextCursor`/`nextPageToken`/… property, recorded only for cursor pagination.

**Entity and primary key.**

- **Entity:** the single-item response if there is one, else the list item, else the create
  response, else the update response, else the create body.
- **REST primary key:** the entity field named like `idParam`. For a `customerId`-style parameter
  it falls back to `id`.
- **Nullability:** OpenAPI 3.1 `type: [..., "null"]`, `anyOf`/`oneOf` with `{type: null}`,
  OpenAPI 3.0 `nullable: true`, Swagger `x-nullable`, or `null` in an enum.

**Reconciliation (fail loudly).**

- Each operation's `METHOD path` must match exactly one SDK function in `sdk.gen.ts`.
- The query, key, infinite and mutation factories are whatever `@tanstack/react-query.gen.ts`
  exports that call that SDK function. The file is parsed with the TypeScript parser.
- Every generated SDK function and hook must belong to some manifest operation.
- A list's `listItemsPath` must be an array in every 2xx member of the generated response union.
- An entity with a `$ref` must map to a type exported by `types.gen.ts`.

## Adapters

**REST** (`adapters/rest-adapter.ts`). Takes a file path, `file:` URL or http(s) URL, in JSON or
YAML. YAML uses js-yaml 4.2.0 (the parser hey-api itself uses) with the YAML 1.2 core schema plus
merge keys, so `2024-01-01` stays a string. Errors:

- `input_not_found`, `input_unreadable`
- `input_parse_failed`, with js-yaml's line and column
- `input_invalid` (not an API description), `unsupported_spec` (Swagger 1.x, OpenAPI 4)
- `http_error`: the status line plus up to 300 characters of the body
- `network_error`: includes the underlying cause, such as `ENOTFOUND` or a timeout

Query strings are redacted from every message.

**Supabase** (`adapters/supabase-adapter.ts`). Fetches `GET <project>/rest/v1/`.

- **Headers.** New `sb_secret_…`/`sb_publishable_…` keys go only on `apikey`, because they are
  not JWTs (Supabase API-keys guide). Legacy JWT keys also go on `Authorization: Bearer`.
- **Key restriction.** Supabase now serves the OpenAPI document only to secret or service_role
  keys. New projects were blocked from 2026-03-11 and all projects from 2026-04-08
  ([changelog 42949](https://supabase.com/changelog/42949-breaking-change-removing-access-to-openapi-spec-via-the-anon-key)).
- **Errors.** A refusal reports the exact status plus Supabase's own `message` and `hint`. For
  401/403 it adds the key-restriction note above. Other statuses are reported as they are, with
  no guessed explanation. Keys never appear in messages or in the manifest.

**PostgREST mapping** (any spec with `rowFilter.*` parameters, so a downloaded file works too).
PostgREST has no `/{id}` paths. The facts below come from PostgREST v12.2.3
`src/PostgREST/Response/OpenAPI.hs`:

- table reads, inserts, updates and deletes all run on `/<table>`;
- rows are selected with `?<col>=eq.<v>`;
- `required` lists exactly the NOT NULL columns;
- the primary key is marked `<pk/>` in the column description;
- functions live under `/rpc/<name>` with the tag `(rpc) <name>`.

The manifest says this honestly:

- **`list` and `get` are the same GET.** `get.postgrest.rowFilter` is
  `{ param: "id", template: "eq.{value}" }`. `singleObjectAccept` names
  `application/vnd.pgrst.object+json`, and `response.isArray` stays `true`, because the declared
  and generated type is still the row array.
- **`update` (PATCH) and `delete` carry `filterRequired: true`.** Without the filter, PostgREST
  touches every visible row.
- **Writes record `returnRepresentation`** when the operation declares `Prefer:
  return=representation`.
- **Classification needs a single `<pk/>` column.** Without one, only `list`/`create` are
  classified; PATCH/DELETE become custom. `/rpc/*` operations become custom operations of an
  `Rpc` resource.
- **Two normalizations apply, only to the copy hey-api sees** (`schemaHash` and classification
  use the original):
  - `GET /` (PostgREST's introspection endpoint) is excluded.
  - A schema-less `206 Partial Content` gets its 200's row-array schema. Otherwise hey-api types
    the read as `Array<Row> | unknown`, which collapses to `unknown`.
- **Exclusions are applied by removing operations, not with hey-api's filter.** In 0.99.0,
  `parser.filters.operations.exclude` also prunes unrelated Swagger 2.0 operations that share
  `#/parameters/*` refs. On PostgREST, excluding `GET /` left only `getRpcApproveKyc`.

## Determinism

Same input bytes produce the same output bytes. The tests check this by running in two different
project directories and comparing every generated file and the manifest. Also:

- The manifest has no `generatedAt`. `schemaHash` is the sha256 of the canonical JSON (sorted
  keys, no whitespace), so JSON and YAML of the same spec hash the same.
- Resources are sorted by name and custom operations by path and method. Fields and parameters
  keep spec order, because column order is meaningful.
- **No cwd config leaks in.** hey-api loads `openapi-ts.config.*` from `process.cwd()` and
  deep-merges it into programmatic options (verified: a config there changed the file suffix and
  header). Contract sync points hey-api's `configFile` at an empty config it ships, which stops
  that discovery. It refuses to run if `.openapi-tsrc` (still read by c12) or
  `HEY_API_DUMP_REGISTRY` (adds a file) is present.
- **No tsconfig or formatter influence.** `tsConfigPath: null` and `postProcess: []` are set
  explicitly.
- Paths in the manifest are project-relative POSIX paths. A spec outside the project root is
  recorded by absolute path. That is honest, but machine-specific, so keep specs in the repo.

## Runtime independence

Generated and bound user code imports nothing at runtime except `@tanstack/react-query`:

- **Every run** parses every generated file's import, export-from and dynamic-import specifiers.
  It fails (`runtime_dependency`) on anything that isn't relative or `@tanstack/react-query`.
  hey-api's fetch client is bundled (`client/`, `core/`), so no `@hey-api/*` package is needed.
- **Tests** re-check the specifiers with an independent reader. They also assert that
  `examples/playground/package.json` has no `@tangojs/boot`, no `@refinedev/*`, and no
  `@trivia/*` runtime dependency.
- **The app** needs the standard TanStack setup once (`QueryClientProvider` at the root) and
  `client.setConfig({ baseUrl, headers })` from `client.gen`. For Supabase that means the
  publishable key in `apikey`; never ship a secret key to the browser.
- **Type check:** the tests run the real `tsc --noEmit` over the generated code plus
  binder-shaped consumer components (below). They use the playground's compiler options plus
  `strict` and `noUncheckedIndexedAccess`, and require zero errors for all three fixtures. A
  negative control proves the check isn't vacuous.

## Rust data binder contract

Another builder implements `bind_query` in `crates/trivia_oxc_engine`. Inputs:

- the manifest;
- a resource name and operation kind;
- the target element's locator and expected element name (CLAUDE.md rule 4);
- optional initial query values.

All edits are span splices. Generated text is limited to new fragments, indented to match their
surroundings. Re-parse the result and refuse to write on any diagnostic.

**Derived names.** `Name` = `resource.name` and `name` = `Name` with a lower-case first letter:
`customerData`, `isCustomerLoading`, `customerRows`. If a name is already bound in the
component's scope, pick a unique one or fail. Never shadow.

**Imports** (CLAUDE.md rule 9: add or merge only what the op uses):

- `import { useQuery } from '@tanstack/react-query'`, merged into an existing import from that
  module;
- `import { listCustomersOptions } from '<modules.queries.importPath>'`. When `importPath` is
  `null`, use a relative path from the edited file to `modules.queries.file`, without `.ts`.

**List binding.** Insert this as the first statement of the enclosing component's body, unless a
`useQuery` that spreads the same `queryOptionsFn(...)` already exists. When its arguments read the
component's own locals, insert it right after the last statement declaring them instead, and refuse
when that would put it after an early `return` or after the bound element:

```tsx
const { data: customerData, isLoading: isCustomerLoading } = useQuery({ ...listCustomersOptions({ query: { page: 1, pageSize: 20 } }) })
```

Set the target element's props:

```tsx
<DataTable data={customerData?.items ?? []} isLoading={isCustomerLoading} />
```

- `items` is `listItemsPath`. When it is `null` (a bare array), write `data={customerData ?? []}`.
- **Initial query values come from `pagination`:**
  - `page`: `{ [pageParam]: default ?? 1, [pageSizeParam]: default ?? 20 }`
  - `offset`: `{ [limitParam]: default ?? 20, [offsetParam]: default ?? 0 }`
  - `cursor` and `limit`: the limit or page-size parameter only
  - no pagination: no argument
- Take each `default` from the matching entry in `parameters`. Write a numeric literal when the
  parameter type is `integer`/`number`, and a string otherwise: PostgREST's `limit`/`offset` are
  strings (`limit: '20'`).
- If the operation has a required parameter the binder can't fill (`required: true`, no
  `default`), refuse with a clear error rather than emit code that doesn't type-check.

**Single row.**

- REST: `useQuery({ ...getCustomerByIdOptions({ path: { [idParam]: value } }) })`.
- PostgREST: `useQuery({ ...getCustomersOptions({ query: { [rowFilter.param]: \`eq.${value}\`, limit: '1' } }) })`
  and read `data?.[0]`. This is type-safe. Sending `singleObjectAccept` instead returns an
  object at runtime while the static type stays an array, so don't combine the two.

**Mutations.**

- Create a hook with `const createCustomer = useMutation({ ...createCustomerMutation() })`.
- Call `createCustomer.mutate({ body })`. For REST item ops add `path: { [idParam]: v }`.
- For PostgREST, call `mutate({ query: { [param]: \`eq.${v}\` }, body, headers: { Prefer: 'return=representation' } })`.
  Never emit an update or delete without the row filter (`filterRequired`).
- After success, invalidate with `queryClient.invalidateQueries({ queryKey: listCustomersQueryKey() })`.
  hey-api keys are `[{ _id, baseUrl, … }]`, and TanStack matches object keys partially, so this
  covers every page and infinite query.

`packages/trivia-contract-sync/test/helpers.ts` (`writeBinderConsumers`) emits exactly these
shapes from the manifest. `tsc` must accept them for every fixture, so it is the binder's
executable reference.

## GraphQL: out of scope

GraphQL Code Generator's [`typescript-react-query`](https://the-guild.dev/graphql/codegen/docs/plugins/typescript-react-query)
plugin lives in the community repo. Checked 2026-10-07, it is still published (7.0.5) and is
**not formally deprecated**. Its docs say "We now recommend using the `client-preset`". The brief
called it "deprecated in favor of the client preset"; "superseded" is accurate. Either way, the
binder can't treat GraphQL like REST:

- **The plugin emits wrapper hooks** (`useGetCustomersQuery(variables, options)`), not
  `queryOptions` factories to spread into `useQuery`.
- **The client preset emits typed documents** (`graphql(...)` returning a `TypedDocumentNode`).
  The app then writes its own `queryKey`/`queryFn` and needs a GraphQL request function at
  runtime.
- **GraphQL has no CRUD vocabulary in paths and methods.** A manifest would need a different
  classifier: queries versus mutations, connection types, `nodes`/`edges`.

A GraphQL bridge needs its own binder shape and manifest section, so it is deferred.

## Known limitations

- External `$ref`s aren't followed (`unsupported_ref`); bundle first.
- PostgREST marks NOT NULL columns `required` even when they have defaults (`id` with
  `gen_random_uuid()`), so the generated insert body type requires them. Fields carry `default`
  so forms can treat them as optional, but the static type still asks for them.
- Composite primary keys aren't classified as item operations.
- `@hey-api/openapi-ts` 0.99.0 declares `engines.node >= 22.18`. The repo's node 22.16 runs it
  (its runtime check needs only Node 20+), but pnpm may warn.
