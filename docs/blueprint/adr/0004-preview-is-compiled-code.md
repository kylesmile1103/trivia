# ADR-0004: No interpreter: the preview is the compiled code

- Status: Accepted
- Date: 2026-11-25
- Requirements: BR-06, FR-RC-06, NFR-03

## Context

Builders like Openblocks interpret their DSL in the browser. Adding a compiler beside an
interpreter means two implementations of the same semantics, and they drift. Trivia already
solved this once: the inferencer's preview is the generated page, served as a module of the
user's dev server (`docs/product.md`, slice 6).

## Decision

There is no blueprint interpreter. A preview is the output of the compiler for that page,
served at `/@trivia/preview/<id>.tsx` and compiled by the app's own toolchain with its aliases,
components and theme. Eject writes the same bytes.

## Consequences

- One semantics, tested once.
- A preview needs the app's dev server, and a blueprint with errors has no preview. Diagnostics
  have to be good enough to get an author to a valid blueprint without one.
- Preview elements carry no locators, because they belong to no file yet. Selecting a node in a
  preview needs a separate marker (FR-DS-09, could).
- Fine-grained reactive evaluation (signals), which the research proposed for a runtime, is not
  needed: React and the React Compiler do that work in compiled code.

## Alternatives

- **Interpreter for editing, compiler for production.** Faster feedback on invalid drafts, at
  the cost the research called out as a top risk.
