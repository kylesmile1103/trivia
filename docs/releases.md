# Releases

Every package and crate shares one version, tagged `v<version>`.

```sh
pnpm release 0.2.0 --dry-run     # preview: versions, CHANGELOG.md entry, GitHub release
pnpm release 0.2.0               # or: pnpm release minor
```

A release:
- first runs the BankAdmin MVP slice (`nx run tools:mvp`, spec 011) in required mode, so it needs
  the .NET 10 SDK and a running Docker, and stops if either is missing or the slice fails;
- bumps each `package.json`, `Cargo.toml`, `tauri.conf.json` and `Cargo.lock` entry in place;
- writes `CHANGELOG.md` with a section per commit prefix (`engine:`, `designer:`, `MCP:`, …);
- commits `release: v<version>`, tags, pushes, and creates the GitHub release;
- builds the desktop app and attaches `Trivia_<version>_aarch64.dmg` to the release, with a note
  on opening it (`pnpm release:desktop v<version>` redoes just this step);
- never publishes to npm.

It starts from a clean `main` on a Mac (the desktop app is bundled on macOS). It refuses to run when a commit since the last release has a prefix
that `nx.json` doesn't list, because Nx would leave that commit out of the changelog. The GitHub token
comes from `GH_TOKEN`, `GITHUB_TOKEN` or git's credential helper.

## From GitHub Actions

The Release workflow runs the same `pnpm release` on a macOS runner, so no Mac or local token is
needed: Actions → Release → Run workflow on `main`, with `version` (`0.3.0`, or `major`, `minor`,
`patch`) and `dry-run` (on by default). It first runs CI on the same commit, whose `integration` job runs the MVP slice on
Linux with Docker (the macOS runner has none, so the release step trusts that job), and the
release commit is authored by `github-actions[bot]`. Details: [CI/CD](ci.md).
