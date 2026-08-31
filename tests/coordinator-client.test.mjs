import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(import.meta.dirname, "..");

async function loadClient() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-coordinator-client-"));
  const output = path.join(temporary, "client.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "frontend/src/production/coordinator-client.ts")],
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

function transferredPort() {
  const listeners = { message: new Set(), close: new Set() };
  return {
    posted: [],
    postMessage(value) { this.posted.push(value); },
    close() {},
    start() {},
    addEventListener(type, listener) { listeners[type].add(listener); },
    emitMessage(data) { for (const listener of listeners.message) listener({ data }); },
    emitClose() { for (const listener of listeners.close) listener({}); },
  };
}

function bridge() {
  let consumer;
  return {
    source: {
      claim(next) {
        consumer = next;
        return { request() {}, release() {} };
      },
    },
    deliver(port) { consumer.onPort(port); },
  };
}

test("coordinator transport subscriptions replay current state and suppress duplicate edges", async () => {
  const loaded = await loadClient();
  try {
    const ports = bridge();
    const client = loaded.module.createCoordinatorClient(ports.source);
    assert.ok(client);
    const states = [];
    client.subscribeTransport((state) => states.push(state));
    assert.deepEqual(states, ["down"]);

    const first = transferredPort();
    ports.deliver(first);
    first.emitMessage({ kind: "lifecycle", phase: "ready", protocolVersion: 1 });
    assert.equal(client.getTransportState(), "down");
    assert.deepEqual(states, ["down"]);
    const connected = client.waitForTransportConnected(1_000);
    first.emitMessage({ kind: "event", family: "coordinator-transport-state", payload: { state: "connected" } });
    await connected;
    assert.equal(client.getTransportState(), "connected");
    assert.deepEqual(states, ["down", "connected"]);

    const lateStates = [];
    client.subscribeTransport((state) => lateStates.push(state));
    assert.deepEqual(lateStates, ["connected"]);

    first.emitMessage({ kind: "event", family: "coordinator-transport-state", payload: { state: "down" } });
    first.emitClose();
    assert.deepEqual(states, ["down", "connected", "down"]);
    assert.deepEqual(lateStates, ["connected", "down"]);
    client.dispose();
  } finally {
    await loaded.dispose();
  }
});

test("coordinator connection wait times out while lifecycle is ready but gateway transport is down", async () => {
  const loaded = await loadClient();
  try {
    const ports = bridge();
    const client = loaded.module.createCoordinatorClient(ports.source);
    assert.ok(client);
    const first = transferredPort();
    ports.deliver(first);
    first.emitMessage({ kind: "lifecycle", phase: "ready", protocolVersion: 1 });
    await assert.rejects(client.waitForTransportConnected(10), /Timed out waiting for the Local 9Router coordinator to connect/);
    assert.equal(client.getTransportState(), "down");
    client.dispose();
  } finally {
    await loaded.dispose();
  }
});

test("replacement readiness cannot reuse a connected previous coordinator port", async () => {
  const loaded = await loadClient();
  try {
    const ports = bridge();
    const client = loaded.module.createCoordinatorClient(ports.source);
    assert.ok(client);
    assert.equal(client.getPortGeneration(), 0);

    const first = transferredPort();
    ports.deliver(first);
    first.emitMessage({ kind: "lifecycle", phase: "ready", protocolVersion: 1 });
    first.emitMessage({ kind: "event", family: "coordinator-transport-state", payload: { state: "connected" } });
    assert.equal(client.getPortGeneration(), 1);
    assert.equal(client.getTransportState(), "connected");

    const replacementGeneration = client.getPortGeneration();
    let settled = false;
    const replacementConnected = client
      .waitForTransportConnectedAfterPortGeneration(replacementGeneration, 1_000)
      .then(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "the previous connected port must not satisfy replacement readiness");

    const second = transferredPort();
    ports.deliver(second);
    assert.equal(client.getPortGeneration(), replacementGeneration + 1);
    assert.equal(client.getTransportState(), "down");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "port delivery without gateway connection must remain pending");

    second.emitMessage({ kind: "lifecycle", phase: "ready", protocolVersion: 1 });
    second.emitMessage({ kind: "event", family: "coordinator-transport-state", payload: { state: "connected" } });
    await replacementConnected;
    assert.equal(settled, true);
    client.dispose();
  } finally {
    await loaded.dispose();
  }
});

