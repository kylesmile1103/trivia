# LLD-08: Data model DSL

- Spec: `specs/008-data-model-dsl` · Requirements: FR-DM-01 to FR-DM-08 · ADR-0005, ADR-0010
- Code: `packages/blueprint/src/model/` (types, ops, validation, the mapping table) and the
  published JSON Schema `model.v1.json`, which is the contract with `trivia-dotnet` (LLD-09).

## 1. Document

```json
{
  "$schema": "https://trivia.dev/schemas/blueprint/model.v1.json",
  "blueprintVersion": 1,
  "namespace": "BackOffice",
  "enums": [{ "name": "CustomerStatus", "values": ["pending", "active", "suspended"] }],
  "entities": [{
    "name": "Customer",
    "plural": "customers",
    "key": { "name": "id", "type": "uuid", "generated": "v7" },
    "fields": [
      { "name": "fullName",    "type": "string",   "required": true, "minLength": 2, "maxLength": 120 },
      { "name": "email",       "type": "string",   "required": true, "format": "email", "unique": true },
      { "name": "status",      "type": "enum",     "enum": "CustomerStatus", "required": true, "default": "pending" },
      { "name": "creditLimit", "type": "decimal",  "precision": 18, "scale": 2, "minimum": 0 },
      { "name": "notes",       "type": "text",     "maxLength": 1000 },
      { "name": "createdAt",   "type": "datetime", "required": true, "readOnly": true, "generated": "onCreate" }
    ],
    "relations": [{ "name": "accounts", "kind": "hasMany", "to": "Account", "foreignKey": "customerId" }],
    "indexes": [{ "fields": ["status"] }],
    "api": {
      "operations": ["list", "get", "create", "update", "delete"],
      "filterable": ["status", "email"],
      "sortable": ["fullName", "createdAt"],
      "searchable": ["fullName", "email"],
      "custom": [{ "name": "approveKyc", "method": "POST", "path": "{id}/approve-kyc",
                   "input": [{ "name": "reason", "type": "string", "maxLength": 500 }],
                   "returns": "Customer" }]
    }
  }]
}
```

Enums, entities, fields and relations are arrays with a `name`, not maps: their order is the
contract's order, which the frontend tools use to place columns and fields. Names are the
identity. A rename is explicit (section 4).

Names: entities and enums PascalCase, fields and relations camelCase, `plural` kebab-case (the
URL segment and, in snake_case, the table name).

⚑ The namespace is one or more dot-separated PascalCase identifiers. The document declares
its enum and entity arrays, and each entity declares its fields, relations, indexes and API
operations, using empty arrays where appropriate. Enum values are nonempty strings. Custom
operations take an uppercase method, a relative path of literal or brace-parameter segments
(empty for the collection), optional input fields and an optional entity name for the return.

## 2. Types and mapping (FR-DM-02, FR-DM-04)

`mapping.ts` is one table and the only place this knowledge lives on the Node side. LLD-09
holds the same table in C#. A shared fixture, `model-mapping.json`, is generated from the
TypeScript table and asserted by a C# test, so the two cannot drift.

⚑ The mapping fixture is keyed by blueprint field type. Each row carries the four target
forms, with braced names for substitutions and a separate PostgreSQL fallback for
`string` without `maxLength`. The test regenerates the fixture in memory and compares its bytes.

| Blueprint | C# | PostgreSQL | OpenAPI 3.1 | zod |
| --- | --- | --- | --- | --- |
| `string` | `string` | `varchar(n)`, or `text` without `maxLength` | `string` | `z.string()` |
| `text` | `string` | `text` | `string` | `z.string()` |
| `int` | `int` | `integer` | `integer`, `int32` | `z.number().int()` |
| `long` | `long` | `bigint` | `integer`, `int64` | `z.number().int()` |
| `decimal` | `decimal` | `numeric(p,s)` | `number` | `z.number()` |
| `bool` | `bool` | `boolean` | `boolean` | `z.boolean()` |
| `date` | `DateOnly` | `date` | `string`, `date` | `z.string()` |
| `datetime` | `DateTimeOffset` | `timestamptz` | `string`, `date-time` | `z.string()` |
| `uuid` | `Guid` | `uuid` | `string`, `uuid` | `z.string().uuid()` |
| `enum` | a C# `enum`, stored and serialized as its string | `text` with a check constraint | `string` with `enum`, by `$ref` | `z.enum([...])` |
| `json` | `JsonDocument` | `jsonb` | `object` | `z.unknown()` |

