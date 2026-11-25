# Implementation Plan: Component kit

**Branch**: `006-component-kit` | **Date**: 2026-11-25 | **Spec**: [spec.md](spec.md)
**Design**: [LLD-06](../../docs/blueprint/lld/LLD-06-component-kit.md) · ADR-0009, ADR-0016

## Summary

Manifest files for 25 types with Radix and Base UI variants, two composite expanders that
reuse the Refine adapter's column and field builders, a deferred list, and a fixture blueprint
with an example app and an e2e spec.

## Technical Context

- **Language**: JSON manifests, TypeScript expanders in `@trivia/blueprint-compiler`.
- **Dependencies**: none new in the compiler. The example app installs the kit from the
  registries once, and commits the result, so tests are offline.
- **Testing**: golden files, `tsc`, a manifest-versus-source fixture check, Playwright.
- **Constraints**: column and field snippets come from the existing builders, never a copy.

## Constitution Check

| Principle | Status |
| --- | --- |
| VII User owns output | Manifests only. Components come from the registries |
| III One semantics | Composites expand at compile time into the same code the tools write |
| IX Verify APIs | Each manifest's props are checked against the installed component source |
| X Stay small | The deferred list is explicit |

No violations.

## Project Structure

```
packages/blueprint-compiler/
  kit/<Type>.manifest.json        25 files
  kit/DataTable.manifest.json, kit/Form.manifest.json
  kit/deferred.json
  src/composites/data-table.ts, form.ts
  fixtures/kit/                   the fixture blueprint and golden pages
packages/vite-plugin-ast-locator/src/refine/columns.ts, fields.ts, rules.ts   builders exposed
examples/blueprint-kit/           the app, kit installed, mock contract
e2e/blueprint-kit.spec.ts
tools/blueprint/check-kit-manifests.cjs
```

## Approach

1. The example app with the kit installed for Radix, and the manifest check script.
2. Manifests in the four groups, each with its fixture page and golden file.
3. Expose the column and field builders through the generator interface of spec 005.
4. `DataTable`, then `Form`.
5. Base UI variants and a second copy of the type check.
6. The deferred list and its diagnostics.
7. Virtual rows.

## Risks

- **Prop drift in shadcn releases.** The check script runs in CI against the committed
  example app, and refreshing the app is a deliberate act.
- **refine-ui's table API.** Read from the installed registry files, not assumed.
