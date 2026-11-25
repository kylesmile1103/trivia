# ADR-0001: Clean room: concepts from Openblocks, no code

- Status: Accepted
- Date: 2026-11-25
- Requirements: BR-12, NFR-07

## Context

The work started as a plan to port Openblocks. Openblocks and its live fork Lowcoder are
AGPL-3.0. The GPL family counts a work "translated into another language" as a work based on the
program, so C# written by converting their Java, or shadcn TSX written by converting their antd
TSX, would most likely have to stay AGPL-3.0. Trivia is MIT. In 2026 the question of whether an
LLM-assisted rewrite can be a clean room was openly contested, and the cautious reading is that
a model which has been shown the source is not a separated implementer. This is not legal
advice.

## Decision

Nothing is ported. Ideas are free to use: a tree of typed components, values that depend on
other values, queries as part of the app description. Code, file structure, identifiers and
serialization formats are not.

- No Openblocks or Lowcoder source file is opened while writing an equivalent module.
- No such source is put into an agent's context, attached to a prompt or cloned into
  `references/`.
- Public documentation, published screenshots and observed behaviour are acceptable inputs.
- No importer for their app format is built in this track.

The rule is the first article of `.specify/memory/constitution.md`, so every spec, plan and
task inherits it.

## Consequences

- The blueprint format is designed from scratch (ADR-0005), which is what we wanted anyway.
- We lose a migration path for existing Lowcoder users.
- If Trivia is ever sold commercially, counsel should review this process.

## Alternatives

- **Port and stay AGPL.** Legal, but it splits the project's licence and yields a clone of
  something Lowcoder already maintains.
- **Port from Lowcoder.** Same licence, same problem, more code.
