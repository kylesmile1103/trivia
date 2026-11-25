# Implementation Plan: Expression compiler

**Branch**: `003-expression-compiler` | **Date**: 2026-11-25 | **Spec**: [spec.md](spec.md)
**Design**: [LLD-03](../../docs/blueprint/lld/LLD-03-expression-compiler.md) · ADR-0006

## Summary

A new pure Rust crate, `trivia_expr`, that parses the expression subset with OXC, walks the
AST to check syntax, scope and purity, extracts dependencies, classifies tiers, finds cycles,
and renames by span splice. Three napi functions expose it.

## Technical Context

- **Language**: Rust (edition 2024, rust-version 1.97), a member of the root Cargo workspace.
- **Dependencies**: the workspace's pinned `oxc_*` crates, serde, serde_json, thiserror.
  Nothing new.
- **Binding**: `crates/trivia_napi`, JSON strings in and out, as every other engine call.
- **Testing**: `cargo test`, a `cargo fuzz` target, a Criterion benchmark, the napi crash suite.
- **Constraints**: no I/O. Internal spans are UTF-8, converted to UTF-16 at the boundary and
  labelled (`CLAUDE.md` rule 2). Check OXC API names in `references/oxc` before writing.

## Constitution Check

| Principle | Status |
| --- | --- |
| II Code is the truth | Emission is a span splice, the same rule as engine edits |
| V Guards | Limits on size and depth, refusals as diagnostics, never a panic |
| VI Deterministic | Pure functions over strings |
| IX Verify APIs | OXC visitor and span APIs read from `references/oxc` at the pinned version |

No violations.

## Project Structure

```
crates/trivia_expr/
  Cargo.toml, project.json
  src/
    lib.rs          analyze, emit, rename_references (JSON request and response types)
    parse.rs        wrap the source so OXC parses one expression, map spans back
    subset.rs       the syntax allowlist walk
    allow.rs        pure methods and globals, as data
    scope.rs        roots, locals, arrow parameters, shadowing
    deps.rs         member-chain extraction, tier classification
    graph.rs        cycle detection across a page's expressions
    emit.rs         rename by splice, re-parse check
    utf16.rs        offset conversion
  tests/            tables.rs, emit.rs, cycles.rs, limits.rs
  benches/analyze.rs
  fuzz/fuzz_targets/analyze.rs
crates/trivia_napi/src/expr.rs      the three exported functions
```

## Approach

1. Parse one expression reliably (wrap in parentheses, subtract the offset).
2. The subset walk, driven by the accepted and refused tables.
3. Scope and purity.
4. Dependencies and tiers, then the page-level graph.
5. Emission and reference renaming.
6. The binding, the crash suite, fuzzing and the benchmark.

## Risks

- **OXC API drift** between the version this was designed against and the pinned one.
  Mitigated by principle IX and by keeping OXC behind `parse.rs` and one visitor.
- **Purity by name** lets a method on a user object through if it shares an allowed name.
  Accepted: the result still has to pass `tsc`, and expressions cannot assign.