Not required means nullable in C#, in the column and in the schema. The zod column documents
what contract-sync derives from the OpenAPI document, so the model's constraints must survive
that trip: `minLength`, `maxLength`, `minimum`, `maximum`, `pattern`, `format`.

Constraints per type: strings take `minLength`, `maxLength`, `pattern` and `format` (`email`,
`uri`, `password`); numbers take `minimum` and `maximum`; `decimal` needs `precision` and
`scale`. Any field may have `required`, `unique`, `readOnly`, `default` and `description`.
`generated` is `onCreate` or `onUpdate` for `datetime`, and `v7` for a `uuid` key.

⚑ Each field type has a strict schema, so a constraint on the wrong field type produces
`schema_violation` at that property. `invalid_constraint` covers conflicts between valid
properties. String and text lengths use a nonnegative minimum and positive maximum.
Integer bounds use the signed 32-bit range for `int` and safe JSON integers for `long`.

Keys: `uuid` (generated, the default), `int` or `long` (an identity column). One key field per
entity. Composite keys are refused in version 1.

## 3. Relations (FR-DM-05)

- `belongsTo`: `{ name, kind, to, foreignKey, required?, onDelete? }`. The foreign key field
  is implied: it must not also appear in `fields`. It takes the target's key type. `onDelete`
  is `restrict` (default), `cascade` or `setNull` (only when not required).
- `hasMany`: `{ name, kind, to, foreignKey }`. It must be matched by a `belongsTo` with the
  same `foreignKey` on the target, and validation says which one is missing.
- Many-to-many is two `hasMany` relations through a join entity that the author declares.

In the API a `belongsTo` shows as its foreign key field (`customerId`). Nested objects are not
embedded in responses in version 1, which keeps list pages and forms flat, as the Refine
generator expects.

⚑ An inverse matches the exact entity and foreign-key names, including in self-relations.
Indexes and API lists can reference the entity key, declared fields and implied foreign keys.
`invalid_constraint` reports an implied key that would collide with a declared member or
another implied key, and `setNull` on a required relation.

⚑ An unmatched relation's guarded `setRelation` hint uses the foreign key without its `Id`
suffix or the lowercased source type as the inverse name. If that name is taken, it appends
`Relation` and a number as needed. If the implied key would collide, the diagnostic
explains what name to free before adding the inverse.

## 4. Ops (FR-DM-07, FR-DM-08)

BlueprintOps on `model.blueprint.json` (LLD-01 section 4):

| Op | Notes |
| --- | --- |
| `setModel` | `namespace` |
| `setEnum`, `removeEnum` | Removal is refused while a field uses the enum |
| `setEntity` (create or merge), `removeEntity`, `renameEntity` | Removal is refused while a relation points at it. A rename updates relations and records `renamedFrom` |
| `setField`, `removeField`, `renameField`, `moveField` | A rename records `renamedFrom` and updates indexes and API lists |
| `setRelation`, `removeRelation` | |
| `setIndexes`, `setEntityApi` | |

`renamedFrom` stays in the document until the next migration is generated. `trivia-dotnet`
turns it into a column or table rename, and `migrate` clears the marker (LLD-09).

⚑ `setModel` can create the document with empty entity and enum arrays. `setEntity` merges
supplied top-level properties and replaces any supplied arrays or API object. Creation
requires `plural` and `key` and starts with empty collections and no API operations unless
provided. Setters for enums, fields and relations replace an exact-name match in place or
append a new entry. `moveField.index` addresses the field's final position.

⚑ An entity rename also updates custom operation returns and can be paired with `setEntity`
to change the plural. A chain of renames retains the first name through later field updates
and clears the marker if the name returns to that original.

