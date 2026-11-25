# Contributing

Thanks for helping. The short version:

1. **Read the rules first.** [`CLAUDE.md`](CLAUDE.md) holds the few that are load-bearing: never
   reprint a file, never mix UTF-8 and UTF-16 offsets, never prune imports an edit did not touch.
2. **Start from a failing test.** Fix the bug or add the behaviour, then run the gate:
   `pnpm check` (build, typecheck, lint, test), plus `pnpm e2e` when the designer or plugin
   changes. CI runs the same on your pull request.
3. **Name the area in each commit**: `engine: …`, `plugin: …`, `designer: …`, `MCP: …`, `docs: …`,
   `repo: …`. The changelog groups by it.
4. **Leave `examples/` clean** (`git checkout -- examples/`); tests edit them on disk.
5. **Open a pull request** that says what changed and how you checked it.

Setup, commands and where code goes: [docs/development.md](docs/development.md). Everyone taking
part agrees to the [Code of Conduct](CODE_OF_CONDUCT.md).
