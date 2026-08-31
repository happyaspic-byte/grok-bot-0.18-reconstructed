import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(import.meta.dirname, "..");

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-coordinator-gateway-client-"));
  const output = path.join(temporary, "gateway-client.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/node-agent-coordinator/gateway/gateway-client.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  return {
    module: await import(`${pathToFileURL(output).href}?${Date.now()}`),
    dispose: () => rm(temporary, { recursive: true, force: true }),
  };
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

async function waitFor(predicate, message, turns = 100) {
  for (let turn = 0; turn < turns; turn += 1) {
    if (predicate()) return;
    await nextTurn();
  }
  assert.fail(message);
}

test("gateway event stream cancels non-SSE 2xx bodies and reconnects only after an exact SSE response", async (t) => {
  const loaded = await loadModule();
  t.after(loaded.dispose);

  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const requests = [];
  let invalidBodiesCancelled = 0;
  let validBodyController;
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    if (requests.length <= 2) {
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode("{}")); },
        cancel() { invalidBodiesCancelled += 1; },
      }), {
        status: 200,
        headers: { "content-type": requests.length === 1 ? "application/json" : "text/event-streaming" },
      });
    }
    return new Response(new ReadableStream({
      start(controller) {
        validBodyController = controller;
        controller.enqueue(new TextEncoder().encode(": connected\n\n"));
      },
    }), { status: 200, headers: { "content-type": "Text/Event-Stream; charset=utf-8" } });
  };

  const transportEvents = [];
  const reachability = [];
  const baseTiming = loaded.module.createCoordinatorGatewayClientTiming();
  const client = new loaded.module.CoordinatorGatewayClient({
    resolveConnection: async () => ({ baseUrl: "http://127.0.0.1:1340", token: "g".repeat(48) }),
    timing: {
      ...baseTiming,
      reconnectBackoff: {
        schedule() { return { elapsed: Promise.resolve(), dispose() {} }; },
      },
    },
    onEvent() {},
    onTransportEvent(event) { transportEvents.push(event); },
    onReachability(report) { reachability.push(report); },
  });
  t.after(() => client.close());

  client.start();
  await waitFor(
    () => transportEvents.some((event) => event?.family === "transport-connected"),
    "gateway client did not reconnect to the valid SSE response",
  );

  assert.equal(requests.length, 3);
  assert.equal(invalidBodiesCancelled, 2);
  assert.equal(transportEvents.filter((event) => event?.family === "transport-connected").length, 1);
  assert.equal(requests[0].init.headers.accept, "text/event-stream");
  assert.equal(requests[0].init.headers.authorization, `Bearer ${"g".repeat(48)}`);
  assert.equal(reachability.filter((report) => report?.method === "events"
    && report?.outcome === "network"
    && report?.causeSummary === "invalid-content-type").length, 2);

  client.close();
  validBodyController.close();
});
