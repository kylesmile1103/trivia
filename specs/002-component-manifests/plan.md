# Implementation Plan: Component manifests

**Branch**: `002-component-manifests` | **Date**: 2026-11-25 | **Spec**: [spec.md](spec.md)
**Design**: [LLD-02](../../docs/blueprint/lld/LLD-02-component-manifests.md) · ADR-0009

## Summary

Manifest types, a pure resolver that merges kit, overrides and the engine's analyzed schemas,
the manifest layer of validation (plugged into spec 001's context), and JSON Schema output.

## Technical Context

- **Language**: TypeScript, inside `@trivia/blueprint` (`src/manifest/`).
- **Dependencies**: none new. The analyzer's `ComponentSchema` type is mirrored, as the
  designer mirrors engine types.
- **Testing**: Vitest. A snapshot of the analyzer's output for `examples/refine-admin` is the
  fixture input, refreshed by a script that calls `@trivia/engine` `components()`.
- **Constraints**: no hardcoded import paths (rule 9). No installation side effects.

## Constitution Check

| Principle | Status |
| --- | --- |
| VII User owns output | Props come from the user's files. The kit never overrides them |
| VI Deterministic | The resolver is pure, and its inputs are passed in |
| IX Verify APIs | Base-specific prop names are checked against real shadcn sources in fixtures |

No violations.

## Project Structure

```
packages/blueprint/src/manifest/
  types.ts          ComponentManifest and its zod schema
  intrinsics.ts     HTML tags and their curated props
  resolve.ts        resolveManifests(kit, overrides, components, aliases)
  check.ts          the manifest validation layer
  json-schema.ts    manifestsToJsonSchema
packages/blueprint/fixtures/manifests/
  analyzer/refine-admin.components.json     analyzer output snapshot
  kit-sample/{Button,Input,Card}.manifest.json
tools/blueprint/refresh-analyzer-fixture.cjs
```

## Approach

1. Types and the manifest JSON Schema.
2. The resolver, from four cases: kit and installed, kit and missing, local only, override.
3. Intrinsic elements.
4. The validation layer, wired into `validate()` through the context.
5. JSON Schema output.

## Risks

- **Analyzer gaps** (a prop it cannot see). The override file is the answer, and the
  diagnostic for an unknown prop says so.
- **Base variants.** Start with Radix and Base UI. The variant key is the `style` of
  `components.json`.
