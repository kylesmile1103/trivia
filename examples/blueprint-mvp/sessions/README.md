# BankAdmin agent sessions (spec 011 T011)

Two fresh Claude Code sessions, 2026-11-26, each on its own blank project set up as
[the README](../README.md#run-the-mcp-authoring-exercise) says, with the paragraph in
[PROMPT.md](../PROMPT.md) as the only instruction.

- Claude Code 2.1.332, model `claude-sonnet-5-5` (the account default), headless:
  `claude -p --strict-mcp-config --mcp-config <the project's Trivia server> --tools ""
  --allowedTools mcp__trivia --setting-sources project --disable-slash-commands`.
  So: no built-in tools, no other MCP server, no user settings, hooks or skills.
- Each session stopped twice, as the prompt allows, and was resumed with the operator's reply:
  1. it asked for `dotnet build BankAdmin.slnx` in the solution root; the reply was the result
     (build succeeded, 0 warnings, the contract in `web/openapi/api.openapi.json`);
  2. after ejecting, it asked for a migration name; the reply was `Initial`.
- `<solution>` stands for the session's temporary solution directory.

| | Tool calls | Errors | Result |
| --- | --- | --- | --- |
| [Session 1](session-1.md) | 14 | 2 | five pages ejected, `Initial` migration written |
| [Session 2](session-2.md) | 14 | 2 | five pages ejected, `Initial` migration written |

Checked independently after each session, from the solution root: `trivia-blueprint validate`
(no findings), `dotnet build -warnaserror` (0 warnings, 0 errors), `pnpm --dir web exec tsc
--noEmit` (clean).

## What the agents tripped on (T012)

Both sessions made the same two refused patches before the model went in:

1. `setEntity` for a new entity with a `key` but no `plural`, refused with "requires a plural
   and key". The refusal now names only what is missing, with an example of each.
2. A `customerId` field declared beside the `belongsTo` relation that implies it, refused as
   a collision. The diagnostic now says the relation declares it and carries a guarded
   `removeField` fix.

Both sessions also tried a `refetch` step in the Approve KYC row action. They removed it
after validation refused it, leaving Refresh as the way to reload the list. The 2026-11-26
decision lets row actions refetch the same table query as Refresh after a successful mutation.
[LLD-05](../../../docs/blueprint/lld/LLD-05-react-codegen.md#2-contract-pages-fr-rc-02).
