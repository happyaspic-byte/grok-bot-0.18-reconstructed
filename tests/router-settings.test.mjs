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

test("9Router API-key drafts are cleared when delayed status replaces their origin", async () => {
  const router = await loadRouterModule();
  const origin = router.cliProxyDraftOrigin(" http://100.112.10.8:20128/v1 ");
  assert.equal(origin, "http://100.112.10.8:20128");
  assert.equal(
    router.shouldClearCliProxyApiKeyDraft("secret", origin, "http://100.112.10.8:20128/v1/"),
    false,
  );
  assert.equal(
    router.shouldClearCliProxyApiKeyDraft("secret", origin, "http://100.113.10.8:20128/v1"),
    true,
  );
  assert.equal(
    router.shouldClearCliProxyApiKeyDraft("secret", origin, "not a complete URL"),
    true,
  );
  assert.equal(
    router.shouldClearCliProxyApiKeyDraft("", origin, "http://100.113.10.8:20128/v1"),
    false,
  );
  const delayedStatusBaseUrl = "http://100.113.10.8:20128/v1";
  let apiKeyDraft = "secret";
  if (router.shouldClearCliProxyApiKeyDraft(apiKeyDraft, origin, delayedStatusBaseUrl)) {
    apiKeyDraft = "";
  }
  assert.equal(apiKeyDraft, "", "a late status response cannot carry a key across origins");
});

test("9Router persistence acknowledgements clear only the submitted draft revision and origin", async () => {
  const router = await loadRouterModule();
  const origin = "http://100.112.10.8:20128";
  let current = { revision: 1, origin };
  let draft = "submitted-key";
  let clearCount = 0;
  const acknowledge = router.createCliProxyApiKeyPersistenceGuard(
    { ...current },
    () => current,
    () => { clearCount += 1; draft = ""; },
  );

  // A replacement typed while persistence is settling owns a new revision.
  current = { revision: 2, origin };
  draft = "newer-key";
  await new Promise((resolve) => setImmediate(() => { acknowledge(); resolve(); }));
  assert.equal(draft, "newer-key");
  assert.equal(clearCount, 0);

  // Origin identity is independently guarded even if a buggy caller failed to
  // advance its revision.
  const originGuard = router.createCliProxyApiKeyPersistenceGuard(
    { revision: 3, origin },
    () => ({ revision: 3, origin: "https://router.example" }),
    () => { clearCount += 1; },
  );
  originGuard();
  assert.equal(clearCount, 0);

  current = { revision: 4, origin };
  const exactGuard = router.createCliProxyApiKeyPersistenceGuard(
    { ...current },
    () => current,
    () => { clearCount += 1; draft = ""; },
  );
  exactGuard();
  exactGuard();
  assert.equal(clearCount, 1, "an exact acknowledgement is idempotent");
  assert.equal(draft, "");
});

test("settings registry exposes Router with the native settings icon contract", async () => {
  const source = await readFile(path.join(repoRoot, "frontend/src/recovered/features/settings/overlay/view.tsx"), "utf8");
  assert.match(source, /\{ id: "router", label: "Router", icon: "git-branch" \}/);
});

