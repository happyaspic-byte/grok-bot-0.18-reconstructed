import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(import.meta.dirname, "..");

async function loadModules() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-transport-hydration-"));
  const output = path.join(temporary, "transport-hydration.mjs");
  await symlink(
    path.join(repoRoot, "node_modules"),
    path.join(temporary, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await build({
    stdin: {
      contents: `
        export { createCoordinatorConnectionController, createCoordinatorConnectionSource } from "./frontend/src/recovered/features/root-resilience/connection-state.ts";
        export { createComputerRebuildTransportStore } from "./frontend/src/recovered/features/access/cover/computer-rebuild-transport-store.ts";
        export { initialComputerRebuildState } from "./frontend/src/recovered/features/access/cover/computer-rebuild-model.ts";
      `,
      resolveDir: repoRoot,
      sourcefile: "transport-hydration-entry.ts",
      loader: "ts",
    },
    outfile: output,
    bundle: true,
    packages: "external",
    format: "esm",
    platform: "node",
    target: "node22",
  });
  return {
    module: await import(`${pathToFileURL(output).href}?${Date.now()}`),
    dispose: () => rm(temporary, { recursive: true, force: true }),
  };
}

function transportSource(initialState = "down") {
  const ready = Promise.withResolvers();
  let state = initialState;
  let listener = () => {};
  return {
    ready,
    source: {
      ready: ready.promise,
      getTransportState: () => state,
      getAccountStatus: async () => ({ kind: "logged-in", authId: "account-1" }),
      subscribeAccount: () => () => {},
      subscribeTransport(next) {
        listener = next;
        next(state);
        return () => { listener = () => {}; };
      },
      retry: async () => {},
    },
    setState(next, emit = true) {
      state = next;
      if (emit) listener(next);
    },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("connection source reads coordinator readiness lazily", async () => {
  const loaded = await loadModules();
  try {
    const first = Promise.withResolvers();
    const second = Promise.withResolvers();
    void first.promise.catch(() => {});
    let currentReady = first.promise;
    const source = loaded.module.createCoordinatorConnectionSource({
      get ready() { return currentReady; },
      getTransportState: () => "down",
      subscribeTransport: () => () => {},
    }, {
      cursorAccount: {
        getStatus: async () => ({ kind: "logged-out" }),
        onStatusChanged: () => () => {},
      },
    }, async () => {});

    assert.equal(source.ready, first.promise);
    currentReady = second.promise;
    assert.equal(source.ready, second.promise, "the adapter must not retain an obsolete readiness promise");
    first.reject(new Error("replaced"));
    second.resolve();
    await source.ready;
  } finally {
    await loaded.dispose();
  }
});

test("lifecycle ready hydrates the root connection controller from authoritative gateway state", async () => {
  const loaded = await loadModules();
  try {
    const down = transportSource("down");
    const downController = loaded.module.createCoordinatorConnectionController(down.source);
    downController.start();
    down.ready.resolve();
    await tick();
    assert.equal(downController.get().transport, "down");
    assert.notEqual(downController.get().phase, "connected");
    downController.dispose();

    const connected = transportSource("down");
    const connectedController = loaded.module.createCoordinatorConnectionController(connected.source);
    connectedController.start();
    connected.setState("connected", false);
    connected.ready.resolve();
    await tick();
    assert.equal(connectedController.get().transport, "connected");
    assert.equal(connectedController.get().phase, "connected");
    connectedController.dispose();
  } finally {
    await loaded.dispose();
  }
});

test("readiness rejection cannot overwrite an authoritative connected transport", async () => {
  const loaded = await loadModules();
  try {
    const connected = transportSource("down");
    const controller = loaded.module.createCoordinatorConnectionController(connected.source);
    controller.start();
    connected.setState("connected", false);
    connected.ready.reject(new Error("obsolete lifecycle gate"));
    await tick();
    assert.equal(controller.get().transport, "connected");
    assert.equal(controller.get().phase, "connected");
    controller.dispose();
  } finally {
    await loaded.dispose();
  }
});

test("lifecycle ready does not fabricate a connected computer rebuild transport", async () => {
  const loaded = await loadModules();
  try {
    const down = transportSource("down");
    const downStore = loaded.module.createComputerRebuildTransportStore({
      source: down.source,
      initialState: loaded.module.initialComputerRebuildState(null),
      now: () => 1,
    });
    const downConnected = downStore.connect();
    down.ready.resolve();
    await downConnected;
    assert.equal(downStore.getTransportState(), "down");
    assert.equal(downStore.get().isConnected, false);
    downStore.dispose();

    const connected = transportSource("down");
    const connectedStore = loaded.module.createComputerRebuildTransportStore({
      source: connected.source,
      initialState: loaded.module.initialComputerRebuildState(null),
      now: () => 2,
    });
    const connectedReady = connectedStore.connect();
    connected.setState("connected", false);
    connected.ready.resolve();
    await connectedReady;
    assert.equal(connectedStore.getTransportState(), "connected");
    assert.equal(connectedStore.get().isConnected, true);
    connectedStore.dispose();
  } finally {
    await loaded.dispose();
  }
});
