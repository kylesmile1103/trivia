# Security

## Reporting a vulnerability

Please report privately through GitHub: the repository's **Security** tab → **Report a
vulnerability** (private vulnerability reporting). Do not open a public issue. You will get an
answer within a week; fixes ship in the next release, with credit if you want it.

Trivia is pre-1.0: only the latest release and `main` get security fixes.

## Security model

Trivia's API **writes to your source files**, so it only answers the machine it runs on.

Every request under `/@trivia/api/` and `/@trivia/mcp` is refused with `403 forbidden` unless all of
these hold:

- the client address is loopback (`127.0.0.0/8`, `::1`, including IPv4-mapped);
- the `Host` names this machine (`localhost`, `*.localhost`, an IP literal, or an entry in Vite's
  `server.allowedHosts`), which blocks DNS rebinding;
- the `Origin`, when present, is a localhost origin (the opaque `null` origin is refused).

The designer's proxy applies the same three checks itself before forwarding, so starting the designer
with `--host` still does not expose the API to other machines. Mutating requests must be `POST` with
`content-type: application/json`.

`allowRemote: true` lifts the client-address check only. With `vite --host` or Docker, anyone who can
reach the dev server could then rewrite your source. Do not enable it on an untrusted network.

Trivia is dev-only: the plugin does not run in production builds, and nothing it adds ships to your users.
