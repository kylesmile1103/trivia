# Upstream reports

Bugs in other projects that Trivia works around. Each file is a report ready to file upstream; none
has been filed yet. Once one is filed, put its link at the top of the file and in the doc that cites it.

| Report | Project | Trivia's workaround |
| --- | --- | --- |
| [Lost hot updates during hydration and before the HMR subscription](next-hmr-lost-updates.md) | vercel/next.js 16.4.6 (Turbopack) | The Next canvas catches up after hydration ([LLD-13](../blueprint/lld/LLD-13-trivia-on-nextjs.md) §6–8) |
| [`napi build` times out on its own lock on Windows](napi-rs-windows-lock.md) | napi-rs/napi-rs, `@napi-rs/cli` 3.10.x | Windows is opt-in on the nightly ([CI/CD](../ci.md)) |
