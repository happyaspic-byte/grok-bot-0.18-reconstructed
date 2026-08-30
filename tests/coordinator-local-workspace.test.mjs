import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(import.meta.dirname, "..");

async function loadModule(relative, { format = "esm" } = {}) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-local-workspace-module-"));
  const output = path.join(temporary, format === "cjs" ? "module.cjs" : "module.mjs");
  await build({
    entryPoints: [path.join(repoRoot, relative)],
    outfile: output,
    bundle: true,
    format,
    platform: "node",
    target: "node22",
  });
  const imported = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return {
    module: format === "cjs" ? imported.default : imported,
    dispose: () => rm(temporary, { recursive: true, force: true }),
  };
}

function fakeRuntime(record) {
  return {
    requestRendererPort() { record.rendererRequests += 1; },
    revokeRendererPortRequest() { record.rendererRevocations += 1; },
    async restart() { record.restarts += 1; },
    async dispose() { record.disposals += 1; },
  };
}

function createResyncDependencies(overrides = {}) {
  return {
    legs: {
      async getHostSettings() { return {}; },
      async setHostSettings(update) { return update; },
    },
    getMcpCustomInstructionsAccountScope: () => null,
    getMcpCustomInstructionsByServerId: () => ({}),
    getMcpDisabledToolsByServerId: () => ({}),
    setMcpCustomInstructionsByServerId() {},
    setMcpDisabledToolsByServerId() {},
    detectTimeZone: () => "UTC",
    getUserTimeZoneOverride: () => undefined,
    getInferenceProvider: () => "cli-proxy",
    getLocalWorkspaceBrowserUseCapability: () => false,
    getComputerUseModel: () => undefined,
    getAutoReviewInstructions: () => ({}),
    getLocalToolPermission: () => "ask",
    getWebauthnProxyEnabled: () => false,
    getFeatureFlagOverrides: () => ({}),
    async pushBoxSecrets() {},
    async syncWindowFocused() {},
    ...overrides,
  };
}

test("local workspace claims launch without authorizing or fabricating an account", async () => {
  const loaded = await loadModule("source/electron-main/coordinator/coordinator-account-runtime.ts");
  try {
    const record = {
      claims: [], authorizations: [], transitions: [], delivered: [],
      rendererRequests: 0, rendererRevocations: 0, restarts: 0, disposals: 0,
    };
    const runtime = loaded.module.createCoordinatorAccountRuntime({
      createRuntime(claim) { record.claims.push(claim); return fakeRuntime(record); },
      async authorizeAccount(slot) { record.authorizations.push(slot); return true; },
      async revokeRefusedAccount() { assert.fail("local claim must not revoke account credentials"); },
      async prepareAccountTransition(transition) { record.transitions.push(transition); },
      resetAccountState() {},
      revokeMainDataPort() {},
      deliverStatus(status) { record.delivered.push(status); },
      onProblem(problem) { assert.fail(problem); },
    });

    const loggedOut = { kind: "logged-out" };
    await runtime.start(loggedOut, { kind: "local-workspace", slot: "local:9router" });
    assert.deepEqual(record.claims, [{ kind: "local-workspace", slot: "local:9router" }]);
    assert.deepEqual(record.authorizations, []);

    runtime.observe({ kind: "logged-in", authId: "account-1" });
    await runtime.whenIdle();
    assert.deepEqual(record.authorizations, ["account-1"]);
    assert.deepEqual(record.transitions, []);

    runtime.observe(loggedOut, { kind: "local-workspace", slot: "local:9router" });
    await runtime.whenIdle();
    assert.deepEqual(record.authorizations, ["account-1"]);
    assert.deepEqual(record.transitions, [{ previousSlot: "account-1", nextSlot: null }]);
    assert.equal(record.delivered.at(-1).kind, "logged-out");
    await runtime.dispose();
  } finally {
    await loaded.dispose();
  }
});

test("local workspace readiness awaits the authenticated in-container model probe", async () => {
  const source = await readFile(
    path.join(repoRoot, "source/electron-main/coordinator/production-provider.ts"),
    "utf8",
  );
  const connected = source.indexOf('"transport-connected": (payload) => {');
  const resync = source.indexOf("resync.onTransportConnected().then(async (summary) => {", connected);
  const probe = source.indexOf("await probeLocalWorkspaceModels();", resync);
  const epochFence = source.indexOf("if (!transportEpoch.isCurrent(connectedEpoch)) return;", probe);
  const publishReady = source.indexOf("publishLocalWorkspaceStatus(ready);", probe);
  assert.ok(connected >= 0 && resync > connected);
  assert.ok(probe > resync, "the container probe must run after authenticated host resync");
  assert.ok(epochFence > probe, "probe completion must be fenced against a replacement transport");
  assert.ok(publishReady > epochFence, "ready must not publish until the container probe succeeds");

  const helper = source.indexOf("const probeLocalWorkspaceModels = async (): Promise<void> => {");
  const readCredential = source.indexOf("cliProxySecretStore.getTurnConfig()", helper);
  const leaseCall = source.indexOf("await leaseCliProxyCredential({ config });", helper);
  const probeCall = source.indexOf("await probeCliProxyModels({});", helper);
  assert.ok(helper >= 0 && readCredential > helper && leaseCall > readCredential && probeCall > leaseCall);
  assert.equal(source.slice(leaseCall, probeCall).includes("getTurnConfig()"), false);
});

test("local 9Router claim requires signed-out, configured cli-proxy, an exact model, native protocol, and local Docker", async () => {
  const loaded = await loadModule("source/electron-main/coordinator/local-workspace.ts");
  try {
    let statusReads = 0;
    const settings = {
      getBoxRuntime: () => "local-docker",
      getInferenceProvider: () => "cli-proxy",
    };
    const cliProxyStatus = async () => { statusReads += 1; return { configured: true, model: "provider/model", protocol: "chat-completions" }; };
    assert.deepEqual(await loaded.module.resolveLocal9RouterWorkspaceClaim({
      status: { kind: "logged-out" }, settings, cliProxyStatus,
    }), { kind: "local-workspace", slot: "local:9router" });
    assert.equal(statusReads, 1);

    assert.equal(await loaded.module.resolveLocal9RouterWorkspaceClaim({
      status: { kind: "logged-in", authId: "real-account" }, settings, cliProxyStatus,
    }), null);
    assert.equal(statusReads, 1, "signed-in status must not inspect the local secret store");

    assert.equal(await loaded.module.resolveLocal9RouterWorkspaceClaim({
      status: { kind: "logged-out" },
      settings: { ...settings, getBoxRuntime: () => "remote" },
      cliProxyStatus,
    }), null);
    assert.equal(statusReads, 1);
    assert.equal(await loaded.module.resolveLocal9RouterWorkspaceClaim({
      status: { kind: "logged-out" }, settings,
      cliProxyStatus: async () => ({ configured: false, model: "provider/model" }),
    }), null);
    assert.equal(await loaded.module.resolveLocal9RouterWorkspaceClaim({
      status: { kind: "logged-out" }, settings,
      cliProxyStatus: async () => ({ configured: true, model: "  " }),
    }), null);
    assert.equal(await loaded.module.resolveLocal9RouterWorkspaceClaim({
      status: { kind: "logged-out" }, settings,
      cliProxyStatus: async () => ({ configured: true, model: "provider/model", protocol: "responses" }),
    }), null);
    for (const protocol of [undefined, "", "unknown"]) {
      assert.equal(await loaded.module.resolveLocal9RouterWorkspaceClaim({
        status: { kind: "logged-out" }, settings,
        cliProxyStatus: async () => ({ configured: true, model: "provider/model", protocol }),
      }), null, `invalid protocol ${String(protocol)} must fail closed`);
    }
    assert.deepEqual(await loaded.module.resolveLocal9RouterWorkspaceClaim({
      status: { kind: "logged-out" }, settings,
      cliProxyStatus: async () => ({ configured: true, model: "provider/model", protocol: "auto" }),
    }), { kind: "local-workspace", slot: "local:9router" });
  } finally {
    await loaded.dispose();
  }
});

