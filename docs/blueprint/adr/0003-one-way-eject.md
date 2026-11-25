# ADR-0003: One-way eject, guarded by a lock

- Status: Accepted
- Date: 2026-11-25
- Requirements: BR-07, FR-RC-07, FR-RC-08, FR-RC-09

## Context

A blueprint and the code it produced can relate in three ways: the blueprint stays the source
and code is a build artifact; code can be lifted back into the blueprint (round trip); or the
blueprint scaffolds once and the code takes over. Round trip of arbitrary code is infeasible.
Keeping the blueprint as the source would make Trivia's premise (your source is the truth)
false for generated apps.

## Decision

Eject is one way. After a page is ejected its files are ordinary code.

- The compiler writes `blueprint/blueprint.lock.json` with, per page, the file and the SHA-256
  of the bytes it wrote.
- Ejecting a page again is allowed when its file is missing or still has that hash. The file is
  then replaced through the engine op `replaceFile`, which is guarded by the same hash.
- If the file was edited, the eject is refused with 409 `conflict` and a hint: edit the page
  with Trivia, or eject under a new name.
- Later changes to the contract reach ejected pages as drift fixes, which are byte-preserving
  edits (`docs/product.md`, slice 3).

The backend is different on purpose: see ADR-0011.

## Consequences

- No one loses a hand edit to a regeneration.
- A blueprint page goes stale once its code is edited. The panel shows that status and does
  not pretend otherwise.
- "Change the blueprint and regenerate" works only until the first hand edit. That is the
  intended hand-over point, and it must be said plainly in the UI and the docs.

## Alternatives

- **Protected regions in generated files.** Markers in user code, fragile under formatting,
  and against rule 1's spirit.
- **A reversible subset.** Possible later for structure and props, since locators make it
  tractable. Not needed for the MVP.
