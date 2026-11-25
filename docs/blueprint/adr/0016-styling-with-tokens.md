# ADR-0016: Styling: theme tokens as CSS variables, classes as written

- Status: Accepted
- Date: 2026-11-25
- Requirements: FR-BP-02, FR-RC-01

## Context

Openblocks styles components with per-instance style objects through CSS-in-JS. shadcn apps
style with Tailwind classes and CSS variables. Tailwind v4 generates CSS only for classes it
finds in source, so class names computed at run time produce nothing. CSS-in-JS runtimes also
do not work in server components.

## Decision

- A blueprint's theme is a set of tokens. The compiler writes them as CSS variables into the
  app's stylesheet, in shadcn's variable names.
- A node's style is a `className` string of Tailwind classes, emitted into source verbatim,
  plus optional CSS variables set on the node.
- A binding may not produce a class name. Conditional styling is a conditional expression over
  complete class strings, which stay visible to Tailwind in the emitted source.
- No CSS-in-JS runtime is emitted.

## Consequences

- Emitted markup looks like hand-written shadcn code, and works in server components.
- After eject, Trivia's style panel and class manager edit these classes as they do today.
- A preview needs the stylesheet the plugin already builds for preview modules, because its
  classes are in no file on disk yet (`docs/product.md`, slice 6).

## Alternatives

- **Inline style objects.** Always work, but fight the user's design system and the inspector.
- **A style object compiled to classes.** A second vocabulary to map and maintain, for no gain
  over writing the classes.
