import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { transform } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const source = await readFile(path.join(repoRoot, "source/shared/cli-proxy.ts"), "utf8");
  const { code } = await transform(source, { format: "esm", loader: "ts", target: "es2023" });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

test("9Router defaults to the authenticated loopback /v1 root and Chat Completions", async () => {
  const proxy = await loadModule();
  assert.deepEqual(proxy.CLI_PROXY_DEFAULT_CONFIG, {
    baseUrl: "http://127.0.0.1:20128/v1",
    model: "",
    protocol: "chat-completions",
    allowRemoteHttps: false,
  });
});

test("9Router URL policy allows loopback HTTP and explicit remote HTTPS only", async () => {
  const proxy = await loadModule();
  assert.equal(proxy.normalizeCliProxyBaseUrl("http://127.0.0.1:20128/v1/", false), "http://127.0.0.1:20128/v1");
  assert.equal(proxy.normalizeCliProxyBaseUrl("http://localhost:20128/v1", false), "http://localhost:20128/v1");
  assert.equal(proxy.normalizeCliProxyBaseUrl("https://router.example/v1", true), "https://router.example/v1");
  for (const value of [
    "http://router.example/v1",
    "https://router.example/v1",
    "http://host.docker.internal:20128/v1",
    "http://user:pass@127.0.0.1:20128/v1",
    "http://127.0.0.1:20128/v1?key=x",
    "http://127.0.0.1:20128/v1#x",
    "http://127.0.0.1:20128/v1/chat/completions",
    "file:///tmp/v1",
  ]) assert.throws(() => proxy.normalizeCliProxyBaseUrl(value, false));
});

test("9Router settings allow an empty manual model but turn leases require one", async () => {
  const proxy = await loadModule();
  const config = proxy.normalizeCliProxyPublicConfig({ baseUrl: proxy.CLI_PROXY_DEFAULT_BASE_URL, model: "", protocol: "chat-completions", allowRemoteHttps: false });
  assert.equal(config.model, "");
  assert.throws(() => proxy.requireCliProxyModel(""), /Choose a valid 9Router model/);
  assert.equal(proxy.requireCliProxyModel("openai/gpt-test"), "openai/gpt-test");
});
