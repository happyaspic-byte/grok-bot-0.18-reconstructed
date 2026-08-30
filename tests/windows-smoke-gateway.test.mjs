import assert from "node:assert/strict";
import test from "node:test";

import { startHarnessServers } from "../scripts/smoke-windows.mjs";

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitFor(predicate, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  throw new Error(label);
}

async function postJson(baseUrl, route, token, body, extraHeaders = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let document;
  try { document = text.length === 0 ? null : JSON.parse(text); }
  catch { document = text; }
  return { status: response.status, document };
}

async function openProviderStream(baseUrl, route, token) {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}${route}`, {
    headers: {
      accept: "text/event-stream",
      authorization: `Bearer ${token}`,
    },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream\b/i);
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let welcome;
  while (welcome === undefined) {
    const next = await reader.read();
    if (next.done) throw new Error(`${route} closed before its welcome frame`);
    buffered += decoder.decode(next.value, { stream: true });
    const boundary = buffered.indexOf("\n\n");
    if (boundary < 0) continue;
    const event = buffered.slice(0, boundary);
    buffered = buffered.slice(boundary + 2);
    const dataLine = event.split("\n").find(line => line.startsWith("data: "));
    if (dataLine != null) welcome = JSON.parse(dataLine.slice("data: ".length));
  }
  assert.deepEqual(Object.keys(welcome).sort(), ["kind", "providerId"]);
  assert.equal(welcome.kind, "welcome");
  assert.match(welcome.providerId, /^windows-smoke-(?:webauthn|local-exec)-\d+$/);
  return {
    providerId: welcome.providerId,
    controller,
    reader,
    async abort() {
      controller.abort();
      try { await reader.cancel(); } catch {}
    },
  };
}

const webauthnHello = {
  kind: "hello",
  computerId: "behavior-test-computer",
  label: "behavior-test-webauthn",
};

const localExecHello = {
  kind: "hello",
  localRoot: "C:\\behavior-test",
  terminalsFolder: "C:\\behavior-test\\terminals",
  computerId: "behavior-test-computer",
  label: "behavior-test-local-exec",
  supervised: true,
  variant: "windows",
};

test("Windows gateway harness accepts production startup ordering and rejects ambiguous protocol traffic", async t => {
  const harness = await startHarnessServers("router-secret-canary", { gatewayPort: 0 });
  let closed = false;
  t.after(async () => {
    if (!closed) await harness.close();
  });

  const rejectedToken = "origin_rejected_token_abcdefghijklmnopqrstuvwxyz";
  const gatewayToken = "behavior_gateway_token_abcdefghijklmnopqrstuvwxyz";

  const browserOrigin = await postJson(
    harness.gatewayBaseUrl,
    "/api/getHostSettings",
    rejectedToken,
    {},
    { origin: "https://untrusted.example" },
  );
  assert.equal(browserOrigin.status, 403);
  assert.equal(harness.gatewayState.token, null, "Origin rejection must happen before token-on-first-use");

  const web = await openProviderStream(harness.gatewayBaseUrl, "/webauthn/requests", gatewayToken);
  const local = await openProviderStream(harness.gatewayBaseUrl, "/local-exec/requests", gatewayToken);
  assert.equal(harness.gatewayState.token, gatewayToken);
  assert.equal(harness.gatewayState.activeWebauthnStreams, 1);
  assert.equal(harness.gatewayState.activeLocalExecStreams, 1);

  assert.equal((await postJson(
    harness.gatewayBaseUrl,
    "/webauthn/responses",
    gatewayToken,
    { frames: [{ kind: "ping" }] },
  )).status, 200, "pre-welcome WebAuthn ping must be accepted without completing hello");

  assert.equal((await postJson(
    harness.gatewayBaseUrl,
    "/webauthn/responses",
    gatewayToken,
    { providerId: web.providerId, frames: [webauthnHello] },
  )).status, 200);
  assert.equal((await postJson(
    harness.gatewayBaseUrl,
    "/webauthn/responses",
    gatewayToken,
    { providerId: web.providerId, frames: [webauthnHello] },
  )).status, 200, "idempotent WebAuthn hello retry must succeed");
  assert.deepEqual(harness.gatewayState.webauthnHelloProviders, [web.providerId]);
  assert.equal((await postJson(
    harness.gatewayBaseUrl,
    "/webauthn/responses",
    gatewayToken,
    { providerId: web.providerId, frames: [{ ...webauthnHello, label: "conflicting-webauthn" }] },
  )).status, 500, "a conflicting WebAuthn hello retry must be rejected");

  assert.equal((await postJson(
    harness.gatewayBaseUrl,
    "/local-exec/responses",
    gatewayToken,
    { frames: [{ kind: "ping", supervised: true }] },
  )).status, 200, "pre-welcome local-exec ping must bind to the sole active stream");
  assert.equal((await postJson(
    harness.gatewayBaseUrl,
    "/local-exec/responses",
    gatewayToken,
    { frames: [localExecHello] },
  )).status, 200, "an unbound local-exec hello must bind only when unambiguous");
  assert.equal((await postJson(
    harness.gatewayBaseUrl,
    "/local-exec/responses",
    gatewayToken,
    { providerId: local.providerId, frames: [localExecHello] },
  )).status, 200, "idempotent local-exec hello retry must succeed");
  assert.equal(harness.gatewayState.localExecHelloFrames, 1);
  assert.deepEqual(harness.gatewayState.localExecHelloProviders, [local.providerId]);
  assert.equal(harness.hasActiveProviderHandshake("webauthn", new Set()), true);
  assert.equal(harness.hasActiveProviderHandshake("local-exec", new Set()), true);
  assert.equal((await postJson(
    harness.gatewayBaseUrl,
    "/local-exec/responses",
    gatewayToken,
    { providerId: local.providerId, frames: [{ ...localExecHello, label: "conflicting-local-exec" }] },
  )).status, 500, "a conflicting local-exec hello retry must be rejected");
  assert.equal(harness.gatewayRequests.filter(entry => entry.rehello === true).length, 2);

  const stale = await openProviderStream(harness.gatewayBaseUrl, "/local-exec/requests", gatewayToken);
  await stale.abort();
  await waitFor(
    () => harness.gatewayState.activeLocalExecStreams === 1,
    "closed local-exec stream was not removed from the active set",
  );
  assert.equal((await postJson(
    harness.gatewayBaseUrl,
    "/local-exec/responses",
    gatewayToken,
    { providerId: stale.providerId, frames: [{ kind: "ping" }] },
  )).status, 200, "a stale in-flight batch from an issued provider must drain successfully");
  assert.equal(
    harness.gatewayRequests.some(entry => entry.providerId === stale.providerId && entry.staleProviderBatch === true),
    true,
  );

  assert.equal((await postJson(
    harness.gatewayBaseUrl,
    "/webauthn/responses",
    gatewayToken,
    { providerId: local.providerId, frames: [{ kind: "ping" }] },
  )).status, 500, "cross-channel provider IDs must be rejected");

  const ambiguousOne = await openProviderStream(harness.gatewayBaseUrl, "/local-exec/requests", gatewayToken);
  const ambiguousTwo = await openProviderStream(harness.gatewayBaseUrl, "/local-exec/requests", gatewayToken);
  assert.equal((await postJson(
    harness.gatewayBaseUrl,
    "/local-exec/responses",
    gatewayToken,
    { frames: [localExecHello] },
  )).status, 500, "an unbound hello must fail when multiple unmatched streams exist");

  assert.equal((await postJson(
    harness.gatewayBaseUrl,
    "/local-exec/responses",
    gatewayToken,
    { providerId: local.providerId, frames: [{ kind: "ping" }], extra: true },
  )).status, 500, "extra batch keys must be rejected");
  assert.equal((await postJson(
    harness.gatewayBaseUrl,
    "/local-exec/responses",
    gatewayToken,
    { providerId: local.providerId, frames: [{ kind: "ping", padding: "x".repeat(70_000) }] },
  )).status, 500, "provider batches larger than 64 KiB must be rejected");

  const missingAccept = await fetch(`${harness.gatewayBaseUrl}/local-exec/requests`, {
    headers: { authorization: `Bearer ${gatewayToken}` },
  });
  assert.equal(missingAccept.status, 500);
  await missingAccept.text();

  harness.disconnectProviderStreams();
  await waitFor(
    () => harness.gatewayState.activeWebauthnStreams === 0
      && harness.gatewayState.activeLocalExecStreams === 0,
    "forced provider disconnect did not clean both active stream sets",
  );

  const webReconnect = await openProviderStream(harness.gatewayBaseUrl, "/webauthn/requests", gatewayToken);
  const localReconnect = await openProviderStream(harness.gatewayBaseUrl, "/local-exec/requests", gatewayToken);
  assert.notEqual(webReconnect.providerId, web.providerId);
  assert.notEqual(localReconnect.providerId, local.providerId);
  assert.equal((await postJson(
    harness.gatewayBaseUrl,
    "/webauthn/responses",
    gatewayToken,
    { providerId: webReconnect.providerId, frames: [webauthnHello] },
  )).status, 200);
  assert.equal((await postJson(
    harness.gatewayBaseUrl,
    "/local-exec/responses",
    gatewayToken,
    { providerId: localReconnect.providerId, frames: [localExecHello] },
  )).status, 200);

  await harness.close();
  closed = true;
  await waitFor(
    () => harness.gatewayState.activeWebauthnStreams === 0
      && harness.gatewayState.activeLocalExecStreams === 0,
    "harness close did not clean active provider streams",
  );

  await Promise.allSettled([
    web.abort(),
    local.abort(),
    ambiguousOne.abort(),
    ambiguousTwo.abort(),
    webReconnect.abort(),
    localReconnect.abort(),
  ]);
});