test("9Router settings expose secure Tailscale setup without weakening the default HTTP policy", async () => {
  const preload = await readFile(path.join(repoRoot, "source/electron-preload/preload.ts"), "utf8");
  const desktopBridge = await readFile(path.join(repoRoot, "frontend/src/recovered/contracts/desktop-bridge.ts"), "utf8");
  const panel = await readFile(path.join(repoRoot, "frontend/src/recovered/features/settings/overlay/panels.tsx"), "utf8");
  const formPrimitives = await readFile(path.join(repoRoot, "frontend/src/recovered/ui/sand-form-primitives.tsx"), "utf8");
  const desktopSurface = await readFile(path.join(repoRoot, "frontend/src/recovered/features/settings/overlay/desktop-surface.tsx"), "utf8");
  const coordinator = await readFile(path.join(repoRoot, "source/node-agent-coordinator/inference-router.ts"), "utf8");
  assert.match(preload, /cliProxy:\s*\{[\s\S]*status:[\s\S]*save:[\s\S]*remove:/);
  assert.doesNotMatch(preload, /cliProxy:\s*\{[\s\S]{0,500}reveal:/);
  assert.match(panel, /Test &amp; load models/);
  assert.match(panel, /Manual entry stays available/);
  assert.match(panel, /save the key first, run Test &amp; load models/);
  assert.match(panel, /v0\.5\.35 when reviewed/);
  assert.doesNotMatch(panel, /9Router 0\.5\.2 or newer/);
  assert.match(panel, /const \[allowTailscaleHttp, setAllowTailscaleHttp\] = useState\(false\)/);
  assert.match(panel, /Allow HTTP over Tailscale/);
  assert.match(panel, /http:\/\/100\.112\.10\.8:20128\/v1/);
  assert.match(panel, /Required\. Use the 9Router proxy\/client API key/);
  assert.match(panel, /verify the peer separately with tailscale ping/);
  assert.match(panel, /const apiKeyRevisionRef = useRef\(0\)/);
  assert.match(panel, /createCliProxyApiKeyPersistenceGuard\(/);
  assert.match(panel, /cliProxy\.onSave\(config\(\), onCredentialPersisted\)/);
  assert.match(panel, /localWorkspace\.onContinue\(config\(\), onCredentialPersisted\)/);
  assert.match(panel, /shouldClearCliProxyApiKeyDraft\([\s\S]*?apiKeyRef\.current,[\s\S]*?apiKeyOriginRef\.current,[\s\S]*?nextBaseUrl/);
  assert.match(panel, /if \(cliProxy\?\.status == null\) return;[\s\S]*?updateBaseUrl\(cliProxy\.status\.baseUrl\)/);
  assert.match(desktopSurface, /bridge\.cliProxy\.save\(config, onCredentialPersisted\)/);
  assert.match(preload, /CLI_PROXY_PERSISTED_CHANNEL/);
  assert.match(panel, /probe\?\.models\[0\]/);
  assert.match(panel, /first available model was selected as a draft; save is still required/);
  assert.match(panel, /Save & continue without sign-in/);
  assert.match(panel, /Local 9Router readiness/);
  assert.match(panel, /Local workspace claim ready/);
  assert.match(panel, /Coordinator connected/);
  assert.doesNotMatch(panel, /cliProxy\.on(?:Delete|Test)\(\)\.catch\(\(\) => undefined\)/);
  assert.match(panel, /Use local Docker VM/);
  assert.match(panel, /<SandSwitch[\s\S]{0,120}ariaLabel="Use local Docker VM"/);
  assert.match(formPrimitives, /readonly ariaLabel\?: string/);
  assert.match(formPrimitives, /<button aria-checked=\{isChecked\} aria-label=\{ariaLabel\}/);
  assert.match(panel, /Repair Local Docker VM/);
  assert.match(panel, /boxRuntime\.onChange\("local-docker"\)/);
  assert.match(panel, /computer tools locally on this Windows PC/);
  assert.match(panel, /aria-live="polite" role=\{boxRuntime\.error == null \? "status" : "alert"\}/);
  assert.match(desktopSurface, /getBoxRuntime\(\)/);
  assert.match(desktopSurface, /setBoxRuntime\(mode\)/);
  assert.match(desktopSurface, /boxRuntime\?\.mode === mode[\s\S]{0,140}mode !== "local-docker" \|\| boxRuntime\.status\?\.ready === true/);
  assert.match(preload, /forceGatewayReconnect: \(\) => edge\("forceReconnectGateway"\)/);
  assert.match(desktopBridge, /\{ readonly kind: "ready"; readonly workspaceId: "local:9router" \}/);
  assert.match(desktopBridge, /forceGatewayReconnect\(\): Promise<DesktopLocalWorkspaceStatus>/);
  assert.match(desktopSurface, /onActivateLocalWorkspace\(\): Promise<DesktopLocalWorkspaceStatus>/);
  assert.match(desktopSurface, /onInvalidateLocalWorkspace\(\): void/);
  assert.match(desktopSurface, /const claimed = await onActivateLocalWorkspace\(\)/);
  assert.doesNotMatch(desktopSurface, /const claimed = await bridge\.forceGatewayReconnect\(\)/);
  assert.equal(desktopSurface.match(/onInvalidateLocalWorkspace\(\);/g)?.length, 5);
  assert.match(desktopSurface, /await coordinatorClient\.waitForTransportConnected\(20_000\)/);
  assert.match(desktopSurface, /transportState: coordinatorClient\?\.getTransportState\(\) \?\? "down"/);
  assert.match(desktopSurface, /isLocalWorkspaceClaimReady\(claimed\)/);
  assert.match(desktopSurface, /window\.dispatchEvent\(new Event\(LOCAL_WORKSPACE_CHANGED_EVENT\)\)/);
  assert.equal(desktopSurface.match(/await refreshLocalWorkspace\(/g)?.length, 10);
  assert.match(desktopSurface, /await refreshLocalWorkspace\(false\)/);
  assert.match(desktopSurface, /onLocalWorkspaceReady\?\.\(connectedReadiness\)/);
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
  assert.match(component, /window\.desktop\.cliProxy\.save\([\s\S]*?,A\)/);
  assert.match(component, /V\.current!==v\|\|z\.current!==y/);
  assert.match(component, /V\.current\+=1/);
  assert.match(component, /q\.current\.trim\(\)[\s\S]*?RRouterOrigin\(v\.baseUrl\)!==z\.current/);
  assert.match(component, /allowTailscaleHttp:x/);
  assert.match(component, /Allow HTTP over Tailscale \(numeric IPs only; verify with tailscale ping\)/);
  assert.match(component, /http:\/\/100\.112\.10\.8:20128\/v1/);
  assert.match(component, /Required\. Use the 9Router proxy\/client API key/);
  assert.match(component, /save the key first, run Test & load models/);
  assert.match(component, /v0\.5\.35 when reviewed/);
  assert.doesNotMatch(component, /9Router 0\.5\.2/);
  assert.match(component, /window\.desktop\.forceGatewayReconnect\(\)/);
  assert.match(component, /new Event\("sand-local-workspace-changed"\)/);
  assert.equal(component.match(/await RRouterRefreshLocalWorkspace\(\)/g)?.length, 4);
  const boxRuntime = component.slice(component.indexOf("function RBoxRuntime"), component.indexOf("function RRouterPanel"));
  assert.match(boxRuntime, /Use local Docker VM/);
  assert.doesNotMatch(boxRuntime, /\b(?:Mac|Windows)\b/);
  assert.doesNotMatch(component, /cliProxy\.reveal/);
});
