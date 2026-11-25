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

## 2. Types and mapping (FR-DM-02, FR-DM-04)

`mapping.ts` is one table and the only place this knowledge lives on the Node side. LLD-09
holds the same table in C#. A shared fixture, `model-mapping.json`, is generated from the
TypeScript table and asserted by a C# test, so the two cannot drift.

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

## 5. Validation (FR-DM-03)

Model diagnostics, on top of the schema layer:

| Code | When |
| --- | --- |
| `duplicate_name` | Two entities, enums, fields or relations with one name (compared case-insensitively) |
| `reserved_name` | A C# keyword, a PostgreSQL reserved word, or a name the generator uses (`Id` collisions, `Items`, `Total`) |
| `dangling_reference` | A relation to a missing entity, a field's enum that does not exist, an index or API list naming a missing field |
| `unmatched_relation` | A `hasMany` without its `belongsTo` |
| `invalid_default` | A default that does not fit the type, the enum or the bounds |
| `invalid_constraint` | `minimum` above `maximum`, a `scale` above `precision`, `maxLength` on a number |
| `invalid_api` | A sortable or filterable `json` field, a custom operation path that collides with a CRUD route |
| `breaking_change` (warning) | Against the lock's last generated model: a removed field, a narrowed type, a new required field without a default |

⚑ The reserved word lists have a `source` and `date` header in each JSON object, followed by
`words`. JSON has no comment syntax. The lists cover C# reserved keywords, the reserved
entries in PostgreSQL 19's own keyword column, and the generator's key and paging member
names (`Id`, `Items`, `Total`, `Page`, `PageSize`).

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

## 8. Open points

- Soft delete and audit columns (`createdBy`, `updatedAt`) as entity options. Left to hooks
  for now.
- Optimistic concurrency (a row version) is designed in LLD-09 as an entity flag,
  `concurrency: true`, and is off by default.
