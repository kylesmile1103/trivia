# trivia_shell

Trivia's desktop shell (Tauri 2): one native window on the designer. It is a window and
nothing more. The designer's dev server proxies the user's app, so the canvas iframe is
same-origin with the designer in this webview, just as in a browser tab. No bridge is
needed, and the page gets no Tauri API.

```sh
pnpm --filter playground dev                                    # the user's app, :5173
TRIVIA_TARGET=http://localhost:5173 pnpm --filter @trivia/designer dev   # the designer, :4400
cargo run --manifest-path crates/trivia_shell/Cargo.toml        # the window
cargo run --manifest-path crates/trivia_shell/Cargo.toml -- http://localhost:4411/__trivia/
```

The URL is the first argument, else `$TRIVIA_DESIGNER_URL`, else `http://localhost:4400/__trivia/`.
If nothing answers there yet, the window shows `waiting/index.html` (how to start the
designer) and switches to the designer once it answers.

- **Its own Cargo workspace.** Tauri needs the system webview's dev libraries to build
  (webkit2gtk on Linux), and the engine's `cargo test --workspace` shouldn't. Test it with
  `cargo test --manifest-path crates/trivia_shell/Cargo.toml`.
- **Pinned to the Tauri 2.11.6 release set.** The `tauri-*` crates are locked to the versions
  released with it (`tauri-macros`/`tauri-codegen` 2.6.3, `tauri-utils` 2.9.3,
  `tauri-runtime` 2.11.3, `tauri-runtime-wry` 2.11.4). Their caret requirements otherwise
  resolve to the 2.12 crates, whose generated code doesn't compile against 2.11.6. To upgrade,
  move them all to one release together.
- Tried on macOS (WKWebView), 2026-10-09: the designer loads after the waiting page, connects
  to the engine, and renders the same-origin canvas; `trivia_screenshot` answers with the
  window minimized. Not yet tried by hand: clicking, dragging and the inspector inside the
  window (WebKit, not Chromium). Not tried on Linux or Windows. No `tauri build` bundle yet
  (`bundle.active` is false).