test("replacement wait resolves when the newer port connected before registration", async () => {
  const loaded = await loadClient();
  try {
    const ports = bridge();
    const client = loaded.module.createCoordinatorClient(ports.source);
    assert.ok(client);

    const first = transferredPort();
    ports.deliver(first);
    first.emitMessage({ kind: "lifecycle", phase: "ready", protocolVersion: 1 });
    first.emitMessage({ kind: "event", family: "coordinator-transport-state", payload: { state: "connected" } });
    const baselineGeneration = client.getPortGeneration();

    const second = transferredPort();
    ports.deliver(second);
    second.emitMessage({ kind: "lifecycle", phase: "ready", protocolVersion: 1 });
    second.emitMessage({ kind: "event", family: "coordinator-transport-state", payload: { state: "connected" } });

    await client.waitForTransportConnectedAfterPortGeneration(baselineGeneration, 1_000);
    assert.equal(client.getPortGeneration(), baselineGeneration + 1);
    assert.equal(client.getTransportState(), "connected");
    client.dispose();
  } finally {
    await loaded.dispose();
  }
});

test("disposing rejects a pending replacement-port wait immediately", async () => {
  const loaded = await loadClient();
  try {
    const ports = bridge();
    const client = loaded.module.createCoordinatorClient(ports.source);
    assert.ok(client);

    const pending = client.waitForTransportConnectedAfterPortGeneration(client.getPortGeneration(), 60_000);
    client.dispose();
    await assert.rejects(pending, /Coordinator client is disposed/);
  } finally {
    await loaded.dispose();
  }
});

test("a replacement coordinator generation can serve calls after the first disconnects", async () => {
  const loaded = await loadClient();
  try {
    const ports = bridge();
    const client = loaded.module.createCoordinatorClient(ports.source);
    assert.ok(client);
    const first = transferredPort();
    ports.deliver(first);
    first.emitMessage({ kind: "lifecycle", phase: "ready", protocolVersion: 1 });
    await client.ready;
    first.emitClose();

    const second = transferredPort();
    ports.deliver(second);
    const pending = client.call("listAgents");
    second.emitMessage({ kind: "lifecycle", phase: "ready", protocolVersion: 1 });
    await new Promise((resolve) => setImmediate(resolve));
    const request = second.posted.find((frame) => frame.kind === "request");
    assert.ok(request);
    second.emitMessage({ kind: "reply", requestId: request.requestId, outcome: { status: "ok", value: [] } });
    assert.deepEqual(await pending, []);
    client.dispose();
  } finally {
    await loaded.dispose();
  }
});

test("public readiness follows a coordinator port replaced before lifecycle ready", async () => {
  const loaded = await loadClient();
  try {
    const ports = bridge();
    const client = loaded.module.createCoordinatorClient(ports.source);
    assert.ok(client);
    const ready = client.ready;
    let outcome = "pending";
    void ready.then(
      () => { outcome = "resolved"; },
      () => { outcome = "rejected"; },
    );

    const first = transferredPort();
    ports.deliver(first);
    const staleCall = client.call("listAgents");
    const second = transferredPort();
    ports.deliver(second);
    await assert.rejects(staleCall, /coordinator session replaced/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(outcome, "pending", "a recoverable pre-ready replacement must not reject public readiness");

    second.emitMessage({ kind: "lifecycle", phase: "ready", protocolVersion: 1 });
    second.emitMessage({ kind: "event", family: "coordinator-transport-state", payload: { state: "connected" } });
    await ready;
    assert.equal(outcome, "resolved");
    assert.equal(client.getPortGeneration(), 2);
    assert.equal(client.getTransportState(), "connected");

    const projected = [];
    void client.ready.then(
      () => { projected.push(client.getTransportState()); },
      () => { projected.push("down"); },
    );
    client.subscribeTransport((state) => projected.push(state));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(projected.at(-1), "connected", "readiness must not overwrite a connected transport replay");
    client.dispose();
  } finally {
    await loaded.dispose();
  }
});

test("public readiness rejects when the client is disposed before serving", async () => {
  const loaded = await loadClient();
  try {
    const ports = bridge();
    const client = loaded.module.createCoordinatorClient(ports.source);
    assert.ok(client);
    const first = transferredPort();
    const postMessage = first.postMessage;
    first.postMessage = function (value) {
      if (value?.kind === "lifecycle" && value.phase === "shutdown") throw new Error("port already closed");
      return postMessage.call(this, value);
    };
    ports.deliver(first);
    const ready = client.ready;
    assert.doesNotThrow(() => client.dispose());
    await assert.rejects(ready, /coordinator source disposed|Coordinator client is disposed/);
  } finally {
    await loaded.dispose();
  }
});

test("coordinator serving replays an already-live gateway connection", async () => {
  const source = await readFile(
    path.join(repoRoot, "source/node-agent-coordinator/main.ts"),
    "utf8",
  );
  assert.match(
    source,
    /onServing:\s*\(\) => \{[\s\S]*?server\.postEvent\(COORDINATOR_TRANSPORT_STATE_FAMILY, \{\s*state: isGatewayStreamLive \? "connected" : "down",\s*\}\);/,
    "renderer hello must receive the current transport state even when the gateway edge happened first",
  );
});
