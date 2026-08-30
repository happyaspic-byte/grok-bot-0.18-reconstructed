import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(import.meta.dirname, "..");

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-coordinator-native-cli-proxy-module-"));
  const output = path.join(temporary, "inference-router.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/node-agent-coordinator/inference-router.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  return { module: await import(`${pathToFileURL(output).href}?${Date.now()}`), dispose: () => rm(temporary, { recursive: true, force: true }) };
}

async function writeRouterSettings(dataDir, values) {
  await writeFile(path.join(dataDir, "settings.json"), `${JSON.stringify({ version: 1, ...values })}\n`, { mode: 0o600 });
}

test("only local Docker 9Router turns use the native host agent loop", async () => {
  const loaded = await loadModule();
  try {
    assert.equal(loaded.module.shouldUseNativeCliProxyHost("cli-proxy", "local-docker"), true);
    assert.equal(loaded.module.shouldUseNativeCliProxyHost("cli-proxy", "remote"), false);
    assert.equal(loaded.module.shouldUseNativeCliProxyHost("codex", "local-docker"), false);
    assert.equal(loaded.module.shouldUseNativeCliProxyHost("cursor", "local-docker"), false);
  } finally {
    await loaded.dispose();
  }
});

test("local Docker 9Router requires main-owned resync and lease preparation before native sendPrompt handoff", async () => {
  const loaded = await loadModule();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grok-coordinator-native-cli-proxy-data-"));
  try {
    await writeRouterSettings(dataDir, { inferenceProvider: "cli-proxy", boxRuntime: "local-docker" });
    const calls = [];
    const router = loaded.module.createCoordinatorInferenceRouter({
      dataDir,
      postEvent() {},
      async dispatchRemote(method, args) {
        calls.push({ method, args });
        if (method === "prepareCliProxyNativeTurn") return { prepared: true };
        throw new Error(`unexpected coordinator remote call: ${method}`);
      },
    });

    const routed = await router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "Use the computer" });

    assert.deepEqual(routed, { handled: false });
    assert.deepEqual(calls, [
      { method: "prepareCliProxyNativeTurn", args: {} },
    ]);
    await assert.rejects(() => stat(path.join(dataDir, "inference-router-transcript.json")), { code: "ENOENT" });
  } finally {
    await loaded.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("native 9Router handoff fails closed when full preparation fails", async () => {
  const loaded = await loadModule();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grok-coordinator-native-cli-proxy-fail-"));
  try {
    await writeRouterSettings(dataDir, { inferenceProvider: "cli-proxy", boxRuntime: "local-docker" });
    const calls = [];
    const router = loaded.module.createCoordinatorInferenceRouter({
      dataDir,
      postEvent() {},
      async dispatchRemote(method, args) {
        calls.push({ method, args });
        if (method === "prepareCliProxyNativeTurn") {
          throw new Error("Coordinator resync failed at: box_secrets");
        }
        throw new Error(`unexpected coordinator remote call: ${method}`);
      },
    });

    await assert.rejects(
      () => router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "hello" }),
      /resync failed at: box_secrets/,
    );
    assert.deepEqual(calls, [
      { method: "prepareCliProxyNativeTurn", args: {} },
    ]);
  } finally {
    await loaded.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("local Docker 9Router leaves transcript and reactions to the native host", async () => {
  const loaded = await loadModule();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grok-coordinator-native-cli-proxy-transcript-"));
  try {
    await writeRouterSettings(dataDir, { inferenceProvider: "cli-proxy", boxRuntime: "local-docker" });
    const calls = [];
    const router = loaded.module.createCoordinatorInferenceRouter({
      dataDir,
      postEvent() {},
      async dispatchRemote(method, args) {
        calls.push({ method, args });
        return { source: "native-host" };
      },
    });

    assert.deepEqual(await router.dispatch("getAgentTranscriptTail", { id: "agent-1" }), { handled: false });
    assert.deepEqual(await router.dispatch("reactToMessage", { agentId: "agent-1", entryId: "native-1", emoji: "👍" }), { handled: false });
    assert.deepEqual(calls, []);
  } finally {
    await loaded.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});
