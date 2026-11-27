# Status, limitations and roadmap

## Known limitations

Stated plainly so you can judge fit before investing time.

- **Not yet validated on third-party code.** The three examples are the only apps exercised end to end.
  What breaks on a real codebase is the next input to the roadmap.
- **React dev hosts.** Supported hosts are Vite and Next.js App Router. The Refine adapter is built
  around shadcn/ui.
- **No type checker.** OXC has none, so prop schemas come from syntactic analysis of your
  `src/components/ui` (variants from `cva(...)`, curated props for intrinsic tags). Unusual component
  patterns may yield partial schemas.
- **Structural and value edits renumber locators.** The engine follows the selected element through
  an edit, by the byte ranges it changed, and drops the selection when the element is gone. Undo and
  redo are not followed: a selection is kept only while the tag at its old locator still matches.
- **Refine adapter scope.** Pages are found in `src/` files importing `@refinedev/react-table` or
  `@refinedev/react-hook-form`. Forms built with `register()` or another resolver are not read.
  A changed enum is fixed in place, but enum options written as a shared constant or a `.map` get no
  drift verdict. A rebuilt column or field (a changed type) takes the generated shape, replacing custom
  cells or widgets in it. Object and array body fields become a comment in a generated form, not a
  control.
- **Desktop shell.** Verified on macOS (WKWebView) only; no Linux or Windows hand test. The packaged
  app is Apple silicon only, and ad-hoc signed rather than notarized (no Apple Developer ID).
- **Packages are not published to npm** at this stage. Link them into your app from a built
  workspace ([getting started](getting-started.md#using-trivia-in-your-own-vite-app)); CI runs that
  recipe on every pull request (`nx run tools:adopt`).

## Roadmap

In priority order (see [`docs/HANDOFF.md`](HANDOFF.md) section 7 for the live list):

1. Use Trivia on a real internal tool and fix what breaks: pages whose shape the adapter does not read,
   other UI kits.
2. Object and array fields in generated Refine forms, when a real page needs them.

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
