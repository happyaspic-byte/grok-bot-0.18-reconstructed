import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(import.meta.dirname, "..");

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-coordinator-runtime-disposal-"));
  const output = path.join(temporary, "production-provider.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/electron-main/coordinator/production-provider.ts")],
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

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test("coordinator runtime disposal observes every shutdown phase", async (t) => {
  const loaded = await loadModule();
  t.after(loaded.dispose);
  const dispose = loaded.module.quiesceNativeTurnsAndDisposeCoordinatorRuntime;

  await t.test("a synchronous quiesce failure still starts and awaits runtime disposal", async () => {
    const failure = new Error("quiesce failed synchronously");
    const runtime = Promise.withResolvers();
    const calls = [];
    let settled = false;
    const shutdown = dispose(
      () => {
        calls.push("quiesce");
        throw failure;
      },
      () => {
        calls.push("runtime");
        return runtime.promise;
      },
    );
    void shutdown.then(
      () => { settled = true; },
      () => { settled = true; },
    );

    assert.deepEqual(calls, ["quiesce", "runtime"]);
    await nextTurn();
    assert.equal(settled, false);
    runtime.resolve();
    await assert.rejects(shutdown, (error) => error === failure);
  });

  await t.test("a synchronous runtime failure still awaits quiescence", async () => {
    const failure = new Error("runtime disposal failed synchronously");
    const quiescence = Promise.withResolvers();
    const calls = [];
    let settled = false;
    const shutdown = dispose(
      () => {
        calls.push("quiesce");
        return quiescence.promise;
      },
      () => {
        calls.push("runtime");
        throw failure;
      },
    );
    void shutdown.then(
      () => { settled = true; },
      () => { settled = true; },
    );

    assert.deepEqual(calls, ["quiesce", "runtime"]);
    await nextTurn();
    assert.equal(settled, false);
    quiescence.resolve();
    await assert.rejects(shutdown, (error) => error === failure);
  });

  await t.test("two shutdown failures are preserved in an AggregateError", async () => {
    const quiesceFailure = new Error("quiesce failed");
    const runtimeFailure = new Error("runtime failed");
    const calls = [];
    const shutdown = dispose(
      () => {
        calls.push("quiesce");
        throw quiesceFailure;
      },
      () => {
        calls.push("runtime");
        throw runtimeFailure;
      },
    );

    assert.deepEqual(calls, ["quiesce", "runtime"]);
    await assert.rejects(shutdown, (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.deepEqual(error.errors, [quiesceFailure, runtimeFailure]);
      return true;
    });
  });

  await t.test("runtime shutdown starts before fallible cleanup and every cleanup is attempted", async () => {
    const runtimeFailure = new Error("runtime failed");
    const firstCleanupFailure = new Error("first cleanup failed");
    const lastCleanupFailure = new Error("last cleanup failed");
    const calls = [];
    const shutdown = dispose(
      async () => { calls.push("quiesce"); },
      () => {
        calls.push("runtime");
        throw runtimeFailure;
      },
      [
        () => {
          calls.push("cleanup:first");
          throw firstCleanupFailure;
        },
        () => { calls.push("cleanup:middle"); },
        () => {
          calls.push("cleanup:last");
          throw lastCleanupFailure;
        },
      ],
    );

    assert.deepEqual(calls, [
      "quiesce",
      "runtime",
      "cleanup:first",
      "cleanup:middle",
      "cleanup:last",
    ]);
    await assert.rejects(shutdown, (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.deepEqual(error.errors, [
        runtimeFailure,
        firstCleanupFailure,
        lastCleanupFailure,
      ]);
      return true;
    });
  });
});
