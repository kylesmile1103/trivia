# Implementation Plan: React code generation (Vite target)

**Branch**: `005-react-codegen-vite` | **Date**: 2026-11-25 | **Spec**: [spec.md](spec.md)
**Design**: [LLD-05](../../docs/blueprint/lld/LLD-05-react-codegen.md) ·
ADR-0003, ADR-0004, ADR-0007, ADR-0009, ADR-0016

## Summary

A new package, `@trivia/blueprint-compiler`: lowering to a page IR, a deterministic TSX
printer, eject plans with a lock, a CLI and an app template. One new engine op, `replaceFile`.
The Refine page generator moves behind an interface so the compiler can call it. The adapter's
preview, plan and ejected routes are filled in.

## Technical Context

- **Languages**: TypeScript (compiler, adapter), Rust (the op).
- **Dependencies**: `@trivia/blueprint`, `@trivia/engine`. No formatter, no template engine.
- **Testing**: golden files; `tsc` over a fixture app holding every golden page; plugin tests
  on a copy of `examples/refine-admin`; Playwright.
- **Constraints**: the compiler is pure. It reads no files. The mapping from blueprint query
  fields to Refine's hook results lives in one file, written against the installed
  `@refinedev/core` types.

## Constitution Check

| Principle | Status |
| --- | --- |
| II Code is the truth | New files by `createFile`, existing files by Ops, re-eject only through hash-guarded `replaceFile` |
| III One semantics | Preview serves `compilePage` output. A test compares it with the ejected bytes |
| IV Plans, not writes | `planEject` returns Ops. The designer or the MCP tool applies them |
| VII User owns output | No `@trivia/*` imports in emitted code. Missing components refuse the plan |
| IX Verify APIs | Refine 5 hook shapes read from the installed types, not from memory |

`replaceFile` is the one op that replaces untouched code. Justified: it runs only when the
file's hash equals the bytes Trivia itself wrote, so no user edit can be lost. The simpler
alternative (never re-eject) was rejected because drafts are previewed and ejected repeatedly
while they are being authored.

## Project Structure

```
packages/blueprint-compiler/
  src/
    index.ts
    facts.ts            ProjectFacts and how the adapter and CLI gather them
    lower/              names.ts, scope.ts, queries.ts, actions.ts, jsx.ts, index.ts
    ir.ts
    print/              module.ts, jsx.ts, imports.ts, style.ts
    targets/vite-refine/   files.ts, routes.ts, refine-hooks.ts
    contract-pages.ts   the generator interface (implemented by the plugin's scaffold)
    eject.ts            planEject
    lock.ts
    cli.ts              new, validate, compile, eject
  templates/vite-refine/
  fixtures/pages/       blueprint fixtures and golden .tsx files
  bin/trivia-blueprint.js
crates/trivia_oxc_engine/src/ops/replace_file.rs
packages/vite-plugin-ast-locator/src/refine/scaffold.ts    exposes the generator interface
packages/vite-plugin-ast-locator/src/blueprint/{preview,plan}.ts
examples/blueprint-fixture/     the fixture app tsc runs over
```

## Approach

1. `replaceFile` in the engine, alone, through the full gate.
2. Extract the Refine generator interface and add the equality test. No behaviour change.
3. IR and printer for a static custom page, golden first.
4. State and exposed values, then queries, then actions, then control flow.
5. Preview route and module.
6. Eject plan, lock, the ejected route, the MCP tool.
7. Generator options: filters and actions on contract pages.
8. CLI and template.

## Risks

- **Refine hook result shapes.** One file, a `tsc` test, principle IX.
- **Printer layout debates.** Golden files decide. Change them deliberately, in one commit.
- **Theme and nav edits at eject** depend on anchors in user code. They are best effort with
  warnings, and can be cut from this feature without harming the rest.
