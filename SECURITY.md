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

- Run the current stable 9Router release (v0.5.35 when reviewed), issue a
  dedicated proxy/client API key, and expose only its authenticated `/v1` API.
  Version 0.4.82 fixed the [`/v1` Host-header](https://github.com/decolua/9router/security/advisories/GHSA-86m2-fcxq-5q7c)
  and [`/codex` rewrite](https://github.com/decolua/9router/security/advisories/GHSA-8gmq-j984-vp4r)
  authorization bypasses, while 0.5.2 also fixed the
  [image-prefetch DNS-rebinding issue](https://github.com/decolua/9router/security/advisories/GHSA-cmhj-wh2f-9cgx).
  Those versions are no longer an acceptable floor: 0.5.4 fixed a
  [settings mass-assignment authorization downgrade](https://github.com/decolua/9router/security/advisories/GHSA-vmjq-hvgq-2wv4),
  and 0.5.6 fixed a
  [public LLM API authentication bypass](https://github.com/decolua/9router/security/advisories/GHSA-5mj8-gf6m-fhw8).
  Do not use a management key or expose the Dashboard as if it were the
  inference API.
- HTTP is default-deny outside loopback. **Allow HTTP over Tailscale** permits
  only literal addresses in Tailscale's IPv4 `100.64.0.0/10` or IPv6
  `fd7a:115c:a1e0::/48` ranges. Adjacent carrier-grade NAT addresses, other
  private ranges, public addresses, metadata endpoints, and ambiguous or
  IPv4-mapped literals remain rejected. This opt-in is additionally restricted
  to the expected 9Router port `20128` and exact `/v1` API root.
- MagicDNS and all other DNS names are rejected for HTTP, even when they
  currently resolve to a Tailscale address. This avoids making a DNS result a
  time-of-check/time-of-use authorization decision. A DNS endpoint must use
  HTTPS and the separate remote-HTTPS opt-in.
- The address-range check is an endpoint policy, not peer authentication.
  It validates the literal text but cannot prove that Windows will route the
  connection through Tailscale. Verify `tailscale ping 100.112.10.8` on the
  Windows host before enabling plain HTTP. Tailnet ACLs/grants and the 9Router
  API key must still restrict who can reach `http://100.112.10.8:20128/v1`.
- Credentials in URLs, query strings, fragments, `host.docker.internal`, and
  endpoint-specific paths are rejected. `/codex` is not accepted as an API
  root.
- The proxy/client API key uses a dedicated fixed-purpose `safeStorage` store.
  It is not part of the general user-secret export or box-secret sync. On
  Windows the backing path has an exact current-user/SYSTEM/Administrators DACL.
- Changing the endpoint origin (scheme, host, or port) discards rather than
  reuses the existing credential. The proxy/client key must be entered again
  before the new origin can be used. This prevents a settings-only origin
  change from forwarding a saved bearer token to another server.
- Immediately before a native Local 9Router turn, Electron main supplies the
  normalized configuration through the authenticated local gateway. The local
  Docker host installs it as a memory-only lease with a 30-minute expiry; each
  later prompt obtains a fresh lease. The gateway exposes no credential getter,
  and the host does not write the key to its settings, environment, transcript,
  box-secret store, or filesystem.
- Requests reject redirects and enforce time, request, response, model-count,
  and tool-output limits. Provider bodies and credentials are not copied into
  displayed errors.
- The Local Docker native-agent path accepts Chat Completions (and Auto, which
  selects it) and fails closed before network I/O when explicit Responses is
  selected; Responses tool-call replay is not yet verified.

## Login-free local workspace boundary

The Windows Local 9Router workspace is ready only when the inference provider
is `cli-proxy`, a 9Router credential and non-empty exact model ID are
configured, Chat Completions or Auto is selected, and **Use local Docker VM**
is selected. Docker Desktop must already be running. The local connector does
not request a Cursor inference credential for this combination, and the
renderer projects a separate local workspace identity instead of a fabricated
logged-in account.

The Docker host provides agent orchestration plus shell, file, and computer
tools. Those tools can execute commands, change workspace files, and control a
browser, so treat prompts and model output as potentially active code. The
local connector uses a reviewed linux/amd64 image manifest digest rather than
following a mutable tag. It publishes the authenticated gateway and VNC ports
`1340`, `6080`, and `6081` only to Windows loopback; native execution/control
ports `1337`, `1339`, and `8790` are not host-published.

The image supervisor owns the actual stock, Computer-capable execution daemon.
In standalone 9Router mode a read-only launcher drops its model-facing primary
process to the existing `box` UID/GID with an empty effective capability set
and `no_new_privs`; directly spawned window/fork daemons inherit those
irreversible restrictions. Readiness live-attests the primary listener's
executable, arguments, UID, capabilities, and `NoNewPrivs` state before use.
The root host process remains separate so it can read the gateway credential
from a root-owned mode-`0600` control volume. That volume is read-only in the
container, and the model-facing daemon must prove it cannot read the token.
Host-control credentials are also removed from its inherited and child
environments. The separately staged reconstructed execution-daemon bundle is
not treated as the process that owns the stock image's port `1337`.

Standalone 9Router also drops `NET_RAW` and mounts neither host `.codex` nor
`.claude`. Codex and Claude Code modes mount only their matching credential
directory, and provider-label changes recreate the container. These controls
do not make Docker a hostile-code boundary: a Windows/Docker administrator can
inspect or replace containers and volumes, and a same-box agent intentionally
has its workspace, browser, and model-facing local service access. Later
window/fork daemons inherit the primary restriction but are not individually
live-attested. The repository's source and bundle tests do not replace a
Docker Desktop end-to-end run of the pinned image on the target Windows host.

No-login mode does not authorize Cursor cloud RPCs. Remote boxes, shared rooms,
account billing, account-backed plugins, and other cloud/account-only features
remain unavailable without a real Cursor session. This separation is
intentional and must not be weakened by mapping `local:9router` to a fake
Cursor authentication record.
