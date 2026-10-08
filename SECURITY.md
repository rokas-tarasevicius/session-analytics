# Security policy

`session-analytics` reads local coding-agent transcripts, which can contain source code, credentials pasted into prompts, and other sensitive material. Security reports are taken seriously.

## Supported versions

| Version | Supported |
| --- | --- |
| 0.5.x | Yes |
| Earlier than 0.5.0 (before the standalone release) | No |

Fixes are released on the latest minor version.

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**, or go directly to [private vulnerability reporting](https://github.com/rokas-tarasevicius/session-analytics/security/advisories/new). Please do not open a public issue, pull request, or discussion for a suspected vulnerability.

Include the version (`session-analytics --version`), your OS and Node.js version, the steps to reproduce, and the impact you observed. Reproduce with the synthetic demo (`npm run demo`) or minimal hand-written fixtures. Never attach real transcripts, snapshots of your own history, or credentials.

This is a single-maintainer project. Expect an acknowledgement within 7 days and a plan or fix after triage. Reporters are credited in the advisory unless they prefer otherwise.

## Threat model

### What the tool protects

Analytics protects the content of local provider history: prompts, responses, reasoning, tool arguments and results, commands, file paths, repository roots and remotes, and raw identifiers. The [privacy contract](docs/privacy.md) defines what may leave the parser.

### Design

- **Content stays local.** No telemetry. Automatic pricing requests are plain GETs to fixed public lists and carry no local evidence. Explicit OTLP delivery has a separate documented opt-in. `--offline` / `SESSION_ANALYTICS_OFFLINE=1` disables public pricing requests. Fonts and provider marks are bundled; nothing is loaded from a CDN.
- **Bounded pricing fetches.** Only two fixed HTTPS endpoints are used: models.dev and GitHub raw for LiteLLM. No authentication, cookies, query parameters, request bodies, or redirects. Responses are capped at 32 MiB with a 15-second deadline per source; unknown fields are discarded and invalid prices rejected. Public services still observe the requesting IP and time. Source payloads are untrusted data, never instructions or executable code.
- **Pricing cache.** Normalized public rates and reviewed cards are saved atomically in the per-user data directory. Files have checksums and restrictive creation modes. Corrupt snapshots are ignored with a fixed warning; prior snapshots remain available. This cache contains no transcript content or local model inventory.
- **Offline by default.** No background network requests or telemetry. Fonts and provider marks are bundled; nothing is loaded from a CDN. The explicit `export --otlp-endpoint` option can POST the saved allowlisted payload; it never follows redirects or activates from environment variables. See [the delivery boundary](docs/interop.md#opentelemetry-mapping).
- **Loopback bind.** The dashboard listens on `127.0.0.1` only.
- **Host and Origin checks.** Requests whose `Host` header is not `127.0.0.1` or `localhost` (with an optional port) are rejected with `403`, which blocks DNS-rebinding attacks. Requests carrying an `Origin` header that is not a loopback origin are rejected, which blocks cross-site requests from other web pages.
- **Read-only HTTP.** Only `GET` is accepted. There is no endpoint that writes, executes, or accepts uploaded data.
- **No CORS.** No `Access-Control-*` headers are sent.
- **Strict browser policy.** `Content-Security-Policy` allows only same-origin scripts, styles, fonts, images, and connections, forbids framing (`frame-ancestors 'none'`), objects, `<base>`, and form submission. `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and same-origin opener and resource policies are also sent.
- **Fixed static file map.** Static files are served from an explicit list of URL paths, so request paths never reach the file system.
- **Read-only stores.** JSONL transcripts are streamed read-only and SQLite databases (Cursor, Conductor) are opened with `readOnly: true`. Nothing is written to provider directories.
- **Generic errors.** Failures surface as fixed messages; local exception text, paths, and the analysis worker's standard error are not returned.
- **Process isolation.** Each scan runs in a child process with a capped heap, and only serialized, allowlisted results cross back to the server.
- **Small supply chain.** Zero runtime dependencies. Development dependencies are TypeScript and Node type definitions, kept current by Dependabot.

### In scope

- Any transcript content, path, raw identifier, credential, or raw error appearing in the dashboard, API, report, JSON snapshot, or skill output.
- Binding to a non-loopback interface, or bypassing the `Host` or `Origin` checks.
- Reading files outside the static file map through the HTTP server.
- Any write to provider stores, transmission of local data to a pricing source, public request while offline, or request outside the documented pricing/export boundaries.

- Any write to provider stores, unrequested outbound network request, or content outside the documented OTLP allowlist being sent by an authorized export.
- Denial of service through crafted transcript files that crash or hang the server process (rather than the isolated analysis process).

### Out of scope

- An attacker who can already run code as your user or read your home directory. They can read the transcripts directly.
- Other local processes querying the dashboard while it runs. They receive the same content-free snapshot shown in the browser; stop the dashboard when you do not need it.
- Malicious browser extensions with access to `127.0.0.1` pages.
- Sensitivity of allowlisted metadata you choose to share, such as repository names in a screenshot or JSON snapshot.
- Accuracy of cost figures. Wrong numbers are bugs; please open a normal issue.
