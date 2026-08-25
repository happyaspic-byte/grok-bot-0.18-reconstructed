import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = { baseUrl: "http://127.0.0.1:20128/v1", model: "", protocol: "chat-completions", allowRemoteHttps: false, apiKey: "client-key" };

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-cli-models-")), output = path.join(temporary, "models.mjs");
  await build({ entryPoints: [path.join(repoRoot, "source/shared/node/cli-proxy-models.ts")], outfile: output, bundle: true, format: "esm", platform: "node", target: "node22" });
  return { module: await import(`${pathToFileURL(output).href}?${Date.now()}`), dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("model probe authenticates, bounds, deduplicates, and reports latency", async () => {
  const loaded = await loadModule();
  try {
    let request; const ticks = [100, 142];
    const probe = await loaded.module.fetchCliProxyModels(config, { now: () => ticks.shift(), fetch: async (url, init) => { request = { url, init }; return Response.json({ data: [{ id: "provider/a" }, { id: "provider/a" }, { id: "provider/b" }, { id: "bad\nmodel" }, {}] }); } });
    assert.equal(request.url, "http://127.0.0.1:20128/v1/models");
    assert.equal(request.init.redirect, "error");
    assert.equal(request.init.headers.authorization, "Bearer client-key");
    assert.deepEqual(probe.models, ["provider/a", "provider/b"]);
    assert.equal(probe.latencyMs, 42);
  } finally { await loaded.dispose(); }
});

test("chunked model responses are cancelled as soon as the 2 MiB cap is crossed", async () => {
  const loaded = await loadModule();
  try {
    let cancelled = false;
    const response = new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
      cancel() { cancelled = true; },
    }), { status: 200, headers: { "content-type": "application/json" } });
    await assert.rejects(() => loaded.module.fetchCliProxyModels(config, { fetch: async () => response }), /size limit/);
    assert.equal(cancelled, true);
  } finally { await loaded.dispose(); }
});

test("empty model lists remain usable and authentication errors are clear but redacted", async () => {
  const loaded = await loadModule();
  try {
    const empty = await loaded.module.fetchCliProxyModels(config, { fetch: async () => Response.json({ data: [] }) });
    assert.equal(empty.outcome, "empty");
    assert.match(empty.message, /Enter the model manually/);
    await assert.rejects(() => loaded.module.fetchCliProxyModels(config, { fetch: async () => new Response("client-key sensitive", { status: 401 }) }), (error) => /proxy\/client API key/.test(error.message) && !error.message.includes("client-key"));
  } finally { await loaded.dispose(); }
});