test("production auth wiring leaves runtime observation to the local-claim-aware coordinator", async () => {
  const loaded = await loadModule("source/electron-main/account/cursor-auth-wiring.ts", { format: "cjs" });
  try {
    let subscribed;
    let observed = 0;
    let delivered = 0;
    const loggedOut = { kind: "logged-out" };
    const service = {
      subscribe(listener) { subscribed = listener; return () => { subscribed = undefined; }; },
      async getStatus() { return loggedOut; },
      async getValidAccessToken() { throw new Error("not logged in"); },
      async revokeForAccountRefusal() { return { kind: "completed", status: loggedOut }; },
      async login() { return loggedOut; },
      async cancelLogin() { return loggedOut; },
      async logout() { return loggedOut; },
      async updateDisplayName() { return loggedOut; },
    };
    const wiring = loaded.module.createCursorAuthWiring({
      openExternal() {},
      createAuthService: () => service,
      getAccountRuntime: () => ({ observe() { observed += 1; }, async whenIdle() { return loggedOut; } }),
      runtimeObservationOwner: "coordinator",
      emitAuthStatus() { delivered += 1; },
      sentryEnabled: false,
      settingsStore: {
        getLocalToolPermission: () => "ask",
        setLocalToolPermissionCeiling() {},
      },
      async syncHostSettingsToBox() {},
    });
    await wiring.ensureCursorAuthService();
    subscribed(loggedOut);
    assert.equal(observed, 0, "the claim-unaware auth subscriber must not interrupt a local runtime");
    assert.equal(delivered, 0, "status delivery waits for the coordinator transition");
    wiring.deliverCursorAuthStatus(service, loggedOut);
    assert.equal(delivered, 1);
    wiring.dispose();
  } finally {
    await loaded.dispose();
  }
});

test("standalone local connector never requests remote Cursor credentials", async () => {
  const loaded = await loadModule("source/electron-main/box/local-docker-host-connector.ts");
  try {
    const calls = { connect: 0, inference: 0, localExec: 0, localBox: 0 };
    const remote = {
      async connect() { calls.connect += 1; return { baseUrl: "https://cloud.invalid" }; },
      async issueInferenceCredential() { calls.inference += 1; return { accessToken: "cloud", backendUrl: "https://cloud.invalid", expiresAtMs: Date.now() + 1_000 }; },
      async issueLocalExecDaemonCredential() { calls.localExec += 1; return { credential: "cloud", backendUrl: "https://cloud.invalid" }; },
    };
    const settings = {
      settingsPath: "C:/fixture/settings.json",
      getBoxRuntime: () => "local-docker",
      getInferenceProvider: () => "cli-proxy",
    };
    const connector = loaded.module.createSettingsRoutedHostConnector(remote, settings, {
      async ensureLocalBox(settingsPath, credential, options) {
        calls.localBox += 1;
        assert.equal(settingsPath, settings.settingsPath);
        assert.equal(credential, undefined);
        assert.deepEqual(options, {});
        return { baseUrl: "http://127.0.0.1:1340", token: "local" };
      },
    });
    assert.deepEqual(await connector.connect(), { baseUrl: "http://127.0.0.1:1340", token: "local" });
    assert.equal(await connector.issueInferenceCredential(), undefined);
    assert.equal(await connector.issueLocalExecDaemonCredential(), undefined);
    assert.deepEqual(calls, { connect: 0, inference: 0, localExec: 0, localBox: 1 });
  } finally {
    await loaded.dispose();
  }
});

test("local connector scopes Cursor credentials and local auth mounts to their exact providers", async () => {
  const loaded = await loadModule("source/electron-main/box/local-docker-host-connector.ts");
  try {
    const cases = [
      { provider: "cursor", cursorCredential: true, localAuthProvider: undefined },
      { provider: "codex", cursorCredential: false, localAuthProvider: "codex" },
      { provider: "claude-code", cursorCredential: false, localAuthProvider: "claude-code" },
      { provider: "openrouter", cursorCredential: false, localAuthProvider: undefined },
      { provider: "cli-proxy", cursorCredential: false, localAuthProvider: undefined },
    ];
    for (const expected of cases) {
      let credentialCalls = 0;
      let receivedCredential;
      let receivedOptions;
      const connector = loaded.module.createSettingsRoutedHostConnector({
        async connect() { return { baseUrl: "https://cloud.invalid" }; },
        async issueInferenceCredential() {
          credentialCalls += 1;
          return { accessToken: "cursor", backendUrl: "https://cloud.invalid", expiresAtMs: Date.now() + 1_000 };
        },
      }, {
        settingsPath: "C:/fixture/settings.json",
        getBoxRuntime: () => "local-docker",
        getInferenceProvider: () => expected.provider,
      }, {
        async ensureLocalBox(_settingsPath, credential, options) {
          receivedCredential = credential;
          receivedOptions = options;
          return { baseUrl: "http://127.0.0.1:1340", token: "local" };
        },
      });

      await connector.connect();
      assert.equal(credentialCalls, expected.cursorCredential ? 1 : 0, expected.provider);
      assert.equal(receivedCredential !== undefined, expected.cursorCredential, expected.provider);
      assert.deepEqual(receivedOptions, expected.localAuthProvider == null ? {} : { localAuthProvider: expected.localAuthProvider }, expected.provider);
      const issuedDirectly = await connector.issueInferenceCredential();
      assert.equal(issuedDirectly !== undefined, expected.cursorCredential, expected.provider);
      assert.equal(credentialCalls, expected.cursorCredential ? 2 : 0, expected.provider);
    }
  } finally {
    await loaded.dispose();
  }
});

