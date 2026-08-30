import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(import.meta.dirname, "..");
const validSaveRequest = {
  baseUrl: "http://127.0.0.1:20128/v1",
  model: "provider/model",
  protocol: "chat-completions",
  allowRemoteHttps: false,
  allowTailscaleHttp: false,
  apiKey: "replacement",
};

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-cli-proxy-mutation-module-"));
  const output = path.join(temporary, "secrets-ipc.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/electron-main/secrets/secrets-ipc.ts")],
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

async function loadPreloadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-cli-proxy-preload-module-"));
  const output = path.join(temporary, "preload.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/electron-preload/preload.ts")],
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

async function loadRouterModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-cli-proxy-router-module-"));
  const output = path.join(temporary, "router.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "frontend/src/recovered/features/settings/overlay/router.ts")],
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

function preloadInitialState() {
  return {
    experimentSnapshot: {},
    themeState: {},
    egressTunnelEnabled: false,
    webauthnProxyEnabled: false,
    egressTunnelStatus: {},
  };
}

function register(module, overrides = {}) {
  const handlers = new Map();
  const order = [];
  module.registerSecretsIpc({
    ipcMain: { handle(channel, listener) { handlers.set(channel, listener); } },
    guards: {
      assertTrustedSecretsSender() {},
      assertTrustedClientPersistenceSender() {},
      assertTrustedCoordinatorPortRequester() {},
    },
    stores: {
      userSecretsStore: {},
      clientPersistenceStore: {},
      cliProxySecretStore: {
        async status() { return { configured: false }; },
        async getConnectionConfig() { return {}; },
        async save(request) { order.push("save"); return { configured: true, request }; },
        async remove() { order.push("delete"); return { configured: false }; },
      },
    },
    async pushBoxSecrets() { return true; },
    async beforeCliProxyMutation() { order.push("before"); },
    async afterCliProxyMutation() { order.push("after"); },
    ...overrides,
  });
  return { handlers, order };
}

test("CLI-proxy save and delete remain fenced until their mutations finish", async () => {
  const loaded = await loadModule();
  try {
    const { handlers, order } = register(loaded.module);
    await handlers.get("sand:cli-proxy-save")({}, validSaveRequest);
    assert.deepEqual(order, ["before", "save", "after"]);
    order.length = 0;
    await handlers.get("sand:cli-proxy-delete")({});
    assert.deepEqual(order, ["before", "delete", "after"]);
  } finally {
    await loaded.dispose();
  }
});

test("renderer clears the API-key draft as soon as persistence succeeds even if restart later fails", async (t) => {
  const [ipcModule, preloadModule] = await Promise.all([loadModule(), loadPreloadModule()]);
  t.after(ipcModule.dispose);
  t.after(preloadModule.dispose);

  const handlers = new Map();
  const rendererListeners = new Map();
  const afterPersistence = Promise.withResolvers();
  ipcModule.module.registerSecretsIpc({
    ipcMain: { handle(channel, listener) { handlers.set(channel, listener); } },
    guards: {
      assertTrustedSecretsSender() {},
      assertTrustedClientPersistenceSender() {},
      assertTrustedCoordinatorPortRequester() {},
    },
    stores: {
      userSecretsStore: {},
      clientPersistenceStore: {},
      cliProxySecretStore: {
        async status() { return { configured: false }; },
        async getConnectionConfig() { return {}; },
        async save(request) { return { configured: true, request }; },
        async remove() { return { configured: false }; },
      },
    },
    async pushBoxSecrets() { return true; },
    async beforeCliProxyMutation() {},
    async afterCliProxyMutation() { return await afterPersistence.promise; },
  });

  const event = {
    sender: {
      send(channel, payload) {
        setImmediate(() => {
          for (const listener of rendererListeners.get(channel) ?? []) listener({}, payload);
        });
      },
    },
  };
  const ipc = {
    invoke(channel, payload) { return Promise.resolve(handlers.get(channel)(event, payload)); },
    sendSync() { return undefined; },
    send() {},
    on(channel, listener) {
      const listeners = rendererListeners.get(channel) ?? new Set();
      listeners.add(listener);
      rendererListeners.set(channel, listeners);
    },
    off(channel, listener) { rendererListeners.get(channel)?.delete(listener); },
  };
  const bridge = preloadModule.module.createDesktopPreloadBridge({
    ipc,
    webFrame: { getZoomFactor: () => 1 },
    mainEdge: { subscribe: () => () => {} },
    initialState: preloadInitialState(),
  });

  let apiKeyDraft = validSaveRequest.apiKey;
  let clearCount = 0;
  let saveSettled = false;
  const save = bridge.cliProxy.save(validSaveRequest, () => {
    clearCount += 1;
    apiKeyDraft = "";
  });
  void save.then(
    () => { saveSettled = true; },
    () => { saveSettled = true; },
  );
  for (let attempt = 0; attempt < 20 && apiKeyDraft !== ""; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(apiKeyDraft, "", "the persistence acknowledgement zeroizes renderer state");
  assert.equal(clearCount, 1, "the queued acknowledgement is applied exactly once");
  assert.equal(saveSettled, false, "coordinator settlement is deliberately still pending");

  afterPersistence.reject(new Error("coordinator restart failed"));
  await assert.rejects(save, /coordinator restart failed/);
  assert.equal(clearCount, 1);
});

test("fulfilled save zeroizes exactly once when invoke wins the setImmediate acknowledgement race", async (t) => {
  const preload = await loadPreloadModule();
  t.after(preload.dispose);
  const listeners = new Map();
  const emit = (channel, payload) => {
    for (const listener of listeners.get(channel) ?? []) listener({}, payload);
  };
  const ipc = {
    invoke(channel, payload) {
      assert.equal(channel, "sand:cli-proxy-save");
      setImmediate(() => emit("sand:cli-proxy-persisted", {
        requestId: payload.persistenceRequestId,
      }));
      return Promise.resolve({ configured: true });
    },
    sendSync() { return undefined; },
    send() {},
    on(channel, listener) {
      const registered = listeners.get(channel) ?? new Set();
      registered.add(listener);
      listeners.set(channel, registered);
    },
    off(channel, listener) { listeners.get(channel)?.delete(listener); },
  };
  const bridge = preload.module.createDesktopPreloadBridge({
    ipc,
    webFrame: { getZoomFactor: () => 1 },
    mainEdge: { subscribe: () => () => {} },
    initialState: preloadInitialState(),
  });
  let clearCount = 0;
  await bridge.cliProxy.save(validSaveRequest, () => { clearCount += 1; });
  assert.equal(clearCount, 1, "fulfilled invoke is the request-correlated fallback");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(clearCount, 1, "the later event cannot double-clear the draft");
  assert.equal(listeners.get("sand:cli-proxy-persisted")?.size ?? 0, 0);
});

test("late restart-failure acknowledgement preserves a newer submitted-draft revision", async (t) => {
  const [ipcModule, preloadModule, routerModule] = await Promise.all([
    loadModule(),
    loadPreloadModule(),
    loadRouterModule(),
  ]);
  t.after(ipcModule.dispose);
  t.after(preloadModule.dispose);
  t.after(routerModule.dispose);

  const handlers = new Map();
  const rendererListeners = new Map();
  ipcModule.module.registerSecretsIpc({
    ipcMain: { handle(channel, listener) { handlers.set(channel, listener); } },
    guards: {
      assertTrustedSecretsSender() {},
      assertTrustedClientPersistenceSender() {},
      assertTrustedCoordinatorPortRequester() {},
    },
    stores: {
      userSecretsStore: {},
      clientPersistenceStore: {},
      cliProxySecretStore: {
        async status() { return { configured: false }; },
        async getConnectionConfig() { return {}; },
        async save(request) { return { configured: true, request }; },
        async remove() { return { configured: false }; },
      },
    },
    async pushBoxSecrets() { return true; },
    async beforeCliProxyMutation() {},
    async afterCliProxyMutation() { throw new Error("coordinator restart failed"); },
  });
  const event = {
    sender: {
      send(channel, payload) {
        setImmediate(() => {
          for (const listener of rendererListeners.get(channel) ?? []) listener({}, payload);
        });
      },
    },
  };
  const ipc = {
    invoke(channel, payload) { return Promise.resolve(handlers.get(channel)(event, payload)); },
    sendSync() { return undefined; },
    send() {},
    on(channel, listener) {
      const registered = rendererListeners.get(channel) ?? new Set();
      registered.add(listener);
      rendererListeners.set(channel, registered);
    },
    off(channel, listener) { rendererListeners.get(channel)?.delete(listener); },
  };
  const bridge = preloadModule.module.createDesktopPreloadBridge({
    ipc,
    webFrame: { getZoomFactor: () => 1 },
    mainEdge: { subscribe: () => () => {} },
    initialState: preloadInitialState(),
  });

  const origin = "http://127.0.0.1:20128";
  let identity = { revision: 1, origin };
  let draft = validSaveRequest.apiKey;
  let clearCount = 0;
  const stableAcknowledgement = routerModule.module.createCliProxyApiKeyPersistenceGuard(
    { ...identity },
    () => identity,
    () => { clearCount += 1; draft = ""; },
  );
  const failedRestart = bridge.cliProxy.save(validSaveRequest, stableAcknowledgement);
  await assert.rejects(failedRestart, /coordinator restart failed/);
  assert.equal(clearCount, 0, "the rejected invoke settles before its queued acknowledgement");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(clearCount, 1, "the bounded late-ack arm clears the persisted draft");
  assert.equal(draft, "");

  identity = { revision: 2, origin };
  draft = validSaveRequest.apiKey;
  const replacementGuard = routerModule.module.createCliProxyApiKeyPersistenceGuard(
    { ...identity },
    () => identity,
    () => { clearCount += 1; draft = ""; },
  );
  const saveWithReplacement = bridge.cliProxy.save(validSaveRequest, replacementGuard);
  identity = { revision: 3, origin };
  draft = "newer-key";
  await assert.rejects(saveWithReplacement, /coordinator restart failed/);
  assert.equal(clearCount, 1, "the delayed second event has not run yet");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(clearCount, 1, "late persistence ack cannot erase the replacement draft");
  assert.equal(draft, "newer-key");
  assert.equal(rendererListeners.get("sand:cli-proxy-persisted")?.size ?? 0, 0);
});

test("CLI-proxy mutation fences are always released after mutation or revoke failure", async () => {
  const loaded = await loadModule();
  try {
    const saveFailure = register(loaded.module, {
      stores: {
        userSecretsStore: {},
        clientPersistenceStore: {},
        cliProxySecretStore: {
          async save() { saveFailure.order.push("save"); throw new Error("keychain failed"); },
          async remove() { return { configured: false }; },
          async status() { return { configured: false }; },
          async getConnectionConfig() { return {}; },
        },
      },
      async beforeCliProxyMutation() { saveFailure.order.push("before"); },
      async afterCliProxyMutation() { saveFailure.order.push("after"); },
    });
    await assert.rejects(
      () => saveFailure.handlers.get("sand:cli-proxy-save")({}, validSaveRequest),
      /keychain failed/,
    );
    assert.deepEqual(saveFailure.order, ["before", "save", "after"]);

    const revokeFailure = register(loaded.module, {
      async beforeCliProxyMutation() {
        revokeFailure.order.push("before");
        throw new Error("revoke and stop failed");
      },
      async afterCliProxyMutation() { revokeFailure.order.push("after"); },
    });
    await assert.rejects(
      () => revokeFailure.handlers.get("sand:cli-proxy-delete")({}),
      /revoke and stop failed/,
    );
    assert.deepEqual(revokeFailure.order, ["before", "after"]);
  } finally {
    await loaded.dispose();
  }
});

test("invalid CLI-proxy saves fail before revocation, mutation, or refresh", async (t) => {
  const loaded = await loadModule();
  try {
    const cases = [
      {
        name: "URL",
        request: { ...validSaveRequest, baseUrl: "http://127.0.0.1:20128/not-v1" },
        message: /exact \/v1 API root/,
      },
      {
        name: "model",
        request: { ...validSaveRequest, model: "bad\nmodel" },
        message: /without control characters/,
      },
      {
        name: "protocol",
        request: { ...validSaveRequest, protocol: "legacy-completions" },
        message: /Unknown 9Router API protocol/,
      },
      {
        name: "API key",
        request: { ...validSaveRequest, apiKey: "   " },
        message: /API key is empty/,
      },
    ];
    for (const testCase of cases) {
      await t.test(testCase.name, async () => {
        const invalid = register(loaded.module);
        await assert.rejects(
          () => invalid.handlers.get("sand:cli-proxy-save")({}, testCase.request),
          testCase.message,
        );
        assert.deepEqual(invalid.order, []);
      });
    }
  } finally {
    await loaded.dispose();
  }
});
