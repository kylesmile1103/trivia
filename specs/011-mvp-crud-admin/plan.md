# Implementation Plan: MVP slice

**Branch**: `011-mvp-crud-admin` | **Date**: 2026-11-25 | **Spec**: [spec.md](spec.md)
**Design**: HLD sections 4 and 9, BRD section 7, and [LLD-11](../../docs/blueprint/lld/LLD-11-mvp-crud-admin.md) for the example and acceptance harness.

## Summary

One example blueprint, one scripted end-to-end test, one Playwright spec, one agent prompt.
Whatever fails here is fixed in the feature that owns it, with a regression test there.

## Technical Context

- **Languages**: JSON (the blueprint), JavaScript (the script), TypeScript (Playwright).
- **Dependencies**: everything from specs 001 to 010.
- **Testing**: this feature is the test.
- **Constraints**: the generated solution is never committed. The test generates it into a
  temp folder, and uses the committed kit so it needs no network after `pnpm install` and a
  package restore.

## Constitution Check

| Principle | Status |
| --- | --- |
| VIII Test first | The script is written first and fails at each missing step |
| II, III, IV | Exercised end to end. Story 2 scenario 4 asserts the eject guard |
| X Stay small | No new product code here. Gaps become tasks in their own specs |

No violations.

## Project Structure

```
examples/blueprint-mvp/
  blueprint/           app, model, five pages
  PROMPT.md            the agent prompt for story 4
  README.md            the commands, by hand
tools/blueprint/mvp.test.mjs       story 1 and 3, scripted
tools/blueprint/mvp-project.mjs    shared disposable project setup
dotnet/tests/Trivia.Blueprint.Mvp.Host/   Aspire Testing bridge for the generated AppHost
e2e/blueprint-mvp.spec.ts          stories 1 to 3 in a browser, a fourth Playwright project
```

## Approach

1. Write the blueprint and the script. Run. Fix the first failure in its owning spec. Repeat.
2. The Playwright project against the generated solution under the AppHost.
3. The model change of story 3.
4. The agent session of story 4, twice.
5. Record timings and diff sizes for the success criteria.

## Risks

- **A long, slow test.** It runs before a release and nightly, not in `pnpm check`.
- **Environment needs** (.NET SDK, containers). Skipped with a clear message when missing.