test("local connector serializes provider generations and never returns a stale provider container", async () => {
  const loaded = await loadModule("source/electron-main/box/local-docker-host-connector.ts");
  try {
    let provider = "codex";
    let releaseFirst;
    let noteFirstStarted;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise((resolve) => { noteFirstStarted = resolve; });
    const calls = [];
    const connector = loaded.module.createSettingsRoutedHostConnector({
      async connect() { return { baseUrl: "https://cloud.invalid" }; },
    }, {
      settingsPath: "C:/provider-race/settings.json",
      getBoxRuntime: () => "local-docker",
      getInferenceProvider: () => provider,
    }, {
      async ensureLocalBox(_settingsPath, credential, options) {
        calls.push({ credential, options });
        if (calls.length === 1) {
          noteFirstStarted();
          await firstGate;
          return { baseUrl: "http://127.0.0.1:1340", token: "stale-codex" };
        }
        return { baseUrl: "http://127.0.0.1:1340", token: "current-cli-proxy" };
      },
    });

    const first = connector.connect();
    await firstStarted;
    provider = "cli-proxy";
    const second = connector.connect();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 1, "the newer provider ensure must wait for the current Docker mutation");
    releaseFirst();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.token, "current-cli-proxy");
    assert.equal(secondResult.token, "current-cli-proxy");
    assert.deepEqual(calls, [
      { credential: undefined, options: { localAuthProvider: "codex" } },
      { credential: undefined, options: {} },
    ]);
  } finally {
    await loaded.dispose();
  }
});

test("remote transition is serialized behind an in-flight local ensure and leaves no stale container", async () => {
  const loaded = await loadModule("source/electron-main/box/local-docker-host-connector.ts");
  try {
    const settingsPath = "C:/runtime-race/settings.json";
    let mode = "local-docker";
    let releaseEnsure;
    let noteEnsureStarted;
    let ensureWasSuperseded;
    const ensureGate = new Promise((resolve) => { releaseEnsure = resolve; });
    const ensureStarted = new Promise((resolve) => { noteEnsureStarted = resolve; });
    const order = [];
    const connector = loaded.module.createSettingsRoutedHostConnector({
      async connect() { return { baseUrl: "https://cloud.invalid" }; },
    }, {
      settingsPath,
      getBoxRuntime: () => mode,
      getInferenceProvider: () => "cli-proxy",
    }, {
      async ensureLocalBox(_settingsPath, _credential, _options, isSuperseded) {
        ensureWasSuperseded = isSuperseded;
        order.push("ensure:start");
        noteEnsureStarted();
        await ensureGate;
        order.push("ensure:created");
        return { baseUrl: "http://127.0.0.1:1340", token: "stale" };
      },
    });

    const connecting = connector.connect();
    await ensureStarted;
    mode = "remote";
    const stopping = loaded.module.serializeLocalDockerLifecycleMutation(
      settingsPath,
      async () => { order.push("stop"); },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(order, ["ensure:start"], "stop must wait for the creating ensure");
    assert.equal(ensureWasSuperseded(), true, "the queued stop must cancel the ensure generation");

    releaseEnsure();
    await assert.rejects(() => connecting, /Local Docker VM is no longer selected/);
    await stopping;
    assert.deepEqual(order, ["ensure:start", "ensure:created", "stop"]);
  } finally {
    await loaded.dispose();
  }
});

test("quit closes Docker mutation intake before its final serialized stop", async () => {
  const loaded = await loadModule("source/electron-main/box/local-docker-host-connector.ts");
  try {
    const settingsPath = path.join(
      os.tmpdir(),
      `grok-quit-lifecycle-${process.pid}-${Date.now()}`,
      "settings.json",
    );
    const held = Promise.withResolvers();
    const started = Promise.withResolvers();
    const order = [];
    const admitted = loaded.module.serializeLocalDockerLifecycleMutation(
      settingsPath,
      async () => {
        order.push("ensure:start");
        started.resolve();
        await held.promise;
        order.push("ensure:end");
      },
    );
    await started.promise;

    const stopped = loaded.module.stopLocalDockerBoxForQuit(
      settingsPath,
      async (args) => {
        order.push(`docker:${args[0]}`);
        if (args[0] === "inspect") {
          return {
            ok: true,
            output: JSON.stringify({
              State: { Running: true },
              Config: {
                Image: loaded.module.LOCAL_DOCKER_BOX_IMAGE,
                Env: [],
                Labels: { "com.grok-bot.local-vm": "1" },
              },
              HostConfig: { NetworkMode: loaded.module.LOCAL_DOCKER_NETWORK },
            }),
          };
        }
        return { ok: true, output: "stopped" };
      },
    );
    await assert.rejects(
      () => loaded.module.serializeLocalDockerLifecycleMutation(
        settingsPath,
        async () => { order.push("late:ensure"); },
      ),
      (error) => error.name === "LocalDockerLifecycleClosedError",
    );

    held.resolve();
    await admitted;
    await stopped;
    assert.deepEqual(order, [
      "ensure:start",
      "ensure:end",
      "docker:inspect",
      "docker:stop",
    ]);
  } finally {
    await loaded.dispose();
  }
});

test("local connector generations distinguish Cursor credential modes", async () => {
  const loaded = await loadModule("source/electron-main/box/local-docker-host-connector.ts");
  try {
    let credentialCalls = 0;
    let releaseFirst;
    let noteFirstStarted;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise((resolve) => { noteFirstStarted = resolve; });
    const calls = [];
    const credential = { accessToken: "cursor", backendUrl: "https://cloud.invalid", expiresAtMs: Date.now() + 60_000 };
    const connector = loaded.module.createSettingsRoutedHostConnector({
      async connect() { return { baseUrl: "https://cloud.invalid" }; },
      async issueInferenceCredential() {
        credentialCalls += 1;
        return credentialCalls === 1 ? undefined : credential;
      },
    }, {
      settingsPath: "C:/credential-race/settings.json",
      getBoxRuntime: () => "local-docker",
      getInferenceProvider: () => "cursor",
    }, {
      optionalCredentialTimeoutMs: 100,
      async ensureLocalBox(_settingsPath, issued) {
        calls.push(issued);
        if (calls.length === 1) {
          noteFirstStarted();
          await firstGate;
          return { baseUrl: "http://127.0.0.1:1340", token: "stale-no-credential" };
        }
        return { baseUrl: "http://127.0.0.1:1340", token: "current-credential" };
      },
    });

    const first = connector.connect();
    await firstStarted;
    const second = connector.connect();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 1);
    releaseFirst();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.token, "current-credential");
    assert.equal(secondResult.token, "current-credential");
    assert.equal(calls.length, 2);
    assert.equal(calls[0], undefined);
    assert.deepEqual(calls[1], credential);
  } finally {
    await loaded.dispose();
  }
});

