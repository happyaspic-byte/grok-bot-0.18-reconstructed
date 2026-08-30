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

test("activation snapshots detect transport and claim changes during asynchronous readiness reads", async () => {
  const loaded = await loadModule();
  try {
    const disabled = { transportState: "down", claimStatus: { kind: "disabled" } };
    const disabledCopy = { transportState: "down", claimStatus: { kind: "disabled" } };
    const connected = { transportState: "connected", claimStatus: { kind: "disabled" } };
    const ready = { transportState: "connected", claimStatus: { kind: "ready", workspaceId: "local:9router" } };
    assert.equal(loaded.module.localWorkspaceActivationStateEqual(disabled, disabledCopy), true);
    assert.equal(loaded.module.localWorkspaceActivationStateEqual(disabled, connected), false);
    assert.equal(loaded.module.localWorkspaceActivationStateEqual(connected, ready), false);
    assert.equal(loaded.module.localWorkspaceActivationStateEqual(ready, { ...ready, claimStatus: { ...ready.claimStatus } }), true);
  } finally {
    await rm(loaded.directory, { recursive: true, force: true });
  }
});

test("settings claim survives rerenders and a transient coordinator replacement", async () => {
  const loaded = await loadModule();
  try {
    const readyClaim = { kind: "ready", workspaceId: "local:9router" };
    const initial = { kind: "checking" };
    const opened = loaded.module.reconcileSettingsLocalWorkspaceClaim(
      { kind: "disabled" },
      initial,
      false,
      true,
    );
    assert.deepEqual(opened, { kind: "disabled" });

    const rerendered = loaded.module.reconcileSettingsLocalWorkspaceClaim(
      readyClaim,
      initial,
      true,
      true,
    );
    assert.equal(rerendered, readyClaim, "an open-surface rerender must retain the activation claim");

    const disconnected = await loaded.module.readLocalWorkspaceReadiness(bridge(), {
      transportState: "down",
      claimStatus: rerendered,
    });
    assert.equal(disconnected.kind, "disabled");
    assert.deepEqual(disconnected.blockers.map((blocker) => blocker.code), ["coordinator-not-connected"]);

    const reconnected = await loaded.module.readLocalWorkspaceReadiness(bridge(), {
      transportState: "connected",
      claimStatus: rerendered,
    });
    assert.equal(reconnected.kind, "ready", "the replacement connected edge must recover without a second claim");

    const closed = loaded.module.reconcileSettingsLocalWorkspaceClaim(readyClaim, initial, true, false);
    assert.equal(closed, readyClaim);
    const reopened = loaded.module.reconcileSettingsLocalWorkspaceClaim(closed, initial, false, true);
    assert.deepEqual(reopened, { kind: "disabled" }, "a real reopen may adopt the latest initial workspace state");
  } finally {
    await rm(loaded.directory, { recursive: true, force: true });
  }
});