⚑ Entity and enum removals report the blocking references in the draft. Remove those
references before the removal op in the same batch. Self-references disappear with their
entity, and custom operation inputs and returns count as references.

⚑ The public model API exposes the full schema and `validateModel(value, baseRev)`. The
shared loader still reads the model envelope. The batch reducer checks full model shape and
references alongside shared structural diagnostics, and only newly introduced errors block
a batch. Fixing ops in successful results carry the model's resulting revision.

## 5. Validation (FR-DM-03)

Model diagnostics, on top of the schema layer:

| Code | When |
| --- | --- |
| `duplicate_name` | Two entities, enums, fields or relations with one name (compared case-insensitively) |
| `reserved_name` | A C# keyword, a PostgreSQL reserved word, or a name the generator uses (`Id` collisions, `Items`, `Total`) |
| `dangling_reference` | A relation to a missing entity, a field's enum that does not exist, an index or API list naming a missing field |
| `unmatched_relation` | A `hasMany` without its `belongsTo` |
| `invalid_default` | A default that does not fit the type, the enum or the bounds |
| `invalid_constraint` | `minimum` above `maximum`, a `scale` above `precision`, or other conflicting constraints |
| `invalid_api` | An unsupported API field type, a conflicting custom route, or a reused entity plural |
| `breaking_change` (warning) | Against the lock's last generated model: a removed field, a narrowed type, a new required field without a default |

⚑ The reserved word lists have a `source` and `date` header in each JSON object, followed by
`words`. JSON has no comment syntax. The lists cover C# reserved keywords, the reserved
entries in PostgreSQL 19's own keyword column, and the generator's key and paging member
names (`Id`, `Items`, `Total`, `Page`, `PageSize`).

⚑ Enums and entities share a case-insensitive type namespace. Fields and relations share a
case-insensitive member namespace within an entity, and custom operation inputs use the same
name and constraint checks in their own scope. Enum wire values are compared exactly.

⚑ Reserved checks fold identifier case and compare SQL names in their emitted snake_case.
The conventional `id` is available for a key, and any member using the declared key name is
diagnosed as reserved.

⚑ Explicit null defaults require a nullable field. String defaults check Unicode character
length, ECMAScript Unicode patterns and email or absolute URI formats. Date-time defaults
require an offset. Decimal defaults must fit both bounds and the precision and scale of the
column using the digits that JSON serialization emits.

⚑ Filters and sorts accept scalar fields, and searches accept `string` and `text`. Custom
routes conflict by HTTP method and template with enabled CRUD or earlier custom routes.
Template comparison folds literal case and ignores parameter names. A literal segment has
its own precedence over a parameter segment. [ASP.NET Core routing](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/routing?view=aspnetcore-10.0)

## 6. Pages and the model

Pages do not reference the model. They reference contract resources (LLD-01), and the
contract comes from the API's OpenAPI document (LLD-10). Until the backend has been generated
and synced, a page for a new entity reports `unknown_resource` with the hint "generate the
backend and run sync". The indirection is deliberate (ADR-0012): the same pages work against a
backend this tool did not generate.

## 7. Tests

- Fixtures: a three-entity model (Customer, Account, Transaction) with every type, constraint
  and relation kind. It round-trips canonically.
- One fixture per diagnostic code.
- Each op, with the diff it produces. Renames update every reference.
- The mapping fixture is regenerated in CI and must match the committed file.
- The JSON Schema validates the fixtures under ajv strict mode. The C# side's deserializer
  reads the same fixtures (LLD-09).

⚑ The shared schema emitter writes the model's draft 2020-12 input schema to
`packages/blueprint/schemas/model.v1.json`, beside the app and page schemas. The path
matches the package's schema exports. The ajv tests check both acceptance of structurally
valid documents with semantic errors and rejection of schema-layer failures.

## 8. Open points

- Soft delete and audit columns (`createdBy`, `updatedAt`) as entity options. Left to hooks
  for now.
- Optimistic concurrency (a row version) is designed in LLD-09 as an entity flag,
  `concurrency: true`, and is off by default.
