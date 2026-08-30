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
    allowTailscaleHttp: false,
  });
});

test("9Router URL policy allows loopback HTTP and explicit remote HTTPS only", async () => {
  const proxy = await loadModule();
  assert.equal(proxy.normalizeCliProxyBaseUrl("http://127.0.0.1:20128/v1/", false), "http://127.0.0.1:20128/v1");
  assert.equal(proxy.normalizeCliProxyBaseUrl("http://127.255.255.254:20128/v1", false), "http://127.255.255.254:20128/v1");
  assert.equal(proxy.normalizeCliProxyBaseUrl("http://[::1]:20128/v1", false), "http://[::1]:20128/v1");
  assert.equal(proxy.normalizeCliProxyBaseUrl("https://router.example/v1", true), "https://router.example/v1");
  for (const value of [
    "http://localhost:20128/v1",
    "http://router.example/v1",
    "https://router.example/v1",
    "http://host.docker.internal:20128/v1",
    "http://user:pass@127.0.0.1:20128/v1",
    "http://127.0.0.1:20128/v1?key=x",
    "http://127.0.0.1:20128/v1#x",
    "http://127.0.0.1:20128/v1/chat/completions",
    "http://127.0.0.1:20128/codex",
    "http://127.0.0.1:20128/CODEX/chat/completions",
    "http://127.0.0.1:20128/api/v1",
    "http://127.0.0.1:20128/v1/other",
    "file:///tmp/v1",
  ]) assert.throws(() => proxy.normalizeCliProxyBaseUrl(value, false));
});

test("9Router URL policy allows only literal Tailscale IP ranges with the HTTP opt-in", async () => {
  const proxy = await loadModule();
  for (const address of ["100.64.0.0", "100.112.10.8", "100.127.255.255"]) {
    const value = `http://${address}:20128/v1/`;
    assert.equal(proxy.normalizeCliProxyBaseUrl(value, false, true), value.slice(0, -1));
    assert.throws(() => proxy.normalizeCliProxyBaseUrl(value, false, false), /Tailscale opt-in/);
  }
  for (const address of ["[fd7a:115c:a1e0::]", "[fd7a:115c:a1e0::1]", "[fd7a:115c:a1e0:ffff:ffff:ffff:ffff:ffff]"]) {
    const value = `http://${address}:20128/v1`;
    assert.equal(proxy.normalizeCliProxyBaseUrl(value, false, true), value);
  }
  for (const value of ["http://100.112.10.8/v1", "http://100.112.10.8:20127/v1", "http://[fd7a:115c:a1e0::1]:8080/v1"]) {
    assert.throws(() => proxy.normalizeCliProxyBaseUrl(value, false, true), /port 20128/);
  }
});

test("9Router Tailscale HTTP opt-in rejects adjacent, private, public, metadata, hostname, and ambiguous literals", async () => {
  const proxy = await loadModule();
  for (const address of [
    "100.63.255.255",
    "100.128.0.0",
    "10.0.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "8.8.8.8",
    "router.tailnet.ts.net",
    "localhost",
    "100.112.10.8.example.com",
    "1681918472",
    "0144.0160.0012.0010",
    "[fd7a:115c:a1df:ffff::1]",
    "[fd7a:115c:a1e1::1]",
    "[::ffff:100.112.10.8]",
  ]) assert.throws(() => proxy.normalizeCliProxyBaseUrl(`http://${address}:20128/v1`, false, true));
});

test("9Router settings allow an empty manual model but turn leases require one", async () => {
  const proxy = await loadModule();
  const config = proxy.normalizeCliProxyPublicConfig({ baseUrl: proxy.CLI_PROXY_DEFAULT_BASE_URL, model: "", protocol: "chat-completions", allowRemoteHttps: false, allowTailscaleHttp: false });
  assert.equal(config.model, "");
  assert.throws(() => proxy.requireCliProxyModel(""), /Choose a valid 9Router model/);
  assert.equal(proxy.requireCliProxyModel("openai/gpt-test"), "openai/gpt-test");
  assert.throws(() => proxy.normalizeCliProxyTurnConfig({ ...config, model: "openai/gpt-test" }), /API key/);
});
