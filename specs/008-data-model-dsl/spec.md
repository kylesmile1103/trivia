# Feature Specification: Data model DSL

**Feature Branch**: `008-data-model-dsl`
**Created**: 2026-11-25
**Status**: Draft
**Phase**: 2
**Input**: Entities, fields, relations and API options are declared once, in a document that
the .NET generator reads and that changes through the same guarded operations as pages. (BR-08)

## User Scenarios & Testing

### User Story 1 - Declare entities and fields (Priority: P1)

**Independent Test**: The three-entity fixture validates, round-trips and matches the
published JSON Schema.

**Acceptance Scenarios**:

1. **Given** an entity with a field of every type and constraint, **When** validated, **Then**
   it is valid, and it serializes canonically with fields in their declared order.
2. **Given** a field named `class`, or an entity named `Order` next to one named `order`,
   **When** validated, **Then** `reserved_name` or `duplicate_name` points at it.
3. **Given** a default that does not fit its type, enum or bounds, **When** validated, **Then**
   `invalid_default` says which rule it breaks.
4. **Given** a `decimal` without precision and scale, **When** validated, **Then** it is
   refused at the schema layer.

### User Story 2 - Relate entities (Priority: P1)

**Acceptance Scenarios**:

1. **Given** `Account` with `belongsTo Customer`, **When** validated, **Then** the foreign key
   takes the type of `Customer`'s key and must not also be declared as a field.
2. **Given** a `hasMany` without its matching `belongsTo`, **When** validated, **Then**
   `unmatched_relation` carries the op that adds it.
3. **Given** a relation to an entity that does not exist, **Then** `dangling_reference`.

### User Story 3 - Change the model safely (Priority: P1)

**Acceptance Scenarios**:

1. **Given** a field is renamed with `renameField`, **When** applied, **Then** indexes and API
   lists follow, and the field records `renamedFrom`.
2. **Given** an entity that another relates to, **When** `removeEntity` is applied, **Then** it
   is refused with the relations that hold it.
3. **Given** a model op with a stale revision, **Then** it is refused like any BlueprintOp.

### User Story 4 - Shape the API (Priority: P2)

**Acceptance Scenarios**:

1. **Given** `filterable`, `sortable` and `searchable` lists, **When** validated, **Then** each
   name must be a field of a type that supports it.
2. **Given** a custom operation whose path collides with a CRUD route, **Then** `invalid_api`.

### User Story 5 - Be warned about breaking changes (Priority: P3)

**Acceptance Scenarios**:

1. **Given** a required field without a default is added to an entity that was already
   generated, **When** validated, **Then** a `breaking_change` warning says existing rows need
   a value.

### Edge Cases

- A self-relation (an entity that belongs to itself).
- An enum value that is not a valid C# identifier (`"in-review"`).
- A plural that equals another entity's plural.
- A key of type `int` on one side of a relation and `uuid` on the other.

## Requirements

Full text in `docs/blueprint/SRS.md` section 3.8: **FR-DM-01** to **FR-DM-08**.

### Key Entities

- **Model document**: namespace, enums, entities. **Entity**: name, plural, key, fields,
  relations, indexes, API options. **Mapping table**: each type's C#, PostgreSQL, OpenAPI and
  zod form.

## Success Criteria

- **SC-001**: The mapping fixture generated from TypeScript equals the committed file, which
  the C# side also asserts (spec 009).
- **SC-002**: Each model diagnostic code has a fixture.
- **SC-003**: `model.v1.json` validates the fixtures under ajv strict mode.

## Assumptions and out of scope

- PostgreSQL only. No composite keys. No embedded objects in API responses.
- Pages reference contract resources, not model entities.