test("Docker commands hide Windows child windows and fail within their deadline", async () => {
  const loaded = await loadModule("source/electron-main/box/local-docker-host-connector.ts");
  try {
    let observedWindowsHide = false;
    const startedAt = Date.now();
    const result = await loaded.module.runDockerCommand(["info"], undefined, {
      timeoutMs: 25,
      spawn(_command, _args, options) {
        observedWindowsHide = options.windowsHide === true;
        return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options);
      },
    });
    assert.equal(observedWindowsHide, true);
    assert.equal(result.ok, false);
    assert.match(result.output, /timed out after 25 ms/);
    assert.ok(Date.now() - startedAt < 2_000, "a timed-out Docker child must be terminated promptly");
    assert.equal(loaded.module.resolveDockerCommandTimeoutMs(["info"]), 30_000);
    assert.equal(loaded.module.resolveDockerCommandTimeoutMs(["container", "ls"]), 30_000);
    assert.equal(loaded.module.resolveDockerCommandTimeoutMs(["run"]), 10 * 60_000);
    assert.equal(loaded.module.resolveDockerCommandTimeoutMs(["start"]), 120_000);
  } finally {
    await loaded.dispose();
  }
});

test("transport resync selects cli-proxy inside the local host before turns", async () => {
  const loaded = await loadModule("source/electron-main/coordinator/coordinator-resync.ts");
  try {
    const updates = [];
    const chain = loaded.module.createCoordinatorResyncChain({
      legs: {
        async getHostSettings() { return {}; },
        async setHostSettings(update) { updates.push(update); return update; },
      },
      getMcpCustomInstructionsAccountScope: () => null,
      getMcpCustomInstructionsByServerId: () => ({}),
      getMcpDisabledToolsByServerId: () => ({}),
      setMcpCustomInstructionsByServerId() {},
      setMcpDisabledToolsByServerId() {},
      detectTimeZone: () => "UTC",
      getUserTimeZoneOverride: () => undefined,
      getInferenceProvider: () => "cli-proxy",
      getLocalWorkspaceBrowserUseCapability: () => true,
      getComputerUseModel: () => undefined,
      getAutoReviewInstructions: () => ({}),
      getLocalToolPermission: () => "ask",
      getWebauthnProxyEnabled: () => false,
      getFeatureFlagOverrides: () => ({}),
      async pushBoxSecrets() {},
      async syncWindowFocused() {},
    });
    await chain.onTransportConnected();
    assert.ok(updates.some((update) => update.inferenceProvider === "cli-proxy"));
    assert.ok(updates.some((update) => update.localWorkspaceBrowserUse === true));
  } finally {
    await loaded.dispose();
  }
});

test("native turn preparation gates its lease work on every successful resync step", async () => {
  const loaded = await loadModule("source/electron-main/coordinator/coordinator-resync.ts");
  try {
    const order = [];
    const chain = loaded.module.createCoordinatorResyncChain(createResyncDependencies({
      legs: {
        async getHostSettings() { order.push("mcp_merge"); return {}; },
        async setHostSettings(update) {
          const name = update.inferenceProvider !== undefined
            ? "inference_provider"
            : update.featureFlagOverrides !== undefined
              ? "feature_flags"
              : "host_setting";
          order.push(name);
          return update;
        },
      },
      async pushBoxSecrets() { order.push("box_secrets"); },
      async syncWindowFocused() { order.push("window_focus"); },
    }));

    const result = await chain.withSuccessfulResync(async () => {
      order.push("lease");
      return { leased: true };
    });

    assert.deepEqual(result, { leased: true });
    assert.ok(order.includes("inference_provider"));
    assert.ok(order.includes("feature_flags"));
    assert.ok(order.indexOf("box_secrets") < order.indexOf("lease"));
    assert.ok(order.indexOf("window_focus") < order.indexOf("lease"));
  } finally {
    await loaded.dispose();
  }
});

test("native turn preparation fails closed when any full-resync step fails", async () => {
  const loaded = await loadModule("source/electron-main/coordinator/coordinator-resync.ts");
  try {
    let leased = false;
    const chain = loaded.module.createCoordinatorResyncChain(createResyncDependencies({
      async pushBoxSecrets() { throw new Error("secret sync unavailable"); },
    }));

    await assert.rejects(
      () => chain.withSuccessfulResync(async () => { leased = true; }),
      (error) => {
        assert.equal(error.name, "CoordinatorResyncFailedError");
        assert.deepEqual(error.failedSteps, ["box_secrets"]);
        return true;
      },
    );
    assert.equal(leased, false);
  } finally {
    await loaded.dispose();
  }
});

test("coordinator readiness ignores prior launches and rejects resync failure and timeout", async () => {
  const loaded = await loadModule("source/electron-main/coordinator/production-provider.ts");
  try {
    const ready = { kind: "ready", workspaceId: "local:9router" };
    const gate = loaded.module.createCoordinatorReadinessGate(1_000);
    const current = gate.begin(2);
    let settled = false;
    void current.promise.finally(() => { settled = true; });
    gate.resolve(current.generation, 1, ready);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "a previous ready launch cannot satisfy a new restart");
    gate.resolve(current.generation, 2, ready);
    assert.deepEqual(await current.promise, ready);

    const failed = gate.begin(3);
    const resyncError = new Error("Coordinator resync failed at: box_secrets");
    gate.reject(failed.generation, 3, resyncError);
    await assert.rejects(() => failed.promise, (error) => error === resyncError);

    const timeoutGate = loaded.module.createCoordinatorReadinessGate(10);
    const timedOut = timeoutGate.begin(4);
    await assert.rejects(
      () => timedOut.promise,
      (error) => error.name === "CoordinatorReadyTimeoutError",
    );
  } finally {
    await loaded.dispose();
  }
});

test("restart readiness is rejection-handled before the old coordinator can exit", async () => {
  const source = await readFile(
    path.join(repoRoot, "source/electron-main/coordinator/production-provider.ts"),
    "utf8",
  );
  const begin = source.indexOf("const readiness = coordinatorReadiness.begin(expectedLaunchSequence);");
  const guarded = source.indexOf("void readiness.promise.catch(() => undefined);", begin);
  const restart = source.indexOf("await accountRuntime.restart();", begin);
  assert.ok(begin >= 0 && guarded > begin && guarded < restart);
});

test("transport epochs reject stale resync completions after down or a newer connection", async () => {
  const loaded = await loadModule("source/electron-main/coordinator/production-provider.ts");
  try {
    const fence = loaded.module.createCoordinatorTransportEpochFence();
    const first = fence.begin();
    assert.equal(fence.isCurrent(first), true);
    const held = Promise.withResolvers();
    let published = { kind: "disabled" };
    const staleCompletion = (async () => {
      await held.promise;
      if (fence.isCurrent(first)) published = ready;
    })();
    fence.invalidate();
    held.resolve();
    await staleCompletion;
    assert.deepEqual(published, { kind: "disabled" });
    assert.equal(fence.isCurrent(first), false);
    const second = fence.begin();
    const third = fence.begin();
    assert.equal(fence.isCurrent(second), false);
    assert.equal(fence.isCurrent(third), true);
  } finally {
    await loaded.dispose();
  }
});

