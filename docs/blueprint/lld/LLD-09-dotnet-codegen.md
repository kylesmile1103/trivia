# LLD-09: .NET code generation

- Spec: `specs/009-dotnet-codegen` · Requirements: FR-NC-01 to FR-NC-13 · ADR-0010, ADR-0011
- Code: `dotnet/` at the repository root, its own solution, wrapped as the Nx project `dotnet`.

## Verified .NET 10 APIs

- Minimal API validation uses `builder.Services.AddValidation()` and DataAnnotations in the
  endpoint assembly. `Microsoft.NET.Sdk.Web` supplies validation through the ASP.NET Core
  shared framework. [Validation in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/validation?view=aspnetcore-10.0)
- `TypedResults` with a `Results<T1, T2>` return type contributes response metadata. Use
  `ProducesValidationProblem()` for 400 validation responses from the filter.
  `AddProblemDetails`, `AddExceptionHandler<T>`, and `UseStatusCodePages` provide
  problem details for errors outside request validation.
  [Minimal API responses](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/responses?view=aspnetcore-10.0)
- Runtime generation uses `AddOpenApi` with `OpenApiSpecVersion.OpenApi3_1` and `MapOpenApi`.
  MSBuild uses `Microsoft.Extensions.ApiDescription.Server`, `OpenApiGenerateDocumentsOnBuild`
  and `OpenApiGenerateDocumentsOptions` with `--openapi-version OpenApi3_1`.
  The document and operation use `AddDocumentTransformer` and `AddOperationTransformer`
  for generated metadata. `AddSchemaTransformer` supplies the enum wire values.
  [OpenAPI document generation](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/aspnetcore-openapi?view=aspnetcore-10.0)
