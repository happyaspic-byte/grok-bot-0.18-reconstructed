import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "grok-local-workspace-"));
  const output = path.join(directory, "local-workspace.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "frontend/src/production/local-workspace.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22"
  });
  return { directory, module: await import(`${pathToFileURL(output).href}?t=${Date.now()}`) };
}

function bridge({ provider = "cli-proxy", mode = "local-docker", configured = true, model = "provider/model", protocol = "chat-completions" } = {}) {
  return {
    agent: {
      getInferenceRouter: async () => ({ provider }),
      getBoxRuntime: async () => ({ mode })
    },
    cliProxy: { status: async () => ({ configured, model, protocol }) }
  };
}

test("local workspace readiness requires 9Router, local Docker, a credential, model, and native protocol", async () => {
  const loaded = await loadModule();
  try {
    assert.deepEqual(await loaded.module.readLocalWorkspaceReadiness(bridge()), {
      kind: "ready",
      workspaceId: "local:9router"
    });
    assert.deepEqual(await loaded.module.readLocalWorkspaceReadiness(bridge({ provider: "cursor" })), { kind: "disabled" });
    assert.deepEqual(await loaded.module.readLocalWorkspaceReadiness(bridge({ mode: "remote" })), { kind: "disabled" });
    assert.deepEqual(await loaded.module.readLocalWorkspaceReadiness(bridge({ configured: false })), { kind: "disabled" });
    assert.deepEqual(await loaded.module.readLocalWorkspaceReadiness(bridge({ model: "  " })), { kind: "disabled" });
    assert.deepEqual(await loaded.module.readLocalWorkspaceReadiness(bridge({ protocol: "responses" })), { kind: "disabled" });
  } finally {
    await rm(loaded.directory, { recursive: true, force: true });
  }
});

test("local workspace readiness fails closed when an existing settings edge fails", async () => {
  const loaded = await loadModule();
  try {
    const value = bridge();
    value.agent.getBoxRuntime = async () => { throw new Error("Docker unavailable"); };
    assert.deepEqual(await loaded.module.readLocalWorkspaceReadiness(value), { kind: "disabled" });
    assert.deepEqual(await loaded.module.readLocalWorkspaceReadiness({ ...value, agent: { getInferenceRouter: value.agent.getInferenceRouter } }), { kind: "disabled" });
  } finally {
    await rm(loaded.directory, { recursive: true, force: true });
  }
});

test("workspace session prefers real login and never impersonates Cursor auth", async () => {
  const loaded = await loadModule();
  try {
    const local = { kind: "ready", workspaceId: "local:9router" };
    assert.deepEqual(loaded.module.projectWorkspaceSession({ kind: "logged-out" }, local), {
      kind: "ready",
      accountSlot: "local:9router",
      identity: "local:9router",
      source: "local-9router"
    });
    assert.deepEqual(loaded.module.projectWorkspaceSession({ kind: "logged-in", authId: "cursor-user" }, local), {
      kind: "ready",
      accountSlot: "cursor-user",
      identity: "cursor:cursor-user",
      source: "cursor"
    });
    assert.deepEqual(loaded.module.projectWorkspaceSession({ kind: "logged-out" }, { kind: "disabled" }), {
      kind: "unavailable",
      accountSlot: null,
      identity: null,
      source: null
    });
    assert.deepEqual(loaded.module.projectWorkspaceSession({ kind: "logging-in" }, local), {
      kind: "unavailable",
      accountSlot: null,
      identity: null,
      source: null
    });
  } finally {
    await rm(loaded.directory, { recursive: true, force: true });
  }
});

test("production renderer unlocks local core while keeping account-only surfaces gated", async () => {
  const renderer = await readFile(path.join(repoRoot, "frontend/src/production/ProductionRenderer.tsx"), "utf8");
  assert.match(renderer, /const workspaceReady = workspaceSession\.kind === "ready"/);
  assert.match(renderer, /const transcriptAccountSlot = workspaceAccountSlot/);
  assert.match(renderer, /if \(!isCurrent\(\) \|\| !workspaceReadyRef\.current\) return/);
  assert.match(renderer, /overlay === "plugins"[^\n]+isCursorLoggedIn/);
  assert.match(renderer, /transcriptCardCloudAgents\.setScope\(isCursorLoggedIn/);
  assert.match(renderer, /transcriptCardListenerIntegrations\?\.setScope\(isCursorLoggedIn/);
  assert.match(renderer, /const showSignIn = bridge != null && workspaceSession\.kind === "unavailable"/);
  assert.doesNotMatch(renderer, /setAccount\(\{\s*kind:\s*"logged-in"/);
});
