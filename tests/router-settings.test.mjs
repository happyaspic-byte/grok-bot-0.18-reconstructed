import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { transform } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const routerSourcePath = path.join(repoRoot, "frontend/src/recovered/features/settings/overlay/router.ts");

async function loadRouterModule() {
  const source = await readFile(routerSourcePath, "utf8");
  const { code: output } = await transform(source, { format: "esm", loader: "ts", target: "es2022" });
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

test("router provider preference defaults to Cursor and round-trips every provider", async () => {
  const router = await loadRouterModule();
  assert.deepEqual(router.ROUTER_PROVIDERS.map(({ id }) => id), ["cursor", "claude-code", "codex", "openrouter", "cli-proxy"]);
  assert.equal(router.parseRouterProviderPreference(null), "cursor");
  assert.equal(router.parseRouterProviderPreference("not-json"), "cursor");
  assert.equal(router.parseRouterProviderPreference(JSON.stringify({ schemaVersion: 1, provider: "unknown" })), "cursor");

  let stored = null;
  const persistence = {
    async read(key) {
      assert.equal(key, router.ROUTER_PROVIDER_PERSISTENCE_KEY);
      return stored;
    },
    async write(key, value) {
      assert.equal(key, router.ROUTER_PROVIDER_PERSISTENCE_KEY);
      stored = value;
    }
  };
  for (const provider of router.ROUTER_PROVIDERS) {
    await router.saveRouterProvider(persistence, provider.id);
    assert.equal(await router.loadRouterProvider(persistence), provider.id);
  }
});

test("settings registry exposes Router with the native settings icon contract", async () => {
  const source = await readFile(path.join(repoRoot, "frontend/src/recovered/features/settings/overlay/view.tsx"), "utf8");
  assert.match(source, /\{ id: "router", label: "Router", icon: "git-branch" \}/);
});

test("9Router settings expose only status/save/delete credential operations and keep MCP advanced opt-in explicit", async () => {
  const preload = await readFile(path.join(repoRoot, "source/electron-preload/preload.ts"), "utf8");
  const panel = await readFile(path.join(repoRoot, "frontend/src/recovered/features/settings/overlay/panels.tsx"), "utf8");
  const coordinator = await readFile(path.join(repoRoot, "source/node-agent-coordinator/inference-router.ts"), "utf8");
  assert.match(preload, /cliProxy:\s*\{[\s\S]*status:[\s\S]*save:[\s\S]*remove:/);
  assert.doesNotMatch(preload, /cliProxy:\s*\{[\s\S]{0,500}reveal:/);
  assert.match(panel, /Test &amp; load models/);
  assert.match(panel, /Manual entry stays available/);
  assert.match(coordinator, /SAND_9ROUTER_ENABLE_UNREVIEWED_MCP_TOOLS === "1"/);
  assert.match(coordinator, /bridge == null && cliProxyToolsEnabled/);
});

test("polished renderer 9Router component injection remains valid JavaScript", async () => {
  const patcher = await import(`../scripts/lib/router-renderer-patch.mjs?${Date.now()}`);
  const synthetic = 'function Sa(s){Q=x==="general"?a.jsx(Te,{children:a.jsx(Sa,{auth:t})}):null;Z=x==="usage"?a.jsx(Te,{children:a.jsx(Na,{})}):null}';
  const patched = patcher.patchOriginalSettingsPanel(synthetic);
  const component = patched.slice(0, patched.indexOf("function Sa(s){"));
  await transform(component, { format: "esm", loader: "js", target: "es2023" });
  assert.match(component, /window\.desktop\.cliProxy\.status\(\{testConnection:!0\}\)/);
  assert.doesNotMatch(component, /cliProxy\.reveal/);
});