- Npgsql's `UseNpgsql(..., options => options.MapEnum<T>(...))` is for native PostgreSQL enum
  types. LLD-08 instead specifies text with a check constraint, so configure an EF Core
  `HasConversion` to the literal string. `UseIdentityByDefaultColumn()` creates integer
  keys. A `uint` property with `IsRowVersion()` maps to PostgreSQL's built-in `xmin`.
  [Npgsql enum mapping](https://www.npgsql.org/efcore/mapping/enum.html),
  [Npgsql concurrency](https://www.npgsql.org/efcore/modeling/concurrency.html)
- OIDC registration uses `AddAuthentication(JwtBearerDefaults.AuthenticationScheme)` and
  `AddJwtBearer`. `RequireAuthorization()` adds policy metadata to each group and the
  OpenAPI route. The generated document's `OpenApiSecurityRequirement` references its
  bearer scheme by ID. [JWT bearer authentication](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/configure-jwt-bearer-authentication?view=aspnetcore-10.0)

The build probe used SDK 10.0.100, OpenAPI and EF Core 10.0.12, and Npgsql EF Core 10.0.3.
It built with warnings as errors, generated a 3.1 document with typed and validation
statuses, and verified the provider's create script uses a text column and omits the
system-managed version column. The tool and scaffold use exact direct NuGet version ranges
from `dotnet/Directory.Packages.props`.

## 1. The tool

```
dotnet/
  Trivia.Blueprint.slnx
  Directory.Packages.props
  src/Trivia.Blueprint.Codegen/          console app, packed as the tool "trivia-dotnet"
    Model/       records for model.v1.json and app.v1.json (System.Text.Json), the loader
    Mapping/     the type table of LLD-08, in C#
    Emit/        one emitter per file kind, each returning a CompilationUnitSyntax
    Scaffold/    scaffold-once files as embedded text with a few named holes
    Plan/        FilePlan, ownership, hashing, the writer
    Commands/    plan, write, check, migrate
  tests/Trivia.Blueprint.Codegen.Tests/
```

| Command | Does | Exit |
| --- | --- | --- |
| `plan --blueprint <dir> --root <dir> [--content]` | Prints the file plan as JSON on stdout | 0, or 1 on diagnostics |
| `write --blueprint <dir> --root <dir> [--force]` | Applies the plan | 0, 1, or 2 when a write is refused |
| `check --blueprint <dir> --root <dir>` | Fails when a generated file is stale or was edited by hand. For CI | 0 or 1 |
| `migrate <Name> --root <dir>` | Adds an EF Core migration and applies rename hints | 0 or 1 |

The tool reads the blueprint through the published JSON Schemas. It refuses a
`blueprintVersion` it does not know. It validates only what it needs, since the Node side has
already validated the model, and a diagnostic here uses the same shape as LLD-01's.

⚑ Embed the two published schemas in the tool and evaluate them locally with JsonSchema.Net.
The app document is optional for model-only input, like the bank fixture. Without it the
first model namespace segment becomes the app name and authentication defaults to none.
`modelRev` hashes the input file bytes, matching the blueprint store's disk revision.
Evaluation of each embedded schema is serialized because JsonSchema.Net populates a
shared cache for recursive references.

```json
{ "generator": "0.3.0", "modelRev": "sha256:…",
  "files": [{ "path": "src/BackOffice.Api/Features/Customer/Customer.g.cs",
              "kind": "generated", "action": "update", "hash": "sha256:…" }],
  "todo": [], "diagnostics": [] }
```

⚑ All three generation commands report the same JSON envelope on stdout, including
  diagnostics on failure. `--content` includes proposed bytes as UTF-8 text for each
  output that has content.

## 2. Ownership (FR-NC-02, FR-NC-03)

**Generated** files end in `.g.cs` and start with:

```csharp
// <auto-generated>
//   trivia-dotnet 0.3.0. This file is overwritten on every run.
//   Put your code in the partial type beside it.
//   body-sha256: 3f5a…
// </auto-generated>
#nullable enable
```

The hash covers everything after the header. Before overwriting, the writer recomputes it for
the file on disk. A mismatch means a hand edit: the run stops with exit 2 and names the file,
unless `--force`. A generated file whose entity left the model is deleted under the same check.

**Scaffold** files are written when missing and never read again. Nothing else is ever
written, and every path is checked to be inside `--root` first.

Writes are atomic per file (temp and rename). The plan is computed in full before the first
write, so a refusal writes nothing (NFR-12).

⚑ Plan paths use forward-slash relative names. Reject symbolic links in output paths and
  serialize writers for the same root. Recheck file bytes before applying and stage sibling
  temporary files with rollback copies for a failed batch.
⚑ Discover obsolete files under the API's generated directories via the tool's header marker.
  Scan Data at its top level so EF migrations stay outside ownership. The reported scaffold
  hash is for the proposed scaffold template. Existing scaffold bytes stay on disk.

## 3. Output

```
<App>.slnx                                         scaffold
Directory.Packages.props                           scaffold
src/<App>.Api/
  <App>.Api.csproj                                 scaffold
  Program.cs                                       scaffold
  Generated/ApiRegistration.g.cs                   AddGeneratedServices, MapGeneratedEndpoints
  Generated/ListQuery.g.cs                         paging, sort and filter parsing
  Generated/ApiProblem.g.cs                        ApiProblemException and its handler
  Data/AppDbContext.g.cs                           partial: DbSets, model configuration
  Data/AppDbContext.cs                             scaffold: OnModelCreatingPartial
  Data/Migrations/                                 EF Core's, never written by emitters
  Enums/<Enum>.g.cs
  Features/<Entity>/<Entity>.g.cs                  the entity, partial
  Features/<Entity>/<Entity>.cs                    scaffold: the other half
  Features/<Entity>/<Entity>Contracts.g.cs         response and request records
  Features/<Entity>/<Entity>Endpoints.g.cs         the endpoint group, partial
  Features/<Entity>/<Entity>Endpoints.cs           scaffold: hook implementations
  Features/<Entity>/<Entity>.<Operation>.g.cs      partial custom-operation declaration
  Features/<Entity>/<Entity>.<Operation>.cs        scaffold: one per custom operation
src/<App>.AppHost/, .ServiceDefaults/, .MigrationService/     scaffold (LLD-10)
```

⚑ The standalone `Program.cs` calls `AddGeneratedServices` and `MapGeneratedEndpoints`.
  LLD-10 will add `AddServiceDefaults` and `MapDefaultEndpoints` when it supplies their project.
  The PostgreSQL connection comes from `ConnectionStrings:AppDb`, with a local development
  default. The emitted package versions are selected from the generator's central pins.
  Model-dependent setup, including auth, stays behind the generated methods.

## 4. API conventions (FR-NC-06, FR-NC-07, FR-NC-10)

This section is the contract with the data provider (LLD-10). Change both or neither.

| Operation | Route | Success | Operation id |
| --- | --- | --- | --- |
| list | `GET /api/v1/<plural>` | 200 `{ items, total, page, pageSize }` | `list<Plural>` |
| get | `GET /api/v1/<plural>/{id}` | 200 the record | `get<Entity>ById` |
| create | `POST /api/v1/<plural>` | 201 the record, with `Location` | `create<Entity>` |
| update | `PUT /api/v1/<plural>/{id}` | 200 the record | `update<Entity>` |
| delete | `DELETE /api/v1/<plural>/{id}` | 204 | `delete<Entity>` |
| custom | `<method> /api/v1/<plural>/<path>` | 200, or 204 without `returns` | `<name><Entity>` |

Tags are the plural in PascalCase. Schema names are `<Entity>Response`,
`Create<Entity>Request`, `Update<Entity>Request` and `<Entity>Page`. JSON is camelCase.

⚑ Preserve the framework's component IDs for the generated record names. Override the
  enum and JSON schema types through a schema transformer, and apply input defaults,
  nullability and formats to the resolved components through a document transformer.
  Paging binds as text for field-specific validation and is described as bounded integers
  in the document.

List parameters:

- `page` (from 1, default 1) and `pageSize` (default 20, at most 200).
- `sort`: comma-separated fields, `-` for descending (`sort=fullName,-createdAt`). Only
  `sortable` fields.
- `filter`, repeatable: `<field>:<op>:<value>`, split at the first two colons. Operators: `eq`,
  `ne`, `lt`, `lte`, `gt`, `gte`, `contains`, `startswith`, `in` (comma-separated), `null`
  (`true` or `false`). Only `filterable` fields, and only operators that fit the field's type.
- `q`: a case-insensitive match over the `searchable` fields.

⚑ Always order by the key as the final sort term for stable page boundaries.
  Ordered comparisons apply to numeric and temporal fields. Text matching uses
  case-sensitive `contains` and `startswith`, and `q` uses PostgreSQL ILIKE with
  wildcard characters escaped. The `null` operator applies to nullable fields.
  Non-null comparisons, including `ne`, exclude null values.

The response's `items`, `total`, `page` and `pageSize` are what contract-sync's pagination
heuristics already recognize (`docs/data-provider.md`).

Errors are `application/problem+json`:

| Status | When | Extra member |
| --- | --- | --- |
| 400 | Validation failed; unknown sort or filter field; bad operator or value | `errors: { field: [messages] }` |
| 404 | No record with that id | |
| 409 | A unique constraint, a foreign key restriction, or a stale `version` | `code`: `unique`, `in_use` or `stale` |
| 501 | A custom operation whose stub was not implemented | |

No stack traces or SQL in any response (NFR-05).

## 5. Emitters

Each emitter is a pure function from the model to a syntax tree, built with `SyntaxFactory`
and printed with `NormalizeWhitespace()`. Members are emitted in model order. File-scoped
namespaces, nullable enabled, no `var` in generated code.

⚑ Each entity uses a feature namespace under the model namespace. Related entity references
  use fully qualified names to disambiguate them. Table names come from the plural route token,
  and the snake-case conversion matches LLD-08. If multiple inverse navigations name the
  same foreign key, the first is mapped and the rest expose the same collection.
⚑ Enum member names derive from ASCII words in the literal, with a prefix for empty or numeric
  names and numeric suffixes for collisions. Both converters retain exact wire values.
⚑ UUID keys are created with `Guid.CreateVersion7()` in the entity. Integer keys use PostgreSQL
  identity columns. Explicit non-null defaults initialize the entity and the database column.
⚑ Request properties are nullable at deserialization so validation can distinguish missing
  values from zero or false. An omitted property with a blueprint default gets that value.
  Route keys use `{id}` independently of the model key's JSON name. Writes normalize
  date-time offsets to UTC and assign on-update timestamps on generated updates.
⚑ Validate decimal precision and scale at the request boundary so storage cannot silently
  round or overflow a value that passed request validation.

- **Entity.** A partial class with the key, the fields in order, foreign keys and navigation
  properties. Required strings are `required string`.
- **Enum.** A C# enum plus a generated converter pair, so the database and JSON hold the
  blueprint's literal values (`"pending"`), not the member names.
- **DbContext.** `DbSet`s and, per entity, table and column names in snake_case, lengths,
  precision, required-ness, unique and plain indexes, relations with their delete behaviour,
  enum conversions, check constraints for `minimum` and `maximum`. It ends by calling
  `OnModelCreatingPartial`.
- **Contracts.** Records. `Create` and `Update` requests carry the writable fields
  (not `readOnly`, not generated, not the key) with validation attributes from the
  constraints. The response carries every field. A `<Entity>Page` record wraps lists.
- **Endpoints.** A static partial class with `Map<Entity>Endpoints` and one private static
  method per enabled operation, using typed results so the OpenAPI document knows every
  status. Mapping between entity and records is generated assignment code. No mapper library.
- **ListQuery.** Shared parsing of `page`, `pageSize`, `sort`, `filter` and `q`. Per entity,
  generated `switch` expressions apply a filter or a sort to an `IQueryable<T>` by field name.
  No reflection and no dynamic LINQ: an unknown field is a 400 by construction.
- **ApiRegistration.** Registers the context, validation, OpenAPI, problem details, the
  exception handler, auth when `auth.mode` is `oidc`, and maps every group.

Hooks (FR-NC-08), declared in the generated half and implemented at will in the scaffold half:

```csharp
static partial void ConfigureQuery(ref IQueryable<Customer> query, HttpContext http);
static partial void OnCreating(Customer entity, CreateCustomerRequest request, AppDbContext db);
static partial void OnCreated(Customer entity, AppDbContext db);
static partial void OnUpdating(Customer entity, UpdateCustomerRequest request, AppDbContext db);
static partial void OnUpdated(Customer entity, AppDbContext db);
static partial void OnDeleting(Customer entity, AppDbContext db);
static partial void OnDeleted(Customer entity, AppDbContext db);
```

A hook rejects an operation by throwing `ApiProblemException(status, title)`, which the
generated handler turns into problem details.

⚑ Include `OnDeleted` to give deletion both hooks under FR-NC-08. CRUD writes and
  their hooks share an EF transaction, so a rejecting post-save hook rolls back the row
  change. `ConfigureQuery` scopes list, get, update and delete lookups.

A custom operation is routed in the generated half and declared as a partial method with a
return type, which C# requires to be implemented. Its body lives in its own scaffold file,
`<Entity>.<Operation>.cs`, created with a stub that returns 501. Adding a custom operation
later therefore never breaks the build, and the plan's `todo` lists the stub to fill in.

⚑ Put each custom partial declaration in its own `.g.cs` sibling so the project can exclude
  retired scaffold code from compilation while retaining its bytes. The reserved scaffold
  filenames in each feature directory compile only while their generated sibling exists.
  `todo` lists newly proposed scaffold stubs. A route parameter called `id` uses the entity key
  type, other route parameters are strings, and declared inputs bind from JSON.

Optional per entity: `concurrency: true` adds a row version from PostgreSQL's `xmin`. The
response then carries `version`, `Update<Entity>Request` requires it, and a mismatch is a 409
with `code: "stale"`.

⚑ Reserve the wire member `version` on entities with concurrency enabled. Check the
  update token before mutating the entity and let EF's concurrency predicate detect
  a change that races the database write.

## 6. Migrations (FR-NC-12)

`migrate <Name>` runs `dotnet ef migrations add <Name>` for the API project. If the model
carries `renamedFrom` markers and the new migration contains the matching drop and add pair,
the tool rewrites that pair into a rename with a Roslyn rewriter and reports it. It touches
only the migration file this run created. The Node side then clears the markers with a model
op. Migrations are applied by the migration service at start (LLD-10), never by the tool.

⚑ `migrate` uses an installed `dotnet ef` and fixes the destination to `Data/Migrations`.
  Use `--blueprint <dir>` for input outside `<root>/blueprint`. With no model, the command
  requires one API project under `src` and adds the migration without rename hints.
  Build the project with warnings as errors before invoking EF, which expects restored
  project metadata. EF maintains its model snapshot. Earlier migration and designer files
  remain untouched.
⚑ Resolve an old table's actual plural from EF's preceding model snapshot. Rewrite only
  equivalent and unambiguous drop/add pairs with matching Up and Down statements. Keep
  table pairs that also recreate indexes and column pairs that change storage shape in
  EF's original form. Apply Roslyn-derived spans to preserve surrounding migration text.

## 7. Auth (FR-NC-13, should)

With `auth.mode: "oidc"`, `AddGeneratedServices` adds JWT bearer authentication configured
from `Authentication:Authority` and `Authentication:Audience`, and every group requires an
authenticated user. Per-entity roles (`api.roles`) are a later extension. With `none`, nothing
is added.

⚑ Protect the runtime OpenAPI endpoint as well as the model groups in OIDC mode.
  The document declares a global HTTP bearer security requirement. Build-time generation
  remains available to the contract pipeline without contacting the issuer.

## 8. Tests

- Snapshot tests per emitter on the three-entity fixture of LLD-08 (Verify). A snapshot change
  is reviewed like a golden file.
- Determinism: two runs produce identical bytes, and a second `write` reports every file
  `unchanged`.
- Ownership: an edited `.g.cs` is refused, `--force` overwrites it, a scaffold file with user
  code survives, a removed entity's generated files are deleted and its scaffold files stay.
- The emitted solutions build with `-warnaserror`. Build tests carry `Category=Build`
  and the PostgreSQL suites carry `Category=Integration`.
- Integration: the emitted API against PostgreSQL in a container. CRUD, every list operator,
  every problem status, a custom operation before (501) and after implementation, a hook that
  rejects.
- The mapping fixture from LLD-08 matches the C# table.
- `model.v1.json` fixtures from the Node package deserialize without loss.
- The migration test runs the installed `dotnet ef` CLI. The integration tests use
  Testcontainers with PostgreSQL and start the emitted API on loopback.

⚑ The Nx `dotnet` build and test targets run without caching. The test target depends on
  the build and runs all traits against the current local toolchain and Docker runtime.

## 9. Open points

- `PATCH` with partial updates. Not generated: Refine's update sends the whole form.
- Whether the tool should run `dotnet format` on scaffold files. No: they are written once,
  from text we control.
