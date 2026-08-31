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

test("authenticated host gateway exposes only credential-consuming operations", async () => {
  const [api, protocol, inference, mainMethods] = await Promise.all([
    readFile(path.join(repoRoot, "source/host/host-gateway-api.ts"), "utf8"),
    readFile(path.join(repoRoot, "source/host/gateway-protocol.ts"), "utf8"),
    readFile(path.join(repoRoot, "source/host/extensions/inference/inference-service.ts"), "utf8"),
    readFile(path.join(repoRoot, "source/shared/rpc/coordinator-main.ts"), "utf8"),
  ]);
  assert.match(api, /leaseCliProxyCredential: \(args: any\) =>\s*installCliProxyCredentialLease\(args\?\.config\)/);
  assert.match(api, /probeCliProxyModels: \(\) => probeCliProxyModelsFromContainer\(\)/);
  assert.match(protocol, /leaseCliProxyCredential: .*api\.leaseCliProxyCredential/);
  assert.match(protocol, /probeCliProxyModels: \(api: GatewayApi\) => api\.probeCliProxyModels\(\)/);
  assert.match(mainMethods, /probeCliProxyModels: \{ args: "object" \}/);
  assert.doesNotMatch(api, /getCliProxyCredentialLease/);
  assert.doesNotMatch(protocol, /getCliProxyCredentialLease/);
  assert.match(inference, /getInferenceProvider\(\) === "cursor"[\s\S]*cursor\.resolvePrivacyMode\(\)[\s\S]*PrivacyMode\.NO_STORAGE/);
});

test("clean app quit revokes the memory lease before disposing the coordinator", async () => {
  const source = await readFile(path.join(repoRoot, "source/electron-main/main-production-services.ts"), "utf8");
  const quiesce = source.indexOf("coordinator.quiesceCliProxyNativeTurns()");
  const revoke = source.indexOf("clearCliProxyCredentialLease: true");
  const legsDispose = source.indexOf("coordinatorLegs.dispose()", revoke);
  const dispose = source.indexOf('disposeQuitPhase(coordinator, "coordinator")');
  const stop = source.indexOf("await stopLocalDockerBoxForQuit(settings.settingsStore.settingsPath)", revoke);
  assert.ok(quiesce >= 0 && quiesce < revoke, "quit must close native-turn intake before clearing the lease");
  assert.ok(revoke >= 0, "quit must request strict 9Router lease revocation");
  assert.ok(legsDispose > revoke, "quit must cut coordinator RPC legs after the bounded lease clear");
  assert.ok(dispose > legsDispose, "quit must dispose the coordinator after cutting its RPC legs");
  assert.ok(stop > dispose, "the Docker lifecycle stop must be the final host mutation");
  assert.match(source, /withDesktopQuitDeadline\([\s\S]*coordinator\.quiesceCliProxyNativeTurns\(\)/);
  assert.match(source, /withDesktopQuitDeadline\([\s\S]*coordinator\.pushHostSettingsStrict\(\{ clearCliProxyCredentialLease: true \}\)/);
  assert.match(source, /withDesktopQuitDeadline\(`\$\{area\} disposal`, disposeOnce\(value\)\)/);
  assert.match(source, /withDesktopQuitDeadline\("service graph disposal", disposeGraph\(\)\)/);
  assert.match(source, /if \(settings != null\)/);
  assert.doesNotMatch(source, /getInferenceProvider\(\) === "cli-proxy"[\s\S]{0,180}getBoxRuntime\(\) === "local-docker"/);
  assert.match(source, /cli-proxy-quit-quiesce/);
  assert.match(source, /cli-proxy-quit-revoke/);
});
