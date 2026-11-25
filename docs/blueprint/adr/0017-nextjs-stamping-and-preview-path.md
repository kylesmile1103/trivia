# ADR-0017: Next.js stamping and the escaped preview path

- Status: Proposed ⚑ (spike result, for Kyle's review)
- Supersedes: ADR-0015
- Requirements: BR-11, FR-TN-01 to FR-TN-07

The LLD-13 spike verified the webpack-style stamping loader on Turbopack in Next.js 16.4.6.
It receives and returns TSX, and maps a browser stack to the original source with the default
compiler config. React Compiler preserves the first-attribute rule and the stack's source
file and line. Its Turbopack pipeline can show stamped columns in the debugger.

Keep the stamping loader and the separate dev service from ADR-0015. Store the App Router
preview route under `app/(blueprint-preview)/%5F_blueprint/<Name>/`. The literal
`__blueprint` directory is private under Next.js routing. The escaped directory serves the
planned URL `/__blueprint/<Name>` and can be added and removed while the dev server runs.
The path convention applies independently of the loader and leaves the rest of the host
design intact.
