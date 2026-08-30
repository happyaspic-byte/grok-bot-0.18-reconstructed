import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(import.meta.dirname, "..");
const loopbackConfig = {
  baseUrl: "http://127.0.0.1:20128/v1",
  model: "provider/model",
  protocol: "chat-completions",
  allowRemoteHttps: false,
  allowTailscaleHttp: false,
  apiKey: "probe-secret",
};

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-cli-proxy-container-probe-"));
  const output = path.join(temporary, "probe.mjs");
  await build({
    stdin: {
      contents: [
        'export * from "./source/host/extensions/inference/cli-proxy-container-probe.ts";',
        'export { installCliProxyCredentialLease, clearCliProxyCredentialLease } from "./source/host/extensions/inference/cli-proxy-credential-lease.ts";',
      ].join("\n"),
      resolveDir: repoRoot,
      sourcefile: "container-probe-test-entry.ts",
      loader: "ts",
    },
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

test("container model probe authenticates in memory and returns no credential material", async () => {
  const loaded = await loadModule();
  try {
    loaded.module.installCliProxyCredentialLease(loopbackConfig);
    const requests = [];
    const ticks = [100, 112];
    const receipt = await loaded.module.probeCliProxyModelsFromContainer({
      now: () => ticks.shift(),
      fetch: async (url, init) => {
        requests.push({ url, init });
        return new Response(JSON.stringify({ data: [{ id: "provider/model" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    assert.deepEqual(receipt, { outcome: "ok", latencyMs: 12 });
    assert.equal(JSON.stringify(receipt).includes(loopbackConfig.apiKey), false);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "http://127.0.0.1:20128/v1/models");
    assert.equal(requests[0].init.headers.authorization, "Bearer probe-secret");
    assert.equal(requests[0].init.redirect, "error");

    const source = await readFile(
      path.join(repoRoot, "source/host/extensions/inference/cli-proxy-container-probe.ts"),
      "utf8",
    );
    assert.doesNotMatch(source, /node:fs|writeFile|process\.env/);
  } finally {
    loaded.module.clearCliProxyCredentialLease();
    await loaded.dispose();
  }
});

test("container model probe requires the installed memory lease", async () => {
  const loaded = await loadModule();
  try {
    await assert.rejects(
      () => loaded.module.probeCliProxyModelsFromContainer(),
      /credential lease is unavailable/,
    );
  } finally {
    loaded.module.clearCliProxyCredentialLease();
    await loaded.dispose();
  }
});

test("container model probe gives Docker and Tailscale guidance only for reachability failures", async (t) => {
  const loaded = await loadModule();
  try {
    const unreachable = { fetch: async () => { throw new Error("connect ECONNREFUSED"); } };
    await t.test("same-PC loopback", async () => {
      loaded.module.installCliProxyCredentialLease(loopbackConfig);
      await assert.rejects(
        () => loaded.module.probeCliProxyModelsFromContainer(unreachable),
        (error) => {
          assert.match(error.message, /Local Docker VM cannot reach a same-PC 9Router/);
          assert.match(error.message, /container loopback points to the Docker VM, not Windows/);
          assert.match(error.message, /literal Tailscale IP on port 20128/);
          assert.equal(error.message.includes(loopbackConfig.apiKey), false);
          return true;
        },
      );
    });

    await t.test("Tailscale peer", async () => {
      loaded.module.installCliProxyCredentialLease({
        ...loopbackConfig,
        baseUrl: "http://100.112.10.8:20128/v1",
        allowTailscaleHttp: true,
      });
      await assert.rejects(
        () => loaded.module.probeCliProxyModelsFromContainer(unreachable),
        /Docker Desktop has outbound network access.*tailnet ACLs allow port 20128/,
      );
    });

    await t.test("authentication rejection", async () => {
      loaded.module.installCliProxyCredentialLease(loopbackConfig);
      await assert.rejects(
        () => loaded.module.probeCliProxyModelsFromContainer({
          fetch: async () => new Response("denied", { status: 401 }),
        }),
        (error) => {
          assert.match(error.message, /rejected the proxy\/client API key/);
          assert.doesNotMatch(error.message, /Tailscale|container loopback/);
          return true;
        },
      );
    });
  } finally {
    loaded.module.clearCliProxyCredentialLease();
    await loaded.dispose();
  }
});

test("probe gateway RPC ignores any supplied config and forwards no arguments", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-cli-proxy-protocol-"));
  const output = path.join(temporary, "protocol.mjs");
  try {
    await build({
      entryPoints: [path.join(repoRoot, "source/host/gateway-protocol.ts")],
      outfile: output,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
    });
    const protocol = await import(`${pathToFileURL(output).href}?${Date.now()}`);
    let observed;
    const result = protocol.SAND_GATEWAY_COMMANDS.probeCliProxyModels({
      probeCliProxyModels(...args) {
        observed = args;
        return { outcome: "ok" };
      },
    }, JSON.stringify({ config: { apiKey: "injected-secret" } }));
    assert.deepEqual(observed, []);
    assert.deepEqual(result, { outcome: "ok" });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("documented Local Docker setup rejects Windows loopback as a same-PC route", async () => {
  const [readme, architecture] = await Promise.all([
    readFile(path.join(repoRoot, "README.md"), "utf8"),
    readFile(path.join(repoRoot, "docs/ARCHITECTURE.md"), "utf8"),
  ]);
  for (const document of [readme, architecture]) {
    assert.match(document, /container loopback[\s\S]{0,80}not Windows\s+loopback/iu);
    assert.doesNotMatch(
      document,
      /same-PC[\s\S]{0,100}(?:can use|loopback default remains)[\s\S]{0,100}`http:\/\/127\.0\.0\.1:20128\/v1`/iu,
    );
  }
});
