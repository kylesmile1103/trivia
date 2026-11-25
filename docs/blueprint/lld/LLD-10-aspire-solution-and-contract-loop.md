# LLD-10: Aspire solution and the contract loop

- Spec: `specs/010-aspire-solution-contract-loop` · Requirements: FR-AS-01 to FR-AS-09 · ADR-0012
- Code: scaffold files in `dotnet/src/Trivia.Blueprint.Codegen/Scaffold/` (AppHost,
  ServiceDefaults, MigrationService); the data provider and dev proxy in the web templates of
  `packages/blueprint-compiler/templates/`; orchestration in the `trivia-blueprint` CLI.

## Verified dependencies

⚑ Pin the C# AppHost SDK, `Aspire.Hosting.AppHost`, `Aspire.Hosting.PostgreSQL`,
`Aspire.Hosting.JavaScript`, `Aspire.Hosting.Docker` and `Aspire.Hosting.Testing` to
**13.6.5**. The Aspire CLI used for verification is also 13.6.5.
[SDK](https://www.nuget.org/packages/Aspire.AppHost.Sdk/13.6.5) ·
[AppHost](https://www.nuget.org/packages/Aspire.Hosting.AppHost/13.6.5) ·
[PostgreSQL](https://www.nuget.org/packages/Aspire.Hosting.PostgreSQL/13.6.5) ·
[JavaScript](https://www.nuget.org/packages/Aspire.Hosting.JavaScript/13.6.5) ·
[Docker](https://www.nuget.org/packages/Aspire.Hosting.Docker/13.6.5) ·
[Testing](https://www.nuget.org/packages/Aspire.Hosting.Testing/13.6.5).

⚑ (decided 2026-11-26) Aspire stays on 13.6.5. A fresh Aspire CLI install now gets
17.0.0, and with `AspireUseCliBundle` the CLI supplies the orchestrator and dashboard, so a
17 CLI against the 13.6.5 packages is untested. Revisit at the first 17.0.x patch or on
2026-12-10, whichever comes first, and sooner if 13.x stops getting security fixes. Until
then the docs and `trivia-blueprint new --api dotnet-minimal` print the pinned install that
CI uses:

```sh
curl -fsSL https://aspire.dev/install.sh -o aspire-install.sh
bash aspire-install.sh --version 13.6.5
```

`trivia-blueprint backend` runs `aspire --version` when the CLI is on PATH and stops before
generating, naming the pinned version and that install, when the major.minor differs. A
missing CLI is only a warning, since generating the backend does not need it.

- `AddPostgres`, `WithDataVolume` and `AddDatabase` model PostgreSQL. For a project
  `AddProject<T>` uses a generated type for its project reference. `WithReference`
  injects a connection string or endpoint addresses. `WaitFor` waits for running and
  healthy, while `WaitForCompletion` waits for a successful exit.
  [PostgreSQL setup](https://aspire.dev/integrations/databases/postgres/postgres-get-started/) ·
  [Hosting API](https://github.com/microsoft/aspire/blob/v13.6.5/src/Aspire.Hosting/ResourceBuilderExtensions.cs).
- `AddViteApp` registers an HTTP endpoint and exports `PORT` to the dev script.
  `AddJavaScriptApp` accepts a run script, and `AddNextJsApp` configures Next.js
  specifically. All support `WithPnpm`. Service discovery exports
  `services__{resource}__{endpoint}__{index}`.
  [JavaScript integration](https://aspire.dev/integrations/frameworks/javascript/) ·
  [Environment variables](https://aspire.dev/fundamentals/environment-variables/).
- `DistributedApplicationTestingBuilder.CreateAsync`, `BuildAsync`, `StartAsync`,
  `WaitForResourceHealthyAsync` and `CreateHttpClient` start and exercise the graph.
  [Aspire testing](https://aspire.dev/testing/write-your-first-test/).
- `AddDockerComposeEnvironment` adds the Compose target. Vite uses
  `PublishAsStaticWebsite` to serve its built assets in a container.
  [JavaScript publishing](https://aspire.dev/deployment/javascript-apps/).

⚑ Keep the existing .NET 10.0.12 pins for `Microsoft.AspNetCore.OpenApi` and
`Microsoft.Extensions.ApiDescription.Server`. The API project enables generation with
`OpenApiGenerateDocumentsOnBuild` and passes `--openapi-version OpenApi3_1 --file-name openapi`
in `OpenApiGenerateDocumentsOptions`. The generator appends `.json`.
[Build-time OpenAPI in .NET 10](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/aspnetcore-openapi?view=aspnetcore-10.0) ·
[OpenAPI package](https://www.nuget.org/packages/Microsoft.AspNetCore.OpenApi/10.0.12) ·
[Build package](https://www.nuget.org/packages/Microsoft.Extensions.ApiDescription.Server/10.0.12).

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
Existing scaffold files are preserved. To add Aspire to a solution emitted by spec 009,
merge the new project references, package pins and startup changes into the existing
solution, central package file and API scaffold.

⚑ Use the Aspire CLI bundle for DCP and the dashboard. The generated AppHost has an HTTP
development profile. The API uses a dynamically allocated HTTP port, passes its
`/health` check to Aspire, and keeps `ConnectionStrings:AppDb` for standalone use.
The ServiceDefaults scaffold maps `/health` and `/alive` in all environments because
Aspire also checks readiness in Compose.
[Service defaults](https://aspire.dev/get-started/csharp-service-defaults/).

⚑ Pin `Microsoft.Extensions.Hosting` to **10.0.14**, resilience and service discovery
to **10.10.0**, OpenTelemetry hosting and OTLP exporter to **1.19.1**, and the ASP.NET Core,
HTTP and runtime instrumentation packages to **1.19.0**. Keep the emitted projects' direct
package references pinned in their shared `Directory.Packages.props`. The migration project
pins EF Relational to **10.0.12** to match the API's EF design package.

⚑ Build and migration subprocesses use project paths relative to their working directory
so NuGet sees one identity for each project on macOS. Disable reusable MSBuild servers
for captured builds so a surviving worker does not hold their output pipes open.

⚑ Select `AddViteApp` or Aspire's dedicated `AddNextJsApp` from `targets.web`. The latter
is the JavaScript integration's Next.js resource. The Next.js template itself belongs to
spec 012.

⚑ `Trivia:StartWeb` and `Trivia:UseDataVolume` default to true and can be disabled for API
integration tests. The test loads the generated AppHost assembly, uses the normal migration
command, and asks Aspire for its allocated API endpoint. No ports or persistent data are shared
between test runs.

### AppHost (FR-AS-01, FR-AS-02)

```csharp
var builder = DistributedApplication.CreateBuilder(args);

var postgres = builder.AddPostgres("postgres").WithDataVolume();
var db = postgres.AddDatabase("appdb");

var migrations = builder.AddProject<Projects.BackOffice_MigrationService>("migrations")
    .WithReference(db, connectionName: "AppDb").WaitFor(db);

var api = builder.AddProject<Projects.BackOffice_Api>("api", options => options.ExcludeLaunchProfile = true)
    .WithHttpEndpoint(env: "ASPNETCORE_HTTP_PORTS")
    .WithReference(db, connectionName: "AppDb").WaitForCompletion(migrations)
    .WithHttpHealthCheck("/health");

builder.AddViteApp("web", "../../web")          // next-refine uses AddNextJsApp
    .WithPnpm().WithReference(api).WaitFor(api);

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

⚑ Allow HTTP explicitly in the AppHost's loopback development profile. Give Aspire's
container runtime check ten seconds by default, then surface its missing or unhealthy
runtime diagnosis in the CLI. The integration test points Docker at an unavailable
socket without stopping the machine's runtime.
[Runtime check](https://github.com/microsoft/aspire/blob/v13.6.5/src/Aspire.Hosting/Dcp/DcpHost.cs).

⚑ The Vite config accepts `API_URL` from the process or the mode's `.env` files. When
Aspire supplies `PORT`, Vite binds that exact port. The unconfigured proxy returns a 503
problem response for `/api` requests, leaving routes such as `/apiary` to the app.

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

⚑ Wire the provider into the Vite template's `<Refine>`. `getMany` sends up to 200 ids
per request and returns immediately for an empty id list. `deleteOne` supplies the
requested id for a 204 response. Custom requests use same-origin paths and can append
query parameters, repeated filters and sorters. Problem details retain the field-message
arrays Refine's form adapter expects.

⚑ The generated list query always accepts `id:in` as a lookup by the primary key,
including on resources that omit the key from their general filter allowlist. The lookup
starts with the same scoped query as other list filters. Other operations still follow
the model's allowlist.

## 3. The contract loop (FR-AS-04, FR-AS-05, FR-AS-08)

```
1. trivia-dotnet write            model -> *.g.cs
2. trivia-dotnet migrate <Name>   when the schema changed, then clear its settled rename markers
3. dotnet build                   -> web/openapi/api.openapi.json
4. pnpm sync (in web/)            -> src/api/generated, trivia.manifest.json
5. contract drift                 -> a fix per page that no longer matches
```

- **Step 3.** The API project sets the build-time OpenAPI generation properties (the
  `Microsoft.Extensions.ApiDescription.Server` package). The document is committed, so the
  frontend builds without the backend, and a review shows contract changes as a diff.
  ⚑ The .NET 10.0.12 tool rejects dots in `--file-name`. Generate `openapi.json` in its normal
  intermediate directory, then let MSBuild copy it to `web/openapi/api.openapi.json`.
  The copy runs on incremental builds too, so deleting the web copy is recoverable.
- **Step 4.** The template's `sync` script runs contract-sync on that file with zod output.
  The document's operation ids, tags, schema names and list shape (LLD-09) are chosen so the
  manifest's resources, operations and pagination come out without overrides. A test asserts
  it: the fixture model's OpenAPI document, through contract-sync, gives a manifest with one
  resource per entity, the five CRUD slots, `listItemsPath: "items"` and page pagination.
  ⚑ The Vite template pins pnpm to the workspace version, adds contract-sync as a development
  dependency and includes zod for the generated schemas. `trivia-blueprint new` links the
  checkout's built contract-sync package when available, as it does for the Vite plugin.
  ⚑ Assert the populated slots against each fixture entity's enabled operations. The bank
  exposes all five on Customer, and list and get on Account and Transaction. Contract-sync
  consumes the Verify snapshot unchanged by accepting a leading UTF-8 BOM on JSON inputs.
- **Step 5.** `GET /@trivia/api/refine/drift` and `trivia_contract_drift` use the existing
  Refine adapter. ⚑ The route is hosted by `packages/dev-service` behind `DevHost`. The
  compiler test ejects both a list and a form, regenerates a temporary model with a field
  removed, syncs it, and checks the fixes over the same HTTP route. This test uses .NET 10.

`trivia-blueprint backend [--migration <Name>]` runs steps 1 to 4 in order, stops at the first
failure with its output, and prints the drift summary. ⚑ Run it from the solution or
its `web/` directory. All commands use argument arrays. The CLI uses the dev service's
standalone Refine adapter to report drift without starting a server.

⚑ (decided 2026-11-26) After a successful migrate, the loop clears the rename markers the
migration settled through the dev service's guarded `clearRenameMarkers` (LLD-08 section 4)
and prints each rename. A refused clear stops the loop with exit 1 and says the markers were
not cleared; the migration stays. Before step 1 the loop checks the Aspire CLI (see Verified
dependencies).

⚑ After the whole CLI loop succeeds, record the model revision reported by `write`, or the
revision the marker clear produced, and the field summary in the version 1 Blueprint lock.
Use the dev service's guarded document writer and verify the source revision again before
recording. Eject carries this baseline forward together with the existing page records.
The summary includes keys, declared fields and implied foreign keys, with enum values and
bounds where applicable. Fields generated by the API count as having a default.

⚑ Scaffold a local `.config/dotnet-tools.json` pinned to `dotnet-ef` **10.0.12**.
The migration command restores and uses that local tool when declared. Older solutions
can still use their installed `dotnet ef`.
[EF tool package](https://www.nuget.org/packages/dotnet-ef/10.0.12).

For agents, `trivia_blueprint_backend` covers steps 1
and 2 in one call, clearing the settled markers too (LLD-04 section 5), and its result's
`next` field names the rest: build, then `trivia_sync_openapi`, then
`trivia_contract_drift`. The build can take minutes and its errors belong in the developer's
terminal. ⚑ The dev service returns these entries after a successful write or migration.
The generated web package declares its containing solution root so the tool builds there
while the OpenAPI and drift tools work from the web root.

## 4. First run of a new app

```
trivia-blueprint new backoffice --api dotnet-minimal
(author the model and pages)           designer, agent or hand
trivia-blueprint backend --migration Initial
trivia-blueprint eject                 pages, resources, routes
aspire run
```

⚑ The explicit `--api dotnet-minimal` layout places the Vite app and its blueprint in
`web/` and leaves room for the solution's `src/` directory. The existing web-only `new`
command keeps its flat layout. Run the printed frontend setup commands inside `web/`.

Pages for model entities validate only after step 4 of the loop has produced the contract
(LLD-08 section 6), so the backend comes before eject. The CLI's `eject` says so when it
meets `unknown_resource`.

## 5. Publishing (FR-AS-09, should)

The AppHost includes a Docker Compose environment. The integration test runs
`aspire publish` and parses the YAML with YamlDotNet **18.1.0**. It asserts the
PostgreSQL, migration, API and web services.

⚑ Use Aspire's YARP static website publishing for Vite, with the same `/api` prefix in
production. Opt in to its experimental API at the one call site. The Compose environment
omits the dashboard. The local development run still starts it. The Next.js hosting
integration prepares a Node container when the app provides the standalone Next.js
template from spec 012.

⚑ Let `Aspire.AppHost.Sdk/13.6.5` supply the matching AppHost package implicitly.
The 13.6.5 CLI fails to parse a bracketed central version for that package.
Other direct hosting dependencies stay pinned centrally.
[Compose publishing](https://aspire.dev/deployment/docker-compose/).

## 6. Tests

- A build test: `trivia-dotnet write` on the fixture, then `dotnet build` of the whole
  solution, AppHost included.
- An Aspire integration test (`Aspire.Hosting.Testing`): start the AppHost without the web
  app, wait for the API to be healthy, exercise CRUD through its HTTP client. Needs a container
  runtime. ⚑ `Category=Integration` covers the Aspire test and the existing PostgreSQL
  integration suite. Run `pnpm exec nx run dotnet:integration` on Linux with Docker and the
  Aspire CLI bundle installed. The `pnpm check` gate runs the other .NET tests.
- The contract test of step 4.
- The data provider against the API in that same integration run, through a small Node script:
  list with paging, sorting and each filter operator, one validation error mapped to fields.
- The dev proxy: a unit test of the config function with and without the variables.

## 7. Open points

- A C# AppHost or the TypeScript AppHost that Aspire 13.4 made generally available. C# for
  now, since the solution is .NET anyway.
- ⚑ Use `--web-dir <solution-relative directory>` on `new --api dotnet-minimal`
  and `backend` to place the web app elsewhere in the solution. The web package's
  `trivia.solutionRoot` points back to its solution ancestor, so the CLI and MCP can also
  run from the web folder. The generator uses the same path for AppHost and OpenAPI output.
  Relative path segments support letters, numbers, spaces, dots, underscores and hyphens.
  Path traversal and symlinked output folders are refused.
- ⚑ Keep Refine resource keys tied to the contract collection path. The contract-loop test
  verifies that an entity named Customer with plural `people` produces `/api/v1/people` and
  the Refine key `people`.
