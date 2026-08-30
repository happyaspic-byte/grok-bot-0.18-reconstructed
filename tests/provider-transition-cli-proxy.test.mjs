import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(import.meta.dirname, "..");

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-provider-transition-module-"));
  const output = path.join(temporary, "main-edge.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/electron-main/main-edge.ts")],
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

function createDeps(overrides = {}) {
  let provider = "cli-proxy";
  const order = [];
  return {
    order,
    readProvider: () => provider,
    deps: {
      settingsStore: {
        getInferenceProvider() { return provider; },
        setInferenceProvider(value) { provider = value; order.push(`set:${value}`); },
        getInferenceRouterUsage() { return null; },
      },
      boxRecovery: { restartCoordinator() { order.push("restart"); } },
      async syncHostSettingsToBox(update) { order.push(`best:${update.inferenceProvider}`); return update; },
      async syncHostSettingsToBoxStrict(update) { order.push(`strict:${update.inferenceProvider}`); return update; },
      async stopOwnedLocalDockerBox() { order.push("stop"); },
      ...overrides,
    },
  };
}

test("provider-away transition stops the owned local host when strict lease clear is unreachable", async () => {
  const loaded = await loadModule();
  try {
    const fixture = createDeps({
      async syncHostSettingsToBoxStrict(update) {
        fixture.order.push(`strict:${update.inferenceProvider}`);
        assert.equal(update.clearCliProxyCredentialLease, true);
        throw new Error("host transport down");
      },
      async stopOwnedLocalDockerBox() { fixture.order.push("stop"); },
    });
    const handlers = loaded.module.createMainEdgeHandlers(fixture.deps);

    const result = await handlers.setInferenceRouter({ provider: "cursor" });

    assert.equal(result.provider, "cursor");
    assert.equal(fixture.readProvider(), "cursor");
    assert.deepEqual(fixture.order, ["set:cursor", "strict:cursor", "stop", "restart"]);
  } finally {
    await loaded.dispose();
  }
});

test("provider-away transition rolls desktop state back if revoke and owned-host stop both fail", async () => {
  const loaded = await loadModule();
  try {
    const fixture = createDeps({
      async syncHostSettingsToBoxStrict() {
        fixture.order.push("strict:cursor");
        throw new Error("host transport down");
      },
      async stopOwnedLocalDockerBox() {
        fixture.order.push("stop");
        throw new Error("docker stop failed");
      },
    });
    const handlers = loaded.module.createMainEdgeHandlers(fixture.deps);

    await assert.rejects(
      () => handlers.setInferenceRouter({ provider: "cursor" }),
      (error) => {
        assert.equal(error.name, "AggregateError");
        return true;
      },
    );
    assert.equal(fixture.readProvider(), "cli-proxy");
    assert.deepEqual(
      fixture.order,
      ["set:cursor", "strict:cursor", "stop", "set:cli-proxy", "restart"],
    );
  } finally {
    await loaded.dispose();
  }
});

