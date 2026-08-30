import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "grok-local-workspace-"));
  const output = path.join(directory, "local-workspace.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "frontend/src/production/local-workspace.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22"
  });
  return { directory, module: await import(`${pathToFileURL(output).href}?t=${Date.now()}`) };
}

function bridge({ provider = "cli-proxy", mode = "local-docker", dockerReady = true, configured = true, model = "provider/model", protocol = "chat-completions" } = {}) {
  return {
    agent: {
      getInferenceRouter: async () => ({ provider }),
      getBoxRuntime: async () => ({ mode, status: { ready: dockerReady } })
    },
    cliProxy: { status: async () => ({ configured, model, protocol }) }
  };
}

const READY_ACTIVATION = {
  transportState: "connected",
  claimStatus: { kind: "ready", workspaceId: "local:9router" }
};

test("local workspace readiness reports stable blockers for every required condition", async () => {
  const loaded = await loadModule();
  try {
    const ready = await loaded.module.readLocalWorkspaceReadiness(bridge(), READY_ACTIVATION);
    assert.equal(ready.kind, "ready");
    assert.equal(ready.workspaceId, "local:9router");
    assert.deepEqual(ready.checks.map(check => [check.id, check.ready]), [
      ["provider", true],
      ["runtime", true],
      ["docker-ready", true],
      ["credential", true],
      ["model", true],
      ["protocol", true],
      ["workspace-claim", true],
      ["coordinator-connected", true]
    ]);
    const cases = [
      [{ provider: "cursor" }, "provider-not-9router", "Select OpenAI-compatible / 9Router as the provider."],
      [{ mode: "remote" }, "local-docker-not-selected", "Turn on Use local Docker VM."],
      [{ dockerReady: false }, "local-docker-not-ready", "Local Docker is not ready. Start Docker Desktop, then choose Repair Local Docker VM."],
      [{ configured: false }, "credential-missing", "Enter and save the 9Router proxy/client API key."],
      [{ model: "  " }, "model-missing", "Choose a model and save 9Router again."],
      [{ protocol: "responses" }, "protocol-unsupported", "Choose Chat Completions or Auto for native agent tools."],
      [{ protocol: "unknown" }, "protocol-unsupported", "Choose Chat Completions or Auto for native agent tools."]
    ];
    for (const [input, code, message] of cases) {
      const status = await loaded.module.readLocalWorkspaceReadiness(bridge(input), READY_ACTIVATION);
      assert.equal(status.kind, "disabled");
      assert.equal(status.blockers[0].code, code);
      assert.equal(status.blockers[0].message, message);
      assert.equal(loaded.module.localWorkspaceNextAction(status), message);
    }
  } finally {
    await rm(loaded.directory, { recursive: true, force: true });
  }
});

test("local workspace readiness requires an authoritative claim and replayed coordinator connection", async () => {
  const loaded = await loadModule();
  try {
    const unverified = await loaded.module.readLocalWorkspaceReadiness(bridge());
    assert.equal(unverified.kind, "disabled");
    assert.equal(unverified.blockers[0].code, "local-workspace-claim-not-ready");
    assert.equal(unverified.blockers[0].message, "Local workspace startup is not confirmed. Choose Save & continue without signing in to retry.");
    assert.equal(loaded.module.localWorkspaceNextAction(unverified), unverified.blockers[0].message);
    assert.equal(unverified.blockers[1].code, "coordinator-not-connected");
    assert.equal(loaded.module.localWorkspaceConfigurationReady(unverified), true);

    const disconnected = await loaded.module.readLocalWorkspaceReadiness(bridge(), {
      ...READY_ACTIVATION,
      transportState: "down"
    });
    assert.equal(disconnected.kind, "disabled");
    assert.deepEqual(disconnected.blockers.map(blocker => blocker.code), ["coordinator-not-connected"]);
    assert.equal(disconnected.blockers[0].message, "The Local 9Router coordinator is not connected. Retry Save & continue without signing in.");

    const rejectedClaim = await loaded.module.readLocalWorkspaceReadiness(bridge(), {
      transportState: "connected",
      claimStatus: { kind: "disabled" }
    });
    assert.equal(rejectedClaim.kind, "disabled");
    assert.deepEqual(rejectedClaim.blockers.map(blocker => blocker.code), ["local-workspace-claim-not-ready"]);

    const wrongWorkspace = await loaded.module.readLocalWorkspaceReadiness(bridge(), {
      transportState: "connected",
      claimStatus: { kind: "ready", workspaceId: "local:wrong" }
    });
    assert.equal(wrongWorkspace.kind, "disabled");
    assert.equal(wrongWorkspace.blockers[0].code, "local-workspace-claim-not-ready");
  } finally {
    await rm(loaded.directory, { recursive: true, force: true });
  }
});