test("fresh activation fences an older result and publishes only the latest claim", async () => {
  const loaded = await loadModule();
  try {
    const deferred = () => {
      let resolve;
      let reject;
      const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
      return { promise, reject, resolve };
    };
    const ready = { kind: "ready", workspaceId: "local:9router" };
    const queue = { generation: 0, pending: null, requiresFresh: false };
    const claim = { current: { kind: "disabled" } };
    const first = deferred();
    const second = deferred();
    let activations = 0;
    const initial = loaded.module.activateLocalWorkspaceThroughQueue({
      activate: async () => { activations += 1; return await first.promise; },
      claim,
      queue
    });
    loaded.module.invalidateLocalWorkspaceActivationQueue(queue, claim);
    assert.equal(queue.requiresFresh, true);
    const fresh = loaded.module.activateLocalWorkspaceThroughQueue({
      activate: async () => { activations += 1; return await second.promise; },
      claim,
      queue
    });
    assert.equal(queue.requiresFresh, false);
    assert.deepEqual(claim.current, { kind: "disabled" });
    first.resolve(ready);
    assert.deepEqual(await initial, { kind: "disabled" });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(activations, 2);
    assert.deepEqual(claim.current, { kind: "disabled" }, "superseded success must not publish while the fresh activation is pending");
    second.resolve(ready);
    assert.deepEqual(await fresh, ready);
    assert.deepEqual(claim.current, ready);
    assert.equal(queue.pending, null);

    const failureQueue = { generation: 0, pending: null, requiresFresh: false };
    const failureClaim = { current: { kind: "disabled" } };
    const stale = deferred();
    const staleRun = loaded.module.activateLocalWorkspaceThroughQueue({ activate: async () => await stale.promise, claim: failureClaim, queue: failureQueue });
    const failedFresh = loaded.module.activateLocalWorkspaceThroughQueue({
      activate: async () => { throw new Error("fresh restart failed"); },
      claim: failureClaim,
      forceFresh: true,
      queue: failureQueue
    });
    stale.resolve(ready);
    assert.deepEqual(await staleRun, { kind: "disabled" });
    await assert.rejects(failedFresh, /fresh restart failed/);
    assert.deepEqual(failureClaim.current, { kind: "disabled" });
    assert.equal(failureQueue.pending, null);
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
  const settings = await readFile(path.join(repoRoot, "frontend/src/recovered/features/settings/overlay/desktop-surface.tsx"), "utf8");
  assert.match(renderer, /const workspaceReady = workspaceSession\.kind === "ready"/);
  assert.match(renderer, /const transcriptAccountSlot = workspaceAccountSlot/);
  assert.match(renderer, /if \(!isCurrent\(\) \|\| !workspaceReadyRef\.current\) return/);
  assert.match(renderer, /overlay === "plugins"[^\n]+isCursorLoggedIn/);
  assert.match(renderer, /transcriptCardCloudAgents\.setScope\(isCursorLoggedIn/);
  assert.match(renderer, /transcriptCardListenerIntegrations\?\.setScope\(isCursorLoggedIn/);
  assert.match(renderer, /const showSignIn = bridge != null && workspaceSession\.kind === "unavailable"/);
  assert.match(renderer, /localWorkspace=\{localWorkspace\}/);
  assert.match(renderer, /const activateLocalWorkspace = useCallback\(async \(forceFresh = false\)/);
  assert.match(renderer, /activateLocalWorkspaceThroughQueue\(\{/);
  assert.match(renderer, /forceFresh,[\s\S]{0,120}queue: localWorkspaceActivationQueueRef\.current/);
  const activationStart = renderer.indexOf("const activateLocalWorkspace = useCallback");
  const activationEnd = renderer.indexOf("const activateFreshLocalWorkspace", activationStart);
  assert.ok(activationStart >= 0 && activationEnd > activationStart);
  const activationSource = renderer.slice(activationStart, activationEnd);
  const portGenerationCapture = activationSource.indexOf("const portGeneration = client.getPortGeneration()");
  const forcedReconnect = activationSource.indexOf("const claimed = await bridge.forceGatewayReconnect()");
  const replacementTransportWait = activationSource.indexOf(
    "await client.waitForTransportConnectedAfterPortGeneration(portGeneration, 20_000)"
  );
  assert.ok(
    portGenerationCapture >= 0
      && portGenerationCapture < forcedReconnect
      && forcedReconnect < replacementTransportWait,
    "activation must capture the old port generation before reconnect and await the replacement afterward"
  );
  assert.match(renderer, /client\?\.getTransportState\(\) \?\? "down"/);
  const clientLifecycleStart = renderer.indexOf("const lifecycleGeneration = ++clientLifecycleGenerationRef.current");
  const clientTransportSubscription = renderer.indexOf("const stopTransport = client.subscribeTransport", clientLifecycleStart);
  assert.ok(clientLifecycleStart >= 0 && clientTransportSubscription > clientLifecycleStart);
  assert.doesNotMatch(
    renderer.slice(clientLifecycleStart, clientTransportSubscription),
    /client\.ready/,
    "transport subscription must be the sole renderer transport-state writer"
  );
  assert.match(renderer, /localWorkspaceActivationStateEqual\(observedActivation, activationState\(\)\)/);
  assert.match(renderer, /overlay === "settings" \|\| !localWorkspaceConfigurationReady\(next\)/);
  assert.match(renderer, /invalidateLocalWorkspaceActivationQueue\(localWorkspaceActivationQueueRef\.current, localWorkspaceClaimRef\);[\s\S]{0,100}setLocalWorkspace\(\{ kind: "checking" \}\)/);
  assert.match(
    renderer,
    /if \(state === "connected"\) \{[\s\S]{0,360}refreshAfterCurrentActivation\(overlay !== "settings"\);[\s\S]{0,360}localWorkspaceActivationQueueRef\.current\.pending != null[\s\S]{0,180}retryActivation\(\);/,
    "transport edges must preserve one recovery intent without replacing an in-flight activation",
  );
  assert.match(renderer, /\[account\?\.kind, activateLocalWorkspace, bridge, client, invalidateRootLocalWorkspace, overlay\]/);
  assert.match(renderer, /onActivateLocalWorkspace=\{activateFreshLocalWorkspace\}/);
  assert.match(renderer, /onInvalidateLocalWorkspace=\{invalidateRootLocalWorkspace\}/);
  assert.match(renderer, /onLocalWorkspaceReady=\{\(readiness\) => \{ localWorkspaceClaimRef\.current = \{ kind: "ready", workspaceId: readiness\.workspaceId \}; setLocalWorkspace\(readiness\); setOverlay\(null\); \}\}/);
  assert.doesNotMatch(renderer, /if \(state === "down"\) localWorkspaceClaimRef\.current = \{ kind: "disabled" \}/);
  assert.match(settings, /reconcileSettingsLocalWorkspaceClaim\([\s\S]{0,220}wasOpen,[\s\S]{0,80}isOpen/);
  assert.match(settings, /onNoticeRef\.current\?\.\(event\)/);
  assert.doesNotMatch(settings, /initialLocalWorkspaceClaimRef/);
  assert.doesNotMatch(settings, /if \(state === "down"\) localWorkspaceClaimRef\.current = \{ kind: "disabled" \}/);
  assert.doesNotMatch(renderer, /setAccount\(\{\s*kind:\s*"logged-in"/);
});