test("provider transition awaits coordinator restart completion", async () => {
  const loaded = await loadModule();
  try {
    let releaseRestart;
    const restartGate = new Promise((resolve) => { releaseRestart = resolve; });
    const fixture = createDeps({
      boxRecovery: {
        restartCoordinator() {
          fixture.order.push("restart");
          return restartGate;
        },
      },
    });
    const handlers = loaded.module.createMainEdgeHandlers(fixture.deps);
    let settled = false;
    const transition = handlers.setInferenceRouter({ provider: "cursor" }).then((value) => {
      settled = true;
      return value;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.deepEqual(fixture.order, ["set:cursor", "strict:cursor", "restart"]);

    releaseRestart();
    assert.equal((await transition).provider, "cursor");
    assert.equal(settled, true);
  } finally {
    await loaded.dispose();
  }
});

test("provider restart failure restores persisted provider before reporting failure", async () => {
  const loaded = await loadModule();
  try {
    const restartError = new Error("new provider resync failed");
    let restarts = 0;
    const fixture = createDeps({
      boxRecovery: {
        restartCoordinator() {
          fixture.order.push("restart");
          restarts += 1;
          if (restarts === 1) throw restartError;
        },
      },
    });
    const handlers = loaded.module.createMainEdgeHandlers(fixture.deps);

    await assert.rejects(
      () => handlers.setInferenceRouter({ provider: "cursor" }),
      (error) => error === restartError,
    );
    assert.equal(fixture.readProvider(), "cli-proxy");
    assert.deepEqual(fixture.order, [
      "set:cursor",
      "strict:cursor",
      "restart",
      "set:cli-proxy",
      "restart",
    ]);
  } finally {
    await loaded.dispose();
  }
});

function createBoxRuntimeDeps(overrides = {}, initialMode = "remote") {
  let mode = initialMode;
  const order = [];
  return {
    order,
    readMode: () => mode,
    deps: {
      settingsStore: {
        settingsPath: "C:/fixture/settings.json",
        getBoxRuntime() { return mode; },
        setBoxRuntime(value) { mode = value; order.push(`set:${value}`); },
        getInferenceProvider() { return "cli-proxy"; },
      },
      boxRecovery: { restartCoordinator() { order.push("restart"); } },
      async readLocalDockerStatus() {
        return { available: true, running: true, ready: true, detail: "ready" };
      },
      async startOwnedLocalDockerBox() { order.push("start"); },
      async stopOwnedLocalDockerBox() { order.push("stop"); },
      ...overrides,
    },
  };
}

test("local Docker activation stops the owned container and rolls settings back when startup fails", async () => {
  const loaded = await loadModule();
  try {
    const startupError = new Error("gateway never became ready");
    const fixture = createBoxRuntimeDeps({
      async startOwnedLocalDockerBox() {
        fixture.order.push("start");
        throw startupError;
      },
    });
    const handlers = loaded.module.createMainEdgeHandlers(fixture.deps);

    await assert.rejects(
      () => handlers.setBoxRuntime({ mode: "local-docker" }),
      (error) => error === startupError,
    );
    assert.equal(fixture.readMode(), "remote");
    assert.deepEqual(fixture.order, ["set:local-docker", "start", "set:remote", "stop", "restart"]);
  } finally {
    await loaded.dispose();
  }
});

test("local Docker activation preserves startup and cleanup failures", async () => {
  const loaded = await loadModule();
  try {
    const fixture = createBoxRuntimeDeps({
      async startOwnedLocalDockerBox() {
        fixture.order.push("start");
        throw new Error("startup failed");
      },
      async stopOwnedLocalDockerBox() {
        fixture.order.push("stop");
        throw new Error("cleanup failed");
      },
    });
    const handlers = loaded.module.createMainEdgeHandlers(fixture.deps);

    await assert.rejects(
      () => handlers.setBoxRuntime({ mode: "local-docker" }),
      (error) => {
        assert.equal(error.name, "AggregateError");
        assert.deepEqual(error.errors.map((entry) => entry.message), ["startup failed", "cleanup failed"]);
        return true;
      },
    );
    assert.equal(fixture.readMode(), "remote");
    assert.deepEqual(fixture.order, ["set:local-docker", "start", "set:remote", "stop", "restart"]);
  } finally {
    await loaded.dispose();
  }
});

test("local Docker activation rolls back the container and mode when coordinator restart fails", async () => {
  const loaded = await loadModule();
  try {
    const restartError = new Error("coordinator restart failed");
    let restarts = 0;
    const fixture = createBoxRuntimeDeps({
      boxRecovery: {
        restartCoordinator() {
          fixture.order.push("restart");
          restarts += 1;
          if (restarts === 1) throw restartError;
        },
      },
    });
    const handlers = loaded.module.createMainEdgeHandlers(fixture.deps);

    await assert.rejects(
      () => handlers.setBoxRuntime({ mode: "local-docker" }),
      (error) => error === restartError,
    );
    assert.equal(fixture.readMode(), "remote");
    assert.deepEqual(fixture.order, ["set:local-docker", "start", "restart", "set:remote", "stop", "restart"]);
  } finally {
    await loaded.dispose();
  }
});

test("setting the selected Docker runtime is idempotent", async () => {
  const loaded = await loadModule();
  try {
    const fixture = createBoxRuntimeDeps({}, "local-docker");
    const handlers = loaded.module.createMainEdgeHandlers(fixture.deps);

    const result = await handlers.setBoxRuntime({ mode: "local-docker" });

    assert.equal(result.mode, "local-docker");
    assert.equal(fixture.readMode(), "local-docker");
    assert.deepEqual(fixture.order, []);
  } finally {
    await loaded.dispose();
  }
});

test("setting an unhealthy selected Docker runtime reconciles it before returning", async () => {
  const loaded = await loadModule();
  try {
    let statusReads = 0;
    const fixture = createBoxRuntimeDeps({
      async readLocalDockerStatus() {
        statusReads += 1;
        return {
          available: true,
          running: true,
          ready: statusReads > 1,
          detail: statusReads > 1 ? "ready" : "runtime hash differs",
        };
      },
    }, "local-docker");
    const handlers = loaded.module.createMainEdgeHandlers(fixture.deps);

    const result = await handlers.setBoxRuntime({ mode: "local-docker" });

    assert.equal(result.mode, "local-docker");
    assert.equal(result.status.ready, true);
    assert.deepEqual(fixture.order, ["start", "restart"]);
  } finally {
    await loaded.dispose();
  }
});

test("remote runtime transition returns the committed mode when reconnect fails after Docker stops", async () => {
  const loaded = await loadModule();
  try {
    const fixture = createBoxRuntimeDeps({
      boxRecovery: {
        restartCoordinator() {
          fixture.order.push("restart");
          throw new Error("remote coordinator unavailable");
        },
      },
    }, "local-docker");
    const handlers = loaded.module.createMainEdgeHandlers(fixture.deps);

    const result = await handlers.setBoxRuntime({ mode: "remote" });

    assert.equal(fixture.readMode(), "remote");
    assert.equal(result.mode, "remote");
    assert.match(result.reconnectError, /remote coordinator unavailable/);
    assert.deepEqual(fixture.order, ["set:remote", "stop", "restart"]);
  } finally {
    await loaded.dispose();
  }
});

test("runtime and gateway transitions await coordinator restart completion", async () => {
  const loaded = await loadModule();
  try {
    let releaseRestart;
    const restartGate = new Promise((resolve) => { releaseRestart = resolve; });
    const fixture = createBoxRuntimeDeps({
      boxRecovery: {
        restartCoordinator() {
          fixture.order.push("restart");
          return restartGate;
        },
      },
    });
    const handlers = loaded.module.createMainEdgeHandlers(fixture.deps);
    let settled = false;
    const activation = handlers.setBoxRuntime({ mode: "local-docker" }).then((value) => {
      settled = true;
      return value;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.deepEqual(fixture.order, ["set:local-docker", "start", "restart"]);

    releaseRestart();
    const result = await activation;
    assert.equal(settled, true);
    assert.equal(result.mode, "local-docker");

    let reconnectSettled = false;
    let releaseReconnect;
    const reconnectGate = new Promise((resolve) => { releaseReconnect = resolve; });
    const ready = { kind: "ready", workspaceId: "local:9router" };
    fixture.deps.boxRecovery.restartCoordinator = () => reconnectGate.then(() => ready);
    const reconnect = handlers.forceReconnectGateway({}).then((value) => {
      reconnectSettled = true;
      return value;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reconnectSettled, false);
    releaseReconnect();
    assert.deepEqual(await reconnect, ready);
    assert.equal(reconnectSettled, true);

    const reconnectError = new Error("replacement coordinator resync failed");
    fixture.deps.boxRecovery.restartCoordinator = () => Promise.reject(reconnectError);
    await assert.rejects(
      () => handlers.forceReconnectGateway({}),
      (error) => error === reconnectError,
    );
  } finally {
    await loaded.dispose();
  }
});
