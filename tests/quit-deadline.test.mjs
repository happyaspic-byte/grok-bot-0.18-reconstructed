import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(import.meta.dirname, "..");

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-quit-deadline-"));
  const output = path.join(temporary, "quit-deadline.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/electron-main/quit-deadline.ts")],
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

test("quit coordinator steps are bounded so fail-closed Docker stop can continue", async () => {
  const loaded = await loadModule();
  try {
    const never = new Promise(() => {});
    await assert.rejects(
      loaded.module.withDesktopQuitDeadline("stalled step", never, 10),
      (error) => error.name === "DesktopQuitDeadlineError"
        && /stalled step did not settle within 10 ms/.test(error.message),
    );
    assert.equal(
      await loaded.module.withDesktopQuitDeadline("quick step", Promise.resolve("done"), 100),
      "done",
    );
    await assert.rejects(
      loaded.module.withDesktopQuitDeadline("invalid", Promise.resolve(), 0),
      /positive finite number/,
    );
  } finally {
    await loaded.dispose();
  }
});
