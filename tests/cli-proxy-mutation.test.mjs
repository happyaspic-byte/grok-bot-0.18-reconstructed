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
