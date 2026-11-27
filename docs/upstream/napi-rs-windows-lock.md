# Report for napi-rs/napi-rs (not filed yet)

**Title:** `napi build` times out on Windows waiting for its own filesystem-reconciliation lock ("candidate … .swp changed before retirement")

**Environment**
- `@napi-rs/cli` 3.10.8 and 3.10.12 (same result)
- GitHub Actions `windows-2025`, Node 22.16, Rust 1.99, pnpm 12.9
- One crate, one `napi build --platform --release --esm` invocation (no other process runs
  `napi` on that package); Nx runs other, unrelated tasks in parallel.

**What happens**

The Rust build finishes; then the CLI logs, hundreds of times:

```
WARNING  Failed to clean up filesystem reconciliation metadata: Filesystem reconciliation reserved path D:\a\<repo>\<repo>\crates\.napi-rs-filesystem-reconciliation.<hash>.candidate.<uuid>.swp changed before retirement; …
```

and after 120 s fails:

```
Internal Error: Timed out after 120000ms waiting for filesystem reconciliation lock: D:\a\<repo>\<repo>\crates\<package>
    at assertReconciliationLockAcquisitionTimeRemaining (…/@napi-rs/cli/dist/cli.js)
    at delayReconciliationLockRetry (…)
    at acquireReconciliationLock (…)
    at async withFileSystemReconciliation (…)
    at async BuildCommand.execute (…)
```

The same build passes on macOS 15 and Ubuntu 24.04 (x64 and arm64).

**Expected:** a single `napi build` acquires its own lock, or at least fails fast with a message.

**Notes:** the CLI's own error text says that on Windows it identifies processes through
`reg.exe`/`powershell.exe`; the runner was busy with other tasks. The candidate `.swp` files are
under the package's parent directory (`crates\`), where a virus scanner or the search indexer
may touch new files.
