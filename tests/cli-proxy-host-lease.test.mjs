import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const validConfig = {
  baseUrl: "http://127.0.0.1:20128/v1",
  model: "provider/model",
  protocol: "chat-completions",
  allowRemoteHttps: false,
  allowTailscaleHttp: false,
  apiKey: "lease-secret",
};

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-cli-proxy-host-lease-"));
  const output = path.join(temporary, "lease.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/host/extensions/inference/cli-proxy-credential-lease.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  return { module: await import(`${pathToFileURL(output).href}?${Date.now()}`), dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("host credential lease is normalized, memory-only, and expires closed", async () => {
  const loaded = await loadModule();
  try {
    const receipt = loaded.module.installCliProxyCredentialLease(validConfig, 1_000);
    assert.deepEqual(Object.keys(receipt), ["expiresAtMs"]);
    assert.equal(JSON.stringify(receipt).includes(validConfig.apiKey), false);
    assert.equal(loaded.module.requireCliProxyCredentialLease(1_001).apiKey, validConfig.apiKey);
    assert.equal(loaded.module.hasCliProxyCredentialLease(receipt.expiresAtMs), false);
    assert.throws(() => loaded.module.requireCliProxyCredentialLease(receipt.expiresAtMs), /credential lease is unavailable/);
    assert.throws(() => loaded.module.installCliProxyCredentialLease({ ...validConfig, baseUrl: "http://example.com/v1" }), /Plain HTTP is allowed only/);
  } finally {
    loaded.module.clearCliProxyCredentialLease();
    await loaded.dispose();
  }
});

test("authenticated host gateway exposes only a lease setter", async () => {
  const [api, protocol, inference] = await Promise.all([
    readFile(path.join(repoRoot, "source/host/host-gateway-api.ts"), "utf8"),
    readFile(path.join(repoRoot, "source/host/gateway-protocol.ts"), "utf8"),
    readFile(path.join(repoRoot, "source/host/extensions/inference/inference-service.ts"), "utf8"),
  ]);
  assert.match(api, /leaseCliProxyCredential: \(args: any\) =>\s*installCliProxyCredentialLease\(args\?\.config\)/);
  assert.match(protocol, /leaseCliProxyCredential: .*api\.leaseCliProxyCredential/);
  assert.doesNotMatch(api, /getCliProxyCredentialLease/);
  assert.doesNotMatch(protocol, /getCliProxyCredentialLease/);
  assert.match(inference, /getInferenceProvider\(\) === "cursor"[\s\S]*cursor\.resolvePrivacyMode\(\)[\s\S]*PrivacyMode\.NO_STORAGE/);
});