test("replacement launch invalidates the previous transport resync before adopting its port", async () => {
  const source = await readFile(
    path.join(repoRoot, "source/electron-main/coordinator/production-provider.ts"),
    "utf8",
  );
  const mainPort = source.indexOf("onMainDataPort: (port) => {");
  const invalidate = source.indexOf("transportEpoch.invalidate();", mainPort);
  const sequence = source.indexOf("coordinatorLaunchSequence += 1;", mainPort);
  assert.ok(mainPort >= 0 && invalidate > mainPort && invalidate < sequence);
});

test("preload coordinator broker carries and fences renderer-port handoff generations", async () => {
  const loaded = await loadModule("source/electron-preload/coordinator-port-bridge.ts");
  try {
    const requests = [];
    const received = [];
    const broker = loaded.module.createCoordinatorPortBroker({
      invokeRequest: (payload) => requests.push(payload),
    });
    const claim = broker.bridge.claim({ onPort: (port) => received.push(port) });
    assert.ok(claim);

    claim.request();
    assert.deepEqual(requests, [{ knownGeneration: 0 }]);

    const first = { closed: 0, close() { this.closed += 1; } };
    broker.deliver(first, { generation: 1 });
    assert.deepEqual(received, [first]);
    claim.request();
    assert.deepEqual(requests, [{ knownGeneration: 0 }, { knownGeneration: 1 }]);

    const duplicate = { closed: 0, close() { this.closed += 1; } };
    broker.deliver(duplicate, { generation: 1 });
    assert.equal(duplicate.closed, 1);
    assert.deepEqual(received, [first]);

    const malformed = { closed: 0, close() { this.closed += 1; } };
    broker.deliver(malformed, { generation: "2" });
    assert.equal(malformed.closed, 1);

    const replacement = { closed: 0, close() { this.closed += 1; } };
    broker.deliver(replacement, { generation: 3 });
    assert.deepEqual(received, [first, replacement]);
    claim.request();
    assert.deepEqual(requests.at(-1), { knownGeneration: 3 });

    claim.release();
    const unowned = { closed: 0, close() { this.closed += 1; } };
    broker.deliver(unowned, { generation: 4 });
    assert.equal(unowned.closed, 1);
  } finally {
    await loaded.dispose();
  }
});

test("renderer-port IPC suppresses stale close requests after a proactive replacement", async () => {
  const loaded = await loadModule("source/electron-main/coordinator/production-provider.ts");
  try {
    let handler;
    let removedChannel;
    let requestCount = 0;
    let activeSink;
    const queuedPorts = [];
    const posts = [];
    const failures = [];
    const frame = {};
    const contents = {
      mainFrame: frame,
      isDestroyed: () => false,
      postMessage(channel, payload, transfer) {
        posts.push({ channel, payload, transfer });
      },
    };
    const registrar = loaded.module.createCoordinatorRendererPortIpcRegistrar({
      ipcMain: {
        handle(channel, listener) {
          assert.equal(channel, "sand:coordinator-port-request");
          handler = listener;
        },
        removeHandler(channel) { removedChannel = channel; },
      },
      getTrustedContents: () => contents,
      requestRendererPort(sink) {
        requestCount += 1;
        activeSink = sink;
        const port = queuedPorts.shift();
        if (port != null) sink(port);
      },
      reportHandoff() {},
      reportFailure(area, leg, error) { failures.push({ area, leg, error }); },
    });
    const registration = registrar.register({});
    assert.equal(typeof handler, "function");

    const first = { id: "first", closed: 0, close() { this.closed += 1; } };
    queuedPorts.push(first);
    handler({ sender: contents, senderFrame: frame }, { knownGeneration: 0 });
    assert.equal(requestCount, 1);
    assert.deepEqual(posts[0], {
      channel: "sand:coordinator-port",
      payload: { generation: 1 },
      transfer: [first],
    });

    const replacement = { id: "replacement", closed: 0, close() { this.closed += 1; } };
    activeSink(replacement);
    assert.deepEqual(posts[1], {
      channel: "sand:coordinator-port",
      payload: { generation: 2 },
      transfer: [replacement],
    });

    handler({ sender: contents, senderFrame: frame }, { knownGeneration: 1 });
    assert.equal(requestCount, 1, "the old port close request must not reach the runtime");
    assert.equal(posts.length, 2);

    const third = { id: "third", closed: 0, close() { this.closed += 1; } };
    queuedPorts.push(third);
    handler({ sender: contents, senderFrame: frame }, { knownGeneration: 2 });
    assert.equal(requestCount, 2);
    assert.deepEqual(posts[2].payload, { generation: 3 });
    assert.throws(
      () => handler({ sender: contents, senderFrame: frame }, { knownGeneration: 4 }),
      /ahead of the main-process handoff generation/
    );
    assert.throws(
      () => handler({ sender: contents, senderFrame: frame }, null),
      /exactly one non-negative safe knownGeneration/
    );

    const previousFrameSink = activeSink;
    const nextFrame = {};
    contents.mainFrame = nextFrame;
    const orphan = { id: "orphan", closed: 0, close() { this.closed += 1; } };
    previousFrameSink(orphan);
    assert.equal(orphan.closed, 1, "a sink captured by a navigated frame must fail closed");

    const nextFramePort = { id: "next-frame", closed: 0, close() { this.closed += 1; } };
    queuedPorts.push(nextFramePort);
    handler({ sender: contents, senderFrame: nextFrame }, { knownGeneration: 0 });
    assert.deepEqual(posts.at(-1).payload, { generation: 1 });
    assert.deepEqual(failures, []);

    registration.dispose();
    assert.equal(removedChannel, "sand:coordinator-port-request");
  } finally {
    await loaded.dispose();
  }
});

