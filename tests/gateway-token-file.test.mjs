import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(import.meta.dirname, "..");

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-gateway-token-module-"));
  const output = path.join(temporary, "gateway-config.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/host/gateway-config.ts")],
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

test("gateway token file must be a private direct file and excludes a duplicate env token", async () => {
  const loaded = await loadModule();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-gateway-token-file-"));
  try {
    const token = "a".repeat(64);
    const target = path.join(temporary, "gateway-token");
    await writeFile(target, `${token}\n`, { mode: 0o600 });
    await chmod(target, 0o600);
    const config = loaded.module.resolveGatewayServerConfig({
      SAND_GATEWAY_BIND_HOST: "0.0.0.0",
      SAND_GATEWAY_TOKEN_FILE: target,
    });
    assert.equal(config.authToken, token);
    assert.throws(() => loaded.module.resolveGatewayServerConfig({
      SAND_GATEWAY_TOKEN: "b".repeat(64),
      SAND_GATEWAY_TOKEN_FILE: target,
    }), /either a direct token or a token file/);

    await chmod(target, 0o644);
    assert.throws(() => loaded.module.readPrivateGatewayTokenFile(target), /private gateway token file/);
    await chmod(target, 0o600);
    const linked = path.join(temporary, "gateway-token-link");
    await symlink(target, linked);
    assert.throws(() => loaded.module.readPrivateGatewayTokenFile(linked), /private gateway token file/);
  } finally {
    await loaded.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});
