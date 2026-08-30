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
      ["set:cursor", "strict:cursor", "stop", "set:cli-proxy"],
    );
  } finally {
    await loaded.dispose();
  }
});