test("replacement coordinator launch ignores late events and problems from the old child", async () => {
  const loaded = await loadModule("source/electron-main/coordinator/coordinator-runtime.ts");
  try {
    const launches = [];
    const observed = [];
    const problems = [];
    let failNextLaunch = false;
    const runtime = loaded.module.createCoordinatorRuntime({
      fork() { assert.fail("custom launch should be used"); },
      createChannel() { assert.fail("custom launch should be used"); },
      executors: {},
      onEvent: {
        "agents-event": (payload) => observed.push(["agents", payload]),
        "transport-connected": (payload) => observed.push(["connected", payload]),
        "transport-down": (payload) => observed.push(["down", payload]),
      },
      onProblem: (problem) => problems.push(problem),
      processConfig: {},
      artifactPath: "/coordinator.cjs",
      monotonicNow: () => 1_000,
      onMainDataPort() {},
      onLifecycle() {},
      relaunchBackoff: {
        schedule() { assert.fail("replacement overlap must not schedule a relaunch"); },
      },
      launch(dependencies) {
        if (failNextLaunch) {
          failNextLaunch = false;
          throw new Error("replacement launch failed");
        }
        const exited = Promise.withResolvers();
        const rendererDataPort = { launch: launches.length + 1 };
        const record = { dependencies, exited, rendererDataPort, disposeCalls: 0 };
        launches.push(record);
        return {
          rendererDataPort,
          mainDataPort: {},
          controlSettled: Promise.resolve(),
          processExited: exited.promise,
          dispose() { record.disposeCalls += 1; },
        };
      },
    });

    const delivered = [];
    const deliver = (port) => delivered.push(port);
    const first = launches[0];
    runtime.requestRendererPort(deliver);
    assert.deepEqual(delivered, [first.rendererDataPort]);
    first.dependencies.onEvent["transport-connected"]({ generation: 1 });
    assert.deepEqual(observed.map(([kind]) => kind), ["connected"]);

    const restarted = runtime.restart();
    const second = launches[1];
    assert.equal(first.disposeCalls, 1);
    assert.deepEqual(
      delivered,
      [first.rendererDataPort, second.rendererDataPort],
      "restart must proactively post the replacement before retiring the old port"
    );
    assert.equal(launches.length, 2);
    first.dependencies.onEvent["transport-down"]({ generation: 2, reason: "old child exit" });
    first.dependencies.onEvent["agents-event"]({ stale: true });
    first.dependencies.onProblem("old child control port closed");
    second.dependencies.onEvent["transport-connected"]({ generation: 1 });

    assert.deepEqual(observed.map(([kind]) => kind), ["connected", "connected"]);
    assert.deepEqual(problems, []);

    failNextLaunch = true;
    assert.throws(() => runtime.restart(), /replacement launch failed/);
    second.dependencies.onEvent["transport-down"]({ generation: 2, reason: "current down" });
    second.dependencies.onEvent["agents-event"]({ current: true });
    second.dependencies.onProblem("current child problem");
    assert.deepEqual(observed.map(([kind]) => kind), [
      "connected",
      "connected",
      "down",
      "agents",
    ]);
    assert.deepEqual(problems, ["current child problem"]);

    first.exited.resolve({ code: 0 });
    await restarted;
    const disposed = runtime.dispose();
    second.dependencies.onEvent["transport-down"]({ generation: 3, reason: "disposed" });
    second.dependencies.onProblem("disposed child problem");
    assert.deepEqual(observed.map(([kind]) => kind), [
      "connected",
      "connected",
      "down",
      "agents",
    ]);
    assert.deepEqual(problems, ["current child problem"]);
    second.exited.resolve({ code: 0 });
    await disposed;
  } finally {
    await loaded.dispose();
  }
});

