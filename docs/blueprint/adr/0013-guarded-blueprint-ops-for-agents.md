# ADR-0013: Agents write blueprints through guarded ops over MCP

- Status: Accepted
- Date: 2026-11-25
- Requirements: BR-04, FR-AG-01 to FR-AG-07, FR-BP-07

## Context

Agents are expected to be the main authors of blueprints. Trivia's experience with a real
Claude Code session (`docs/mcp.md`) was that agents do well with a small set of tools, guards
that fail loudly, and hints delivered as structured data. An agent that rewrites whole JSON
files loses concurrent edits and gets no validation until later.

## Decision

- Blueprints change only through BlueprintOps, each carrying the revision it was computed
  against. A stale revision is 409 `conflict`.
- Five MCP tools cover the loop: read, patch, preview, eject, backend. Validation is part of
  the read and patch results, not a tool of its own.
- A patch is one labelled entry in the shared undo history, like an engine edit.
- Results put diagnostics and the suggested next step in structured fields.
- The designer uses the same HTTP routes. There is no private path.

## Consequences

- A person and an agent can work on the same blueprint, and neither overwrites the other
  silently.
- The op vocabulary is public API from its first release and needs versioning discipline.
- Editing blueprint files by hand stays possible. The store notices on the next read, because
  revisions are content hashes.

## Alternatives

- **RFC 6902 JSON Patch as the tool input.** Generic, but it lets an agent produce documents
  that are valid JSON and invalid blueprints, and its paths are noisy with generated ids.
- **Let agents write files directly.** No guards, no undo entry, no immediate diagnostics.
