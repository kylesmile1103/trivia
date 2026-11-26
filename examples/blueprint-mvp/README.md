# BankAdmin blueprint

This sample turns one PostgreSQL model and five pages into an Aspire and React solution.
It includes customer list, create, edit and show pages, and an accounts list filtered by
customer. The generated Approve KYC endpoint returns HTTP 501 until its hook is implemented.

## Run from a Trivia checkout

Install the workspace dependencies first. Use .NET 10, Aspire CLI 13.6.5 and a running
Docker-compatible container runtime. A fresh Aspire install gets a newer CLI, which this
solution is not verified with, so install the pinned version as CI does:

```sh
curl -fsSL https://aspire.dev/install.sh -o aspire-install.sh
bash aspire-install.sh --version 13.6.5
```

Run the following from the repository root in a POSIX shell.

```sh
pnpm install
pnpm exec nx build plugin
pnpm exec nx run dotnet:tool
repo="$PWD"
export PATH="$repo/e2e/bin:$PATH"
cli="$repo/packages/blueprint-compiler/bin/trivia-blueprint.js"
solution=$(mktemp -d)
node "$cli" new "$solution" --api dotnet-minimal

kit="$repo/examples/blueprint-kit"
cp -R "$kit/src/components" "$kit/src/hooks" "$kit/src/lib" "$solution/web/src/"
cp "$kit/src/index.css" "$solution/web/src/index.css"
node --input-type=module - "$solution/web/package.json" "$kit/package.json" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs'
const [target, kitPath] = process.argv.slice(2)
const manifest = JSON.parse(readFileSync(target, 'utf8'))
const kit = JSON.parse(readFileSync(kitPath, 'utf8'))
manifest.dependencies = { ...kit.dependencies, ...manifest.dependencies }
writeFileSync(target, JSON.stringify(manifest, null, 2) + '\n')
JS
pnpm --dir "$solution/web" install --prefer-offline
cp -R "$repo/examples/blueprint-mvp/blueprint/." "$solution/web/blueprint/"
cd "$solution"
node "$cli" backend --migration Initial
node "$cli" validate
node "$cli" eject
dotnet build -warnaserror --disable-build-servers
pnpm --dir web exec tsc --noEmit
aspire run --isolated --apphost src/BankAdmin.AppHost
```

In the Aspire dashboard, open the `web` resource's URL and visit `/customers`.
Create a customer, filter the list by status and use Refresh to fetch it again.
The kit components come from this checkout, so this recipe needs no shadcn registry access.

## Run the MCP authoring exercise

For **each** fresh Claude Code session, repeat the setup through the install in
`web/`. Leave the project blank by omitting the copy of the example blueprint and every
command below it. Start that project's Vite server from a shell with the same `PATH`.

```sh
pnpm --dir "$solution/web" exec vite --port 5476 --strictPort
```

In a second shell, set `repo` and `solution` to the same absolute paths used for setup.
From the project's `web/` directory, connect only to its local Trivia MCP server. Pass the exact paragraph in [PROMPT.md](PROMPT.md).

```sh
cd "$solution/web"
claude --strict-mcp-config --mcp-config '{"mcpServers":{"trivia":{"type":"http","url":"http://localhost:5476/@trivia/mcp"}}}' --tools "" "$(cat "$repo/examples/blueprint-mvp/PROMPT.md")"
```

Run the local .NET build when the agent asks for it so the generated OpenAPI document is
available to `trivia_sync_openapi`. After the agent ejects, independently run
`node "$cli" validate` from the solution root and `pnpm --dir web exec tsc --noEmit`.
Record the tool-call list for each session under `examples/blueprint-mvp/sessions/` in the
Trivia checkout.
