# Security notes

This is a small-club reconstruction, not a supported production distribution.
Do not reuse real credentials or sensitive accounts while experimenting with it.

Reconstructed packages default the official updater, Sentry, and upstream
telemetry off at the Electron-main packaging boundary. The bootstrap download
and hydrated `app.asar` are checksum-pinned.

`npm audit` still reports compatibility-bound advisories in the pinned Electron
42.1 runtime, Undici 5 / Connect 1 stack, AI SDK 4, and OpenTelemetry stack.
Patch-level fixes are applied where they do not change reconstructed runtime
contracts. The remaining major upgrades are intentionally tracked as follow-up
work rather than silently changing application behavior during publication
cleanup.

Please report issues privately to the repository owner rather than opening a
public disclosure against this experimental codebase.

## OpenAI-compatible / 9Router boundary

- Run 9Router 0.4.82 or newer and expose only its authenticated `/v1` API.
- HTTP endpoints are restricted to loopback. Remote endpoints require HTTPS
  plus an explicit opt-in; credentials, query strings, fragments,
  `host.docker.internal`, and endpoint-specific paths are rejected.
- The proxy/client API key uses a dedicated fixed-purpose `safeStorage` store.
  It is not part of the general user-secret export or box-secret sync.
- Requests reject redirects and enforce time, request, response, model-count,
  and tool-output limits. Provider bodies and credentials are not copied into
  displayed errors.
- MCP tools are disabled unless the administrator-only
  `SAND_9ROUTER_ENABLE_UNREVIEWED_MCP_TOOLS=1` process opt-in is present.
