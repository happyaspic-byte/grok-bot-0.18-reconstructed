import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(import.meta.dirname, "..");

async function loadModel() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-renderer-model-"));
  const output = path.join(temporary, "model.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "frontend/src/production/model.ts")],
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

test("renderer projects native host roster and upsert envelopes without clearing agents", async () => {
  const loaded = await loadModel();
  try {
    const older = { id: "agent-old", name: "Older", updatedAt: 10 };
    const newer = { id: "agent-new", name: "Newer", updatedAt: 20, isRunning: true };
    const roster = loaded.module.projectRendererAgents({
      activeAgentId: newer.id,
      agents: [older, newer],
      coverage: { kind: "complete-roster" },
    }, 100);
    assert.deepEqual(roster.map(({ id }) => id), [newer.id, older.id]);
    assert.equal(roster[0].isRunning, true);

    const upsert = loaded.module.projectRendererAgent({
      activeAgentId: newer.id,
      agent: { ...newer, currentActivity: "Running a tool" },
      ordered: { epoch: "fixture", sequence: 1 },
    }, 100);
    assert.equal(upsert?.id, newer.id);
    assert.equal(upsert?.currentActivity, "Running a tool");
    assert.equal("agent" in upsert.raw, false, "raw agent data must not retain the transport envelope");

    assert.deepEqual(loaded.module.projectRendererAgents({ agents: "invalid" }), []);
    assert.equal(loaded.module.projectRendererAgent({ agent: null }), null);
  } finally {
    await loaded.dispose();
  }
});
