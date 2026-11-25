# LLD-10: Aspire solution and the contract loop

- Spec: `specs/010-aspire-solution-contract-loop` · Requirements: FR-AS-01 to FR-AS-09 · ADR-0012
- Code: scaffold files in `dotnet/src/Trivia.Blueprint.Codegen/Scaffold/` (AppHost,
  ServiceDefaults, MigrationService); the data provider and dev proxy in the web templates of
  `packages/blueprint-compiler/templates/`; orchestration in the `trivia-blueprint` CLI.

Aspire's API is still moving. The snippets show intent. Check method names against the Aspire
13.x documentation and pin the version before writing the scaffold files.

## 1. The solution

```
<App>.slnx
src/<App>.AppHost/            Program.cs: the resource graph
src/<App>.ServiceDefaults/    OpenTelemetry, health checks, service discovery, resilience
src/<App>.MigrationService/   a worker that applies EF Core migrations, then exits
src/<App>.Api/                LLD-09
web/                          the React app (LLD-05, LLD-12)
```

All of these are scaffold files: written once by `trivia-dotnet write`, then the developer's.

### AppHost (FR-AS-01, FR-AS-02)

```csharp
var builder = DistributedApplication.CreateBuilder(args);

var postgres = builder.AddPostgres("postgres").WithDataVolume();
var db = postgres.AddDatabase("appdb");

var migrations = builder.AddProject<Projects.BackOffice_MigrationService>("migrations")
    .WithReference(db).WaitFor(db);

var api = builder.AddProject<Projects.BackOffice_Api>("api")
    .WithReference(db).WaitForCompletion(migrations);

builder.AddViteApp("web", "../../web")          // the Next.js target uses the JavaScript app resource
    .WithReference(api).WaitFor(api);

builder.Build().Run();
```

`aspire run` (or `dotnet run` in the AppHost) starts PostgreSQL in a container, applies
migrations, starts the API, then the web dev server, and opens the dashboard with logs, traces
and metrics from ServiceDefaults.

### MigrationService

A hosted service that calls `Database.MigrateAsync()` inside an execution strategy, records a
trace, and stops the host. The API waits for it to complete. The API never migrates on start.

## 2. The web app's side

### Dev proxy (FR-AS-07)

Aspire passes the API's address to the web app as service discovery variables
(`services__api__https__0`, else `services__api__http__0`). The Vite template's config proxies
`/api` to it, so the browser calls its own origin and no CORS policy is needed. Without those
variables (the web app started alone) it falls back to `API_URL`, then to a clear error on the
first request.

### Data provider (FR-AS-06)

`web/src/providers/data-provider.ts`, a scaffold file of about 150 lines with no dependency
beyond `@refinedev/core`. It implements Refine's `DataProvider` for LLD-09 section 4:

| Refine | API |
| --- | --- |
| `getList` with pagination, sorters, filters | `GET /api/v1/<resource>?page&pageSize&sort&filter…`, returning `items` and `total` |
| `getOne`, `create`, `update`, `deleteOne` | The matching route. `update` is `PUT` |
| `getMany` | `filter=id:in:<ids>` |
| `custom` | The given method and URL, under `/api/v1` |
| Filter operators | `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `contains`, `startswith`, `in`, `null` map one to one. Others throw a clear error |
| Errors | Problem details become Refine's `HttpError`, with `errors` mapped onto form fields |

A Refine resource's `name` is the entity's plural (`customers`), which is also the path
segment and what the Refine adapter matches to the contract's base path.

The typed client that contract-sync generates is still produced, for custom pages, custom
operations and types. The data provider itself uses plain `fetch`, because Refine's interface
is generic over the resource name.

## 3. The contract loop (FR-AS-04, FR-AS-05, FR-AS-08)

```
1. trivia-dotnet write            model -> *.g.cs
2. trivia-dotnet migrate <Name>   when the schema changed
3. dotnet build                   -> web/openapi/api.openapi.json
4. pnpm sync (in web/)            -> src/api/generated, trivia.manifest.json
5. contract drift                 -> a fix per page that no longer matches
```

- **Step 3.** The API project sets the build-time OpenAPI generation properties (the
  `Microsoft.Extensions.ApiDescription.Server` package: output directory `../../web/openapi`,
  file name `api.openapi.json`). The document is committed, so the frontend builds without the
  backend, and a review shows contract changes as a diff.
- **Step 4.** The template's `sync` script runs contract-sync on that file with zod output.
  The document's operation ids, tags, schema names and list shape (LLD-09) are chosen so the
  manifest's resources, operations and pagination come out without overrides. A test asserts
  it: the fixture model's OpenAPI document, through contract-sync, gives a manifest with one
  resource per entity, all five operations, `listItemsPath: "items"` and page pagination.
- **Step 5.** Nothing new: `GET /@trivia/api/refine/drift` and `trivia_contract_drift`.

`trivia-blueprint backend [--migration <Name>]` runs steps 1 to 4 in order, stops at the first
failure, and prints the drift summary. For agents, `trivia_blueprint_backend` covers steps 1
and 2, and its result's `next` field names the rest: build, then `trivia_sync_openapi`, then
`trivia_contract_drift`. The build is not hidden inside a tool, because it can take minutes
and its errors belong to the developer's terminal.

## 4. First run of a new app

```
trivia-blueprint new backoffice        template + empty blueprint
(author the model and pages)           designer, agent or hand
trivia-blueprint backend --migration Initial
trivia-blueprint eject                 pages, resources, routes
aspire run
```

Pages for model entities validate only after step 4 of the loop has produced the contract
(LLD-08 section 6), so the backend comes before eject. The CLI's `eject` says so when it
meets `unknown_resource`.

## 5. Publishing (FR-AS-09, should)

The AppHost includes a Docker Compose environment, so `aspire publish` writes a compose file
with PostgreSQL, the migration job, the API and the web app (static files behind a small web
server for the Vite target, a Node container for Next.js). It is verified by a test that runs
the publish and checks the compose file parses and names all four services. Kubernetes and
Azure targets are Aspire's own features and need no work here.

## 6. Tests

- A build test: `trivia-dotnet write` on the fixture, then `dotnet build` of the whole
  solution, AppHost included.
- An Aspire integration test (`Aspire.Hosting.Testing`): start the AppHost without the web
  app, wait for the API to be healthy, exercise CRUD through its HTTP client. Needs a container
  runtime, so it carries a trait and runs in CI and before a release.
- The contract test of step 4.
- The data provider against the API in that same integration run, through a small Node script:
  list with paging, sorting and each filter operator, one validation error mapped to fields.
- The dev proxy: a unit test of the config function with and without the variables.

## 7. Open points

- A C# AppHost or the TypeScript AppHost that Aspire 13.4 made generally available. C# for
  now, since the solution is .NET anyway.
- Where the committed OpenAPI document should live if the web app is not a sibling folder.
  It can become a setting of the app document later.