test("automatic relaunch proactively hands off its replacement", async () => {
  const loaded = await loadModule("source/electron-main/coordinator/coordinator-runtime.ts");
  try {
    const launches = [];
    const delivered = [];
    const scheduled = [];
    const runtime = loaded.module.createCoordinatorRuntime({
      fork() { assert.fail("custom launch should be used"); },
      createChannel() { assert.fail("custom launch should be used"); },
      executors: {},
      onEvent: {
        "transport-connected"() {},
        "transport-down"() {},
      },
      onProblem() {},
      processConfig: {},
      artifactPath: "/coordinator.cjs",
      monotonicNow: () => 1_000,
      onMainDataPort() {},
      onLifecycle() {},
      relaunchBackoff: {
        schedule() {
          const elapsed = Promise.withResolvers();
          scheduled.push(elapsed);
          return { elapsed: elapsed.promise, dispose() {} };
        },
      },
      launch(dependencies) {
        const exited = Promise.withResolvers();
        const rendererDataPort = { launch: launches.length + 1 };
        const record = { dependencies, exited, rendererDataPort };
        launches.push(record);
        return {
          rendererDataPort,
          mainDataPort: {},
          controlSettled: Promise.resolve(),
          processExited: exited.promise,
          dispose() {},
          forceDispose() {},
        };
      },
    });

    const deliver = (port) => delivered.push(port);
    runtime.requestRendererPort(deliver);
    assert.deepEqual(delivered, [launches[0].rendererDataPort]);

    launches[0].exited.resolve({ code: 1 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(scheduled.length, 1);
    scheduled[0].resolve();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(launches.length, 2);
    assert.deepEqual(
      delivered,
      [launches[0].rendererDataPort, launches[1].rendererDataPort],
      "timer relaunch must proactively post its replacement"
    );

    const disposed = runtime.dispose();
    launches[1].exited.resolve({ code: 0 });
    await disposed;
  } finally {
    await loaded.dispose();
  }
});

test("a hung old coordinator is force-isolated without pinning later restarts", async () => {
  const loaded = await loadModule("source/electron-main/coordinator/coordinator-runtime.ts");
  try {
    const launches = [];
    const problems = [];
    const runtime = loaded.module.createCoordinatorRuntime({
      fork() { assert.fail("custom launch should be used"); },
      createChannel() { assert.fail("custom launch should be used"); },
      executors: {},
      onEvent: {
        "transport-connected"() {},
        "transport-down"() {},
      },
      onProblem: (problem) => problems.push(problem),
      processConfig: {},
      artifactPath: "/coordinator.cjs",
      monotonicNow: () => 1_000,
      onMainDataPort() {},
      onLifecycle() {},
      relaunchBackoff: {
        schedule() { assert.fail("replacement overlap must not schedule a relaunch"); },
      },
      restartExitGraceMs: 5,
      restartForceExitGraceMs: 5,
      launch(dependencies) {
        const exited = Promise.withResolvers();
        const record = { dependencies, exited, disposeCalls: 0, forceDisposeCalls: 0 };
        launches.push(record);
        return {
          rendererDataPort: {},
          mainDataPort: {},
          controlSettled: Promise.resolve(),
          processExited: exited.promise,
          dispose() { record.disposeCalls += 1; },
          forceDispose() { record.forceDisposeCalls += 1; },
        };
      },
    });

    const first = launches[0];
    await runtime.restart();
    assert.equal(first.disposeCalls, 1);
    assert.equal(first.forceDisposeCalls, 1);
    assert.match(problems[0], /forcing termination/);
    assert.match(problems[1], /continuing with the isolated replacement/);

    const second = launches[1];
    const restartedAgain = runtime.restart();
    second.exited.resolve({ code: 0 });
    await restartedAgain;
    assert.equal(second.forceDisposeCalls, 0);

    const third = launches[2];
    const disposed = runtime.dispose();
    third.exited.resolve({ code: 0 });
    await disposed;
  } finally {
    await loaded.dispose();
  }
});

test("quit quiescence fences native preparation before the final lease clear", async () => {
  const loaded = await loadModule("source/electron-main/coordinator/production-provider.ts");
  try {
    const gate = loaded.module.createCliProxyNativePrepareGate();
    let releasePrepare;
    let notePrepareStarted;
    const prepareGate = new Promise((resolve) => { releasePrepare = resolve; });
    const prepareStarted = new Promise((resolve) => { notePrepareStarted = resolve; });
    const order = [];
    const first = gate.run(async () => {
      order.push("prepare:start");
      notePrepareStarted();
      await prepareGate;
      order.push("lease:installed");
    });
    await prepareStarted;

    const quiesced = gate.quiesce().then(() => { order.push("prepare:quiesced"); });
    await assert.rejects(
      () => gate.run(async () => { order.push("lease:late"); }),
      /preparation is quiesced/,
    );
    releasePrepare();
    await first;
    await quiesced;
    order.push("lease:cleared");

    assert.deepEqual(order, [
      "prepare:start",
      "lease:installed",
      "prepare:quiesced",
      "lease:cleared",
    ]);
  } finally {
    await loaded.dispose();
  }
});

test("coordinator runtime disposal starts even while native-turn quiescence is stuck", async () => {
  const loaded = await loadModule("source/electron-main/coordinator/production-provider.ts");
  try {
    const held = Promise.withResolvers();
    let disposalStarted = false;
    const shutdown = loaded.module.quiesceNativeTurnsAndDisposeCoordinatorRuntime(
      () => held.promise,
      async () => { disposalStarted = true; },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(disposalStarted, true);
    held.resolve();
    await shutdown;
  } finally {
    await loaded.dispose();
  }
});

test("production resync uses the throwing box-secrets path", async () => {
  const loaded = await loadModule("source/electron-main/coordinator/production-root-auxiliary-provider.ts", { format: "cjs" });
  try {
    const calls = [];
    const settingsStore = {
      getMcpCustomInstructionsAccountScope: () => null,
      getMcpCustomInstructionsByServerId: () => ({}),
      getMcpDisabledToolsByServerId: () => ({}),
      setMcpCustomInstructionsByServerId() {},
      setMcpDisabledToolsByServerId() {},
      getUserTimeZoneOverride: () => undefined,
      getInferenceProvider: () => "cli-proxy",
      getComputerUseModel: () => undefined,
      getAutoReviewInstructions: () => ({}),
      getLocalToolPermission: () => "ask",
      getWebauthnProxyEnabled: () => false,
    };
    const context = {
      settings: { settingsStore },
      secretsStores: {
        pushBoxSecrets: {
          async push() { calls.push("best-effort"); return false; },
          async pushOrThrow(trigger) {
            calls.push(`strict:${trigger}`);
            throw new Error("box secrets unavailable");
          },
        },
      },
      requireNotifications: () => ({}),
    };
    const ports = loaded.module.createProductionCoordinatorAuxiliaryPorts(context, {});

    await assert.rejects(
      () => ports.resync.pushBoxSecrets(),
      /box secrets unavailable/,
    );
    assert.deepEqual(calls, ["strict:resync"]);
  } finally {
    await loaded.dispose();
  }
});

test("strict host settings pushes propagate errors without poisoning later queue work", async () => {
  const loaded = await loadModule("source/electron-main/coordinator/coordinator-resync.ts");
  try {
    let fail = true;
    const chain = loaded.module.createCoordinatorResyncChain(createResyncDependencies({
      legs: {
        async getHostSettings() { return {}; },
        async setHostSettings(update) {
          if (fail) throw new Error("host transport down");
          return update;
        },
      },
    }));

    assert.equal(await chain.pushHostSettings({ value: "best-effort" }), null);
    await assert.rejects(
      () => chain.pushHostSettingsStrict({ clearCliProxyCredentialLease: true }),
      /host transport down/,
    );
    fail = false;
    assert.deepEqual(
      await chain.pushHostSettingsStrict({ clearCliProxyCredentialLease: true }),
      { clearCliProxyCredentialLease: true },
    );
  } finally {
    await loaded.dispose();
  }
});

test("lease revocation failure stops the owned local Docker host and fails if both controls fail", async () => {
  const loaded = await loadModule("source/electron-main/box/local-docker-host-connector.ts");
  try {
    const calls = [];
    await loaded.module.revokeCliProxyLeaseOrStopOwnedLocalDocker(
      async () => { calls.push("revoke"); throw new Error("host unavailable"); },
      async () => { calls.push("stop"); },
    );
    assert.deepEqual(calls, ["revoke", "stop"]);

    await assert.rejects(
      () => loaded.module.revokeCliProxyLeaseOrStopOwnedLocalDocker(
        async () => { throw new Error("host unavailable"); },
        async () => { throw new Error("docker unavailable"); },
      ),
      (error) => {
        assert.equal(error.name, "AggregateError");
        assert.equal(error.errors.length, 2);
        return true;
      },
    );
  } finally {
    await loaded.dispose();
  }
});

test("lease revoke fallback fails closed on generic Docker inspect and absence-list failures", async (t) => {
  const loaded = await loadModule("source/electron-main/box/local-docker-host-connector.ts");
  try {
    await t.test("generic inspect failure", async () => {
      const commands = [];
      await assert.rejects(
        () => loaded.module.revokeCliProxyLeaseOrStopOwnedLocalDocker(
          async () => { throw new Error("host unavailable"); },
          async () => loaded.module.stopLocalDockerBoxNow(async (args) => {
            commands.push([...args]);
            return args[0] === "inspect"
              ? { ok: false, output: "permission denied while inspecting Docker state" }
              : { ok: true, output: loaded.module.LOCAL_DOCKER_BOX_CONTAINER };
          }),
        ),
        (error) => {
          assert.equal(error.name, "AggregateError");
          assert.equal(error.errors.length, 2);
          assert.match(error.errors[0].message, /host unavailable/);
          assert.match(error.errors[1].message, /could not inspect the existing local container/);
          return true;
        },
      );
      assert.deepEqual(commands.map(args => args.slice(0, 2)), [["inspect", "--format"], ["container", "ls"]]);
    });

    await t.test("absence confirmation list failure", async () => {
      const commands = [];
      await assert.rejects(
        () => loaded.module.revokeCliProxyLeaseOrStopOwnedLocalDocker(
          async () => { throw new Error("host unavailable"); },
          async () => loaded.module.stopLocalDockerBoxNow(async (args) => {
            commands.push([...args]);
            return args[0] === "inspect"
              ? { ok: false, output: `Error: No such object: ${loaded.module.LOCAL_DOCKER_BOX_CONTAINER}` }
              : { ok: false, output: "Docker daemon disconnected during list" };
          }),
        ),
        (error) => {
          assert.equal(error.name, "AggregateError");
          assert.equal(error.errors.length, 2);
          assert.match(error.errors[1].message, /absence could not be confirmed/);
          return true;
        },
      );
      assert.deepEqual(commands.map(args => args.slice(0, 2)), [["inspect", "--format"], ["container", "ls"]]);
    });
  } finally {
    await loaded.dispose();
  }
});

test("lease revoke fallback treats only a confirmed missing container as a no-op", async () => {
  const loaded = await loadModule("source/electron-main/box/local-docker-host-connector.ts");
  try {
    const commands = [];
    await loaded.module.revokeCliProxyLeaseOrStopOwnedLocalDocker(
      async () => { throw new Error("host unavailable"); },
      async () => loaded.module.stopLocalDockerBoxNow(async (args) => {
        commands.push([...args]);
        if (args[0] === "inspect") {
          return { ok: false, output: "[]\n오류: 요청한 Docker 개체를 찾을 수 없습니다" };
        }
        if (args[0] === "container" && args[1] === "ls") return { ok: true, output: "" };
        assert.fail(`confirmed-absent stop must not invoke ${args.join(" ")}`);
      }),
    );
    assert.deepEqual(commands, [
      ["inspect", "--format", "{{json .}}", loaded.module.LOCAL_DOCKER_BOX_CONTAINER],
      [
        "container", "ls", "--all",
        "--filter", `name=^/${loaded.module.LOCAL_DOCKER_BOX_CONTAINER}$`,
        "--format", "{{.Names}}",
      ],
    ]);
  } finally {
    await loaded.dispose();
  }
});

test("local Docker isolates its network and model shell before carrying a 9Router lease", async () => {
  const source = await readFile(path.join(repoRoot, "source/electron-main/box/local-docker-host-connector.ts"), "utf8");
  assert.match(source, /cursorenvironments\/universal@sha256:3f9e25e1e382b7c4b71e08eb549098a6106fadc615feba848e6cc5c1ef4be3b6/);
  assert.doesNotMatch(source, /cursorenvironments\/universal:sand-box-latest/);
  assert.match(source, /LOCAL_DOCKER_SCHEMA_VERSION = "11"/);
  assert.match(source, /LOCAL_DOCKER_NETWORK = "grok-bot-local-vm-net"/);
  assert.match(source, /com\.docker\.network\.bridge\.enable_icc=false/);
  assert.match(source, /foreignContainers\.length === 0/);
  assert.match(source, /"--network", LOCAL_DOCKER_NETWORK/);
  assert.match(source, /"--security-opt", "no-new-privileges:true"/);
  assert.match(source, /"--cap-drop", "NET_RAW"/);
  assert.match(source, /isolateModelShell \? \["--env", "SAND_BOX_EXEC_SHELL_USER=box"\] : \[\]/);
  assert.match(source, /dst=\$\{LOCAL_DOCKER_EXEC_DAEMON_WRAPPER_PATH\},readonly/);
  assert.match(source, /--bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs/);
  assert.match(source, /--computer-use-enabled --computer-use-lazy-init/);
  assert.match(source, /modelShellIsolationReady\(\)/);
  assert.match(source, /test \"\$executable\" = \"\/exec-daemon\/node\"/);
  assert.match(source, /\/exec-daemon\/index\.js serve --port 1337/);
  assert.match(source, /test \"\$cap_eff\" = \"0000000000000000\"/);
  assert.match(source, /test \"\$no_new_privs\" = \"1\"/);
  assert.match(source, /SAND_GATEWAY_TOKEN_FILE=\$\{LOCAL_DOCKER_GATEWAY_TOKEN_PATH\}/);
  assert.match(source, /\/\^\[A-Za-z0-9_-\]\{32,256\}\$\//);
  assert.doesNotMatch(source, /SAND_GATEWAY_TOKEN=\$\{token\}/);
  assert.match(source, /"--network", "none"/);
  assert.match(source, /provisionGatewayToken\(token\)/);
  assert.match(source, /type=volume,src=\$\{LOCAL_DOCKER_CONTROL_VOLUME\}/);
  assert.doesNotMatch(source, /headers: \{ authorization: `Bearer \$\{token\}` \}/);
  assert.doesNotMatch(source, /"127\.0\.0\.1:1337:1337"/);
  assert.doesNotMatch(source, /"127\.0\.0\.1:1339:1339"/);
  assert.doesNotMatch(source, /"127\.0\.0\.1:8790:8790"/);
  assert.match(source, /"127\.0\.0\.1:1340:1340"/);
  assert.match(source, /"127\.0\.0\.1:6080:6080"/);
  assert.match(source, /"127\.0\.0\.1:6081:6081"/);
  assert.match(source, /com\.grok-bot\.local-vm\.local-auth-provider=\$\{localAuthProviderLabel\}/);
  assert.match(source, /localDockerStartOptionsForProvider\(inferenceProvider\)/);
  assert.match(source, /inspected\.image === LOCAL_DOCKER_BOX_IMAGE/);
  assert.match(source, /inspected\.schemaVersion === LOCAL_DOCKER_SCHEMA_VERSION/);
  assert.match(source, /inspected\.networkMode === LOCAL_DOCKER_NETWORK/);
  assert.match(source, /inspected\.hostSha256 === bundle\.sha256/);
  assert.match(source, /inspected\.boxExecDaemonSha256 === bundle\.boxExecDaemonSha256/);
  assert.match(source, /inspected\.execDaemonWrapperSha256 === bundle\.execDaemonWrapperSha256/);
  assert.match(source, /inspected\.gatewayTokenSha256 === expectedTokenSha256/);
  assert.match(source, /inspected\.hasInferenceCredential === expectedInferenceCredential/);
  assert.match(source, /inspected\.localAuthProvider === \(localAuthProvider \?\? "none"\)/);
  assert.match(source, /inspected\.hasIsolatedModelShell === expectedIsolatedModelShell/);
  assert.match(source, /provider === "codex" \|\| provider === "claude-code" \? provider : undefined/);
  assert.match(source, /provider === "codex"[\s\S]*\["\.codex", "\/root\/\.codex"\][\s\S]*\["\.claude", "\/root\/\.claude"\]/);
  assert.match(source, /inspected\.localAuthProvider !== localAuthProviderLabel/);
  assert.match(source, /hardenWindowsPrivatePath\(temporary\)[\s\S]*rename\(temporary, target\)[\s\S]*hardenWindowsPrivatePath\(target\)/);
  assert.match(source, /if \(inferenceCredential == null\) \{\s*await rm\(inferenceCredentialPath\(settingsPath\), \{ force: true \}\);/);
  assert.doesNotMatch(source, /mountLocalAuth/);
  assert.match(source, /inspected\.boxExecDaemonSha256 !== hostBundle\.boxExecDaemonSha256/);
});

test("native Computer daemon wrapper is valid bash and non-root terminal paths follow the box identity", async () => {
  const loaded = await loadModule("source/electron-main/box/local-docker-host-connector.ts");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-local-docker-wrapper-"));
  try {
    const wrapper = path.join(temporary, "start-exec-daemon");
    await writeFile(wrapper, loaded.module.LOCAL_DOCKER_EXEC_DAEMON_WRAPPER, "utf8");
    const syntax = spawnSync("bash", ["-n", wrapper], { encoding: "utf8" });
    assert.equal(syntax.status, 0, syntax.stderr);

    const loopback = await loadModule("source/host/box/loopback-sand-box.ts");
    try {
      assert.equal(loopback.module.resolveBoxTerminalsFolder({ SAND_BOX_EXEC_SHELL_USER: "box" }), "/home/box/.cursor/projects/workspace/terminals");
      assert.equal(loopback.module.resolveBoxTerminalsFolder({}), "/root/.cursor/projects/workspace/terminals");
    } finally {
      await loopback.dispose();
    }
  } finally {
    await loaded.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});
