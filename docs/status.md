# Status, limitations and roadmap

## Known limitations

Stated plainly so you can judge fit before investing time.

- **Not yet validated on third-party code.** The two examples are the only apps exercised end to end.
  What breaks on a real codebase is the next input to the roadmap.
- **Vite and React only.** Next.js and other bundlers are not supported. Refine knowledge lives in the
  plugin, so other UI kits (Ant Design, MUI) would be new adapters, not engine changes.
- **No type checker.** OXC has none, so prop schemas come from syntactic analysis of your
  `src/components/ui` (variants from `cva(...)`, curated props for intrinsic tags). Unusual component
  patterns may yield partial schemas.
- **Structural and value edits renumber locators.** The designer and agents drop a selection that a
  renumbering invalidates rather than guess a new target.
- **Refine adapter scope.** Pages are found in `src/` files importing `@refinedev/react-table` or
  `@refinedev/react-hook-form`. Forms built with `register()` or another resolver are not read.
  Drift reads enum options from the first 600 bytes of a column header. A rebuilt column or field takes
  the generated shape, replacing custom cells or widgets in it. Edit forms (an update body plus loading
  the row) and nested-object form fields are not generated yet.
- **Desktop shell.** Verified on macOS (WKWebView) only; no Linux or Windows hand test. The packaged
  app is Apple silicon only, and ad-hoc signed rather than notarized (no Apple Developer ID).
- **Packages are not published to npm** at this stage; use the workspace.

## Roadmap

In priority order (see [`docs/HANDOFF.md`](HANDOFF.md) section 7 for the live list):

1. Use Trivia on a real internal tool and fix what breaks: pages whose shape the adapter does not read,
   other UI kits, Next.js, selection that follows JSX renumbered by a value op.
2. Narrower drift fixes for changed enum options (update in place instead of rebuilding).
3. Edit forms and nested-object fields in generated forms.

General editor features (canvas, inspector, style controls) are frozen to fixes until the jobs above
are in real use.

## Acknowledgements and prior art

- [NetEase Tango](https://github.com/NetEase/tango): the idea of editing the real source AST with no DSL.
  Trivia replaces its Babel + Prettier write path with byte-range splicing.
- [OXC](https://oxc.rs): the parser and semantic analysis behind the engine.
- [Onlook](https://github.com/onlook-dev/onlook): two-phase editing and a single serializable action
  vocabulary.
- [hey-api/openapi-ts](https://heyapi.dev): the OpenAPI to TanStack Query code generator used by
  contract-sync.
- [shadcn/ui](https://ui.shadcn.com), [Refine](https://refine.dev), [Vite](https://vite.dev),
  [napi-rs](https://napi.rs) and [Tauri](https://tauri.app).