test("local workspace readiness fails closed when an existing settings edge fails", async () => {
  const loaded = await loadModule();
  try {
    const value = bridge();
    value.agent.getBoxRuntime = async () => { throw new Error("Docker unavailable"); };
    const failed = await loaded.module.readLocalWorkspaceReadiness(value, READY_ACTIVATION);
    assert.equal(failed.kind, "disabled");
    assert.equal(failed.blockers[0].code, "docker-status-unavailable");
    assert.equal(failed.blockers[0].detail, "Docker unavailable");
    const unavailable = await loaded.module.readLocalWorkspaceReadiness({ ...value, agent: { getInferenceRouter: value.agent.getInferenceRouter } }, READY_ACTIVATION);
    assert.equal(unavailable.kind, "disabled");
    assert.equal(unavailable.blockers[0].code, "docker-status-unavailable");
    const providerFailure = bridge();
    providerFailure.agent.getInferenceRouter = () => { throw new Error("Provider unavailable"); };
    const providerStatus = await loaded.module.readLocalWorkspaceReadiness(providerFailure, READY_ACTIVATION);
    assert.equal(providerStatus.kind, "disabled");
    assert.equal(providerStatus.blockers[0].code, "provider-status-unavailable");
    assert.equal(providerStatus.blockers[0].detail, "Provider unavailable");
    const credentialFailure = bridge();
    credentialFailure.cliProxy.status = () => { throw new Error("Credential unavailable"); };
    const credentialStatus = await loaded.module.readLocalWorkspaceReadiness(credentialFailure, READY_ACTIVATION);
    assert.equal(credentialStatus.kind, "disabled");
    assert.equal(credentialStatus.blockers[0].code, "credential-status-unavailable");
    assert.equal(credentialStatus.blockers[0].detail, "Credential unavailable");
  } finally {
    await rm(loaded.directory, { recursive: true, force: true });
  }
});

test("workspace session prefers real login and never impersonates Cursor auth", async () => {
  const loaded = await loadModule();
  try {
    const local = { kind: "ready", workspaceId: "local:9router" };
    assert.deepEqual(loaded.module.projectWorkspaceSession({ kind: "logged-out" }, local), {
      kind: "ready",
      accountSlot: "local:9router",
      identity: "local:9router",
      source: "local-9router"
    });
    assert.deepEqual(loaded.module.projectWorkspaceSession({ kind: "logged-in", authId: "cursor-user" }, local), {
      kind: "ready",
      accountSlot: "cursor-user",
      identity: "cursor:cursor-user",
      source: "cursor"
    });
    assert.deepEqual(loaded.module.projectWorkspaceSession({ kind: "logged-out" }, { kind: "disabled", checks: [], blockers: [] }), {
      kind: "unavailable",
      accountSlot: null,
      identity: null,
      source: null
    });
    assert.deepEqual(loaded.module.projectWorkspaceSession({ kind: "logging-in" }, local), {
      kind: "unavailable",
      accountSlot: null,
      identity: null,
      source: null
    });
  } finally {
    await rm(loaded.directory, { recursive: true, force: true });
  }
});

test("production renderer unlocks local core while keeping account-only surfaces gated", async () => {
  const renderer = await readFile(path.join(repoRoot, "frontend/src/production/ProductionRenderer.tsx"), "utf8");
  assert.match(renderer, /const workspaceReady = workspaceSession\.kind === "ready"/);
  assert.match(renderer, /const transcriptAccountSlot = workspaceAccountSlot/);
  assert.match(renderer, /if \(!isCurrent\(\) \|\| !workspaceReadyRef\.current\) return/);
  assert.match(renderer, /overlay === "plugins"[^\n]+isCursorLoggedIn/);
  assert.match(renderer, /transcriptCardCloudAgents\.setScope\(isCursorLoggedIn/);
  assert.match(renderer, /transcriptCardListenerIntegrations\?\.setScope\(isCursorLoggedIn/);
  assert.match(renderer, /const showSignIn = bridge != null && workspaceSession\.kind === "unavailable"/);
  assert.match(renderer, /localWorkspace=\{localWorkspace\}/);
  assert.match(renderer, /const claimed = await bridge\.forceGatewayReconnect\(\)/);
  assert.match(renderer, /await client\.waitForTransportConnected\(20_000\)/);
  assert.match(renderer, /client\?\.getTransportState\(\) \?\? "down"/);
  assert.match(
    renderer,
    /if \(state === "down"\) localWorkspaceClaimRef\.current = \{ kind: "disabled" \};[\s\S]{0,280}retryActivation\(\);/,
    "down and connected edges must both reopen bounded local activation",
  );
  assert.match(renderer, /onLocalWorkspaceReady=\{\(readiness\) => \{ localWorkspaceClaimRef\.current = \{ kind: "ready", workspaceId: readiness\.workspaceId \}; setLocalWorkspace\(readiness\); setOverlay\(null\); \}\}/);
  assert.doesNotMatch(renderer, /setAccount\(\{\s*kind:\s*"logged-in"/);
});
