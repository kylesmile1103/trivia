# trivia_shell

Trivia's desktop shell (Tauri 2): one native window on the designer. It is a window and
nothing more. The designer's dev server proxies the user's app, so the canvas iframe is
same-origin with the designer in this webview, just as in a browser tab. No bridge is
needed, and the page gets no Tauri API.

```sh
pnpm dev:desktop                                                # an example app, the designer and the window
cargo run --manifest-path crates/trivia_shell/Cargo.toml        # the window alone (pnpm dev runs the rest)
cargo run --manifest-path crates/trivia_shell/Cargo.toml -- http://localhost:4411/__trivia/
nx run shell:bundle                                             # Trivia.app and Trivia_<version>_<arch>.dmg
```

The URL is the first argument, else `$TRIVIA_DESIGNER_URL`, else `http://localhost:4400/__trivia/`.
If nothing answers there yet, the window shows `waiting/index.html` (how to start the
designer) and switches to the designer once it answers. A `-psn_…` argument, which Finder can
pass to an app bundle, is ignored.

## The packaged app

`nx run shell:bundle` (`tauri build --ci`, with `@tauri-apps/cli` 2.11.5 from the same release
set) writes `target/release/bundle/macos/Trivia.app` and
`target/release/bundle/dmg/Trivia_<version>_aarch64.dmg`. `pnpm release` builds it and attaches
the .dmg to the GitHub release; `pnpm release:desktop v<version>` does that step alone.

- **Ad-hoc signed, not notarized** (`bundle.macOS.signingIdentity: "-"`). Apple silicon runs
  only signed code, and there is no Developer ID here. A downloaded copy is quarantined, so macOS
  refuses it once: allow it in System Settings → Privacy & Security → "Open Anyway", or
  `xattr -dr com.apple.quarantine /Applications/Trivia.app`.
- **Apple silicon only** (`aarch64`): it is built for the machine that builds it.
- **Still a window on the designer:** it bundles only the waiting page, so `pnpm dev` (or your
  app plus the designer) must run. Plain-HTTP `localhost` needs no App Transport Security
  exception.
- The icon is generated from `icons/icon.png` (256 px), so it is soft on Retina displays.

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
  window minimized. The packaged `Trivia.app` did the same: opened from Finder before
  `pnpm dev`, it showed the waiting page, then the designer, and `trivia_screenshot` returned
  refine-admin's canvas from it. Not yet tried by hand: clicking, dragging and the inspector
  inside the window (WebKit, not Chromium). Not tried on Linux or Windows.
