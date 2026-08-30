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
    const arrayPayload = { closed: 0, close() { this.closed += 1; } };
    broker.deliver(arrayPayload, Object.assign([], { generation: 2 }));
    assert.equal(arrayPayload.closed, 1);

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
    let failNextPost = false;
    const frame = {};
    const contents = {
      mainFrame: frame,
      isDestroyed: () => false,
      postMessage(channel, payload, transfer) {
        if (failNextPost) {
          failNextPost = false;
          throw new Error("synthetic post failure");
        }
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
    assert.throws(
      () => handler(
        { sender: contents, senderFrame: frame },
        Object.assign([], { knownGeneration: 3 })
      ),
      /exactly one non-negative safe knownGeneration/
    );
    assert.throws(
      () => handler({ sender: {}, senderFrame: {} }, null),
      /only available from the Sand app window/
    );

    const failedPostPort = { id: "failed-post", closed: 0, close() { this.closed += 1; } };
    queuedPorts.push(failedPostPort);
    failNextPost = true;
    assert.throws(
      () => handler({ sender: contents, senderFrame: frame }, { knownGeneration: 3 }),
      /synthetic post failure/
    );
    assert.equal(failures.length, 1);
    assert.equal(failedPostPort.closed, 1, "a failed transfer must close its orphaned port");
    const retryPort = { id: "retry", closed: 0, close() { this.closed += 1; } };
    queuedPorts.push(retryPort);
    handler({ sender: contents, senderFrame: frame }, { knownGeneration: 3 });
    assert.deepEqual(posts.at(-1).payload, { generation: 4 });

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

    const retainedSink = activeSink;
    registration.dispose();
    assert.equal(removedChannel, "sand:coordinator-port-request");
    const afterDispose = { id: "after-dispose", closed: 0, close() { this.closed += 1; } };
    retainedSink(afterDispose);
    assert.equal(afterDispose.closed, 1, "a retained sink must fail closed after IPC unregisters");
  } finally {
    await loaded.dispose();
  }
});


test("coordinator forced disposal retries kill until process exit is observed", async () => {
  const loaded = await loadModule("source/electron-main/coordinator/coordinator-launcher.ts");
  try {
    let exitListener;
    let killCalls = 0;
    const channels = [];
    const makePort = () => {
      const listeners = {};
      const port = {
        closeCalls: 0,
        postMessage() {},
        on(event, listener) { listeners[event] = listener; },
        start() {},
        close() { this.closeCalls += 1; listeners.close?.(); },
      };
      return port;
    };
    const handle = loaded.module.launchCoordinator({
      fork() {
        return {
          postMessage() {},
          on(event, listener) {
            if (event === "exit") exitListener = listener;
          },
          kill() { killCalls += 1; },
        };
      },
      artifactPath: "/coordinator.cjs",
      createChannel: () => {
        const channel = { port1: makePort(), port2: makePort() };
        channels.push(channel);
        return channel;
      },
      executors: {},
      onEvent: {},
      onProblem() {},
      processConfig: {},
    });

    handle.forceDispose();
    assert.equal(killCalls, 1);
    handle.forceDispose();
    assert.equal(killCalls, 2, "a still-running child must receive a repeated kill request");
    assert.equal(typeof exitListener, "function");
    exitListener(0);
    await handle.processExited;
    handle.forceDispose();
    assert.equal(killCalls, 2, "an observed exit must make forced disposal idempotent");
    assert.ok(channels.every(({ port2 }) => port2.closeCalls >= 1));
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
        const record = {
          dependencies,
          exited,
          rendererDataPort,
          disposeCalls: 0,
          forceDisposeCalls: 0,
        };
        launches.push(record);
        return {
          rendererDataPort,
          mainDataPort: {},
          controlSettled: Promise.resolve(),
          processExited: exited.promise,
          dispose() { record.disposeCalls += 1; },
          forceDispose() { record.forceDisposeCalls += 1; },
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
    assert.equal(second.disposeCalls, 0, "final disposal must bypass the restart grace period");
    assert.equal(second.forceDisposeCalls, 1, "final disposal must force the active child immediately");
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

test("final disposal preempts an in-flight graceful coordinator retirement", async () => {
  const loaded = await loadModule("source/electron-main/coordinator/coordinator-runtime.ts");
  try {
    const launches = [];
    const runtime = loaded.module.createCoordinatorRuntime({
      fork() { assert.fail("custom launch should be used"); },
      createChannel() { assert.fail("custom launch should be used"); },
      executors: {},
      onEvent: {
        "transport-connected"() {},
        "transport-down"() {},
      },
      onProblem(problem) { assert.fail(problem); },
      processConfig: {},
      artifactPath: "/coordinator.cjs",
      monotonicNow: () => 1_000,
      onMainDataPort() {},
      onLifecycle() {},
      relaunchBackoff: {
        schedule() { assert.fail("replacement overlap must not schedule a relaunch"); },
      },
      restartExitGraceMs: 60_000,
      restartForceExitGraceMs: 60_000,
      launch() {
        const exited = Promise.withResolvers();
        const record = { exited, disposeCalls: 0, forceDisposeCalls: 0 };
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

    const restarted = runtime.restart();
    const first = launches[0];
    const second = launches[1];
    assert.equal(first.disposeCalls, 1);
    assert.equal(first.forceDisposeCalls, 0);

    const disposed = runtime.dispose();
    assert.equal(first.forceDisposeCalls, 1, "final disposal must preempt graceful retirement");
    assert.equal(second.disposeCalls, 0);
    assert.equal(second.forceDisposeCalls, 1, "final disposal must immediately force the active child");

    first.exited.resolve({ code: 0 });
    second.exited.resolve({ code: 0 });
    await Promise.all([restarted, disposed]);
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
    assert.equal(
      first.forceDisposeCalls,
      2,
      "final disposal must retry a previously unconfirmed retired child",
    );
    assert.equal(third.disposeCalls, 0, "final disposal must not wait on graceful retirement");
    assert.equal(third.forceDisposeCalls, 1, "final disposal must force the active child immediately");
    first.exited.resolve({ code: 0 });
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

function inertLocalExecPollingPolicy() {
  return { start() { return { dispose() {} }; } };
}

function controlledLocalExecPollingPolicy() {
  let tick;
  return {
    policy: {
      start(work) {
        tick = work;
        return { dispose() { tick = undefined; } };
      },
    },
    async tick() {
      assert.equal(typeof tick, "function");
      await tick();
    },
  };
}

function localExecIdentity(pid, startEpochMs, entryRealpath, generationToken) {
  return {
    pid,
    startEpochMs,
    entryRealpath,
    generationToken,
    command: `${entryRealpath} --sand-local-exec-generation=${generationToken}`,
  };
}

test("pre-spawn durable quarantine reconciliation does not consume the supervisor respawn budget", async () => {
  const loaded = await loadModule("source/node-agent-coordinator/local-exec/supervisor.ts");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-local-exec-supervisor-"));
  const discoveryPath = path.join(temporary, "local-exec-daemon.json");
  const liveness = controlledLocalExecPollingPolicy();
  const entryRealpath = "C:\\app\\local-exec-daemon\\main.cjs";
  const identity = localExecIdentity(4_091, 1_000, entryRealpath, "recovered-generation");
  const descriptor = {
    pid: identity.pid,
    startedAt: 2_000,
    entryRealpath,
    generationToken: identity.generationToken,
    inflightCount: 0,
  };
  let blocked = true;
  let spawnCalls = 0;
  let reconciliationCalls = 0;
  try {
    const supervisor = loaded.module.createLocalExecDaemonSupervisor({
      dataDir: temporary,
      isPackaged: true,
      refreshPolicy: inertLocalExecPollingPolicy(),
      livenessPolicy: liveness.policy,
      now: () => 3_000,
      control: {
        async resolveGatewayConnection() { return { endpoint: "loopback" }; },
        async mintLocalExecDaemonCredential() { return null; },
        async reconcileLocalExecStartupQuarantine() {
          reconciliationCalls += 1;
          return blocked
            ? { blocked: true, reason: "durable startup quarantine still owns a live process" }
            : { blocked: false, reason: null };
        },
        async spawnLocalExecDaemon() {
          spawnCalls += 1;
          if (blocked) throw new Error("initial preflight race was blocked before native spawn");
          await writeFile(discoveryPath, JSON.stringify(descriptor), "utf8");
          return identity;
        },
        async getProcessIdentity({ pid }) { return !blocked && pid === identity.pid ? identity : null; },
        async isProcessAlive() { return false; },
        async terminateProcess() { return { terminated: true }; },
        async waitLocalExecDaemonExit() { return await new Promise(() => {}); },
      },
    });

    await supervisor.start();
    assert.equal(supervisor.state().phase, "failed");
    assert.equal(spawnCalls, 0);
    for (let attempt = 0; attempt < loaded.module.LOCAL_EXEC_DAEMON_RESPAWN_LIMIT + 3; attempt += 1) {
      await liveness.tick();
    }
    assert.equal(supervisor.state().phase, "failed");
    assert.match(supervisor.state().reason, /durable startup quarantine/);
    assert.equal(spawnCalls, 0, "pre-spawn reconciliation blocks must not invoke spawn");
    assert.ok(reconciliationCalls > loaded.module.LOCAL_EXEC_DAEMON_RESPAWN_LIMIT);
    blocked = false;
    await liveness.tick();
    assert.equal(spawnCalls, 1);
    assert.equal(supervisor.state().phase, "active");
    assert.equal(supervisor.state().daemon.pid, identity.pid);
    await supervisor.dispose();
  } finally {
    await loaded.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("post-spawn failures consume and stop at the supervisor respawn budget", async () => {
  const loaded = await loadModule("source/node-agent-coordinator/local-exec/supervisor.ts");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-local-exec-supervisor-"));
  const liveness = controlledLocalExecPollingPolicy();
  let spawnCalls = 0;
  try {
    const supervisor = loaded.module.createLocalExecDaemonSupervisor({
      dataDir: temporary,
      isPackaged: true,
      refreshPolicy: inertLocalExecPollingPolicy(),
      livenessPolicy: liveness.policy,
      control: {
        async resolveGatewayConnection() { return { endpoint: "loopback" }; },
        async mintLocalExecDaemonCredential() { return null; },
        async reconcileLocalExecStartupQuarantine() { return { blocked: false, reason: null }; },
        async spawnLocalExecDaemon() {
          spawnCalls += 1;
          throw new Error("native spawn was attempted but verification failed");
        },
        async getProcessIdentity() { return null; },
        async isProcessAlive() { return false; },
        async terminateProcess() { return { terminated: false }; },
        async waitLocalExecDaemonExit() { return await new Promise(() => {}); },
      },
    });
    await supervisor.start();
    for (let attempt = 0; attempt < loaded.module.LOCAL_EXEC_DAEMON_RESPAWN_LIMIT + 5; attempt += 1) {
      await liveness.tick();
    }
    assert.equal(spawnCalls, loaded.module.LOCAL_EXEC_DAEMON_RESPAWN_LIMIT + 1);
    assert.equal(supervisor.state().phase, "failed");
    const stoppedAt = spawnCalls;
    await liveness.tick();
    await liveness.tick();
    assert.equal(spawnCalls, stoppedAt);
    await supervisor.dispose();
  } finally {
    await loaded.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("local-exec replacement fails closed when a verified predecessor refuses termination", async () => {
  const loaded = await loadModule("source/node-agent-coordinator/local-exec/supervisor.ts");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-local-exec-supervisor-"));
  const discoveryPath = path.join(temporary, "local-exec-daemon.json");
  const entryRealpath = "C:\\app\\local-exec-daemon\\main.cjs";
  const predecessor = localExecIdentity(4_101, 1_000, entryRealpath, "old-generation");
  const descriptor = {
    pid: predecessor.pid,
    startedAt: 2_000,
    entryRealpath,
    generationToken: predecessor.generationToken,
    inflightCount: 0,
  };
  let spawnCalls = 0;
  let terminationCalls = 0;
  try {
    await writeFile(discoveryPath, JSON.stringify(descriptor), "utf8");
    const supervisor = loaded.module.createLocalExecDaemonSupervisor({
      dataDir: temporary,
      isPackaged: true,
      refreshPolicy: inertLocalExecPollingPolicy(),
      livenessPolicy: inertLocalExecPollingPolicy(),
      now: () => 3_000,
      control: {
        async resolveGatewayConnection() { return { endpoint: "loopback" }; },
        async mintLocalExecDaemonCredential() { return null; },
        async spawnLocalExecDaemon() {
          spawnCalls += 1;
          assert.fail("a live unretired predecessor must block replacement spawn");
        },
        async getProcessIdentity({ pid }) { return pid === predecessor.pid ? predecessor : null; },
        async isProcessAlive({ pid }) { return pid === predecessor.pid; },
        async terminateProcess({ identity }) {
          assert.deepEqual(identity, predecessor);
          terminationCalls += 1;
          return { terminated: false };
        },
        async waitLocalExecDaemonExit() { return await new Promise(() => {}); },
      },
    });

    await supervisor.start();
    assert.equal(spawnCalls, 0);
    assert.equal(terminationCalls, 1);
    assert.equal(supervisor.state().phase, "failed");
    assert.match(supervisor.state().reason, /remained alive after identity-verified termination was refused/);
    assert.deepEqual(JSON.parse(await readFile(discoveryPath, "utf8")), descriptor);
    await supervisor.dispose();
  } finally {
    await loaded.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("local-exec safely adopts an exact idle predecessor when no retained handle survives restart", async () => {
  const loaded = await loadModule("source/node-agent-coordinator/local-exec/supervisor.ts");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-local-exec-supervisor-"));
  const discoveryPath = path.join(temporary, "local-exec-daemon.json");
  const entryRealpath = "C:\\app\\local-exec-daemon\\main.cjs";
  const predecessor = localExecIdentity(4_111, 1_000, entryRealpath, "persisted-generation");
  const descriptor = {
    pid: predecessor.pid,
    startedAt: 2_000,
    entryRealpath,
    generationToken: predecessor.generationToken,
    inflightCount: 0,
  };
  let spawnCalls = 0;
  let terminationCalls = 0;
  let confirmationCalls = 0;
  try {
    await writeFile(discoveryPath, JSON.stringify(descriptor), "utf8");
    const supervisor = loaded.module.createLocalExecDaemonSupervisor({
      dataDir: temporary,
      isPackaged: true,
      refreshPolicy: inertLocalExecPollingPolicy(),
      livenessPolicy: inertLocalExecPollingPolicy(),
      now: () => 3_000,
      control: {
        async resolveGatewayConnection() { return { endpoint: "loopback" }; },
        async mintLocalExecDaemonCredential() { return null; },
        async reconcileLocalExecStartupQuarantine() { return { blocked: false, reason: null }; },
        async confirmLocalExecDaemonReady({ identity }) {
          confirmationCalls += 1;
          assert.deepEqual(identity, predecessor);
          return { confirmed: true };
        },
        async spawnLocalExecDaemon() {
          spawnCalls += 1;
          assert.fail("a verified handleless predecessor must be adopted without replacement");
        },
        async getProcessIdentity({ pid }) { return pid === predecessor.pid ? predecessor : null; },
        async inspectLocalExecProcessIdentity({ pid }) {
          return pid === predecessor.pid
            ? { status: "matching", identity: predecessor, terminationMode: "none" }
            : { status: "absent" };
        },
        async isProcessAlive({ pid }) { return pid === predecessor.pid; },
        async terminateProcess() {
          terminationCalls += 1;
          assert.fail("a handleless predecessor must never be signalled");
        },
        async waitLocalExecDaemonExit() { return await new Promise(() => {}); },
      },
    });

    await supervisor.start();
    assert.equal(spawnCalls, 0);
    assert.equal(terminationCalls, 0);
    assert.equal(confirmationCalls, 1);
    assert.deepEqual(supervisor.state(), {
      phase: "active",
      daemon: {
        origin: "adopted",
        pid: predecessor.pid,
        startedAt: descriptor.startedAt,
        processStartEpochMs: predecessor.startEpochMs,
        command: predecessor.command,
        entryRealpath,
        generationToken: predecessor.generationToken,
      },
    });
    assert.deepEqual(JSON.parse(await readFile(discoveryPath, "utf8")), descriptor);
    await supervisor.dispose();
  } finally {
    await loaded.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("local-exec quarantine releases an unrelated reused PID and recovers without signalling it", async () => {
  const loaded = await loadModule("source/node-agent-coordinator/local-exec/supervisor.ts");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-local-exec-supervisor-"));
  const discoveryPath = path.join(temporary, "local-exec-daemon.json");
  const liveness = controlledLocalExecPollingPolicy();
  const entryRealpath = "C:\\app\\local-exec-daemon\\main.cjs";
  const predecessor = localExecIdentity(4_151, 1_000, entryRealpath, "predecessor-generation");
  const successor = localExecIdentity(4_152, 4_000, entryRealpath, "successor-generation");
  const predecessorDescriptor = {
    pid: predecessor.pid,
    startedAt: 2_000,
    entryRealpath,
    generationToken: predecessor.generationToken,
    inflightCount: 0,
  };
  const successorDescriptor = {
    pid: successor.pid,
    startedAt: 5_000,
    entryRealpath,
    generationToken: successor.generationToken,
    inflightCount: 0,
  };
  let predecessorReused = false;
  let successorAlive = false;
  let spawnCalls = 0;
  let terminationCalls = 0;
  try {
    await writeFile(discoveryPath, JSON.stringify(predecessorDescriptor), "utf8");
    const supervisor = loaded.module.createLocalExecDaemonSupervisor({
      dataDir: temporary,
      isPackaged: true,
      refreshPolicy: inertLocalExecPollingPolicy(),
      livenessPolicy: liveness.policy,
      now: () => 6_000,
      control: {
        async resolveGatewayConnection() { return { endpoint: "loopback" }; },
        async mintLocalExecDaemonCredential() { return null; },
        async reconcileLocalExecStartupQuarantine() { return { blocked: false, reason: null }; },
        async spawnLocalExecDaemon() {
          assert.equal(predecessorReused, true);
          spawnCalls += 1;
          successorAlive = true;
          await writeFile(discoveryPath, JSON.stringify(successorDescriptor), "utf8");
          return successor;
        },
        async getProcessIdentity({ pid }) {
          if (pid === predecessor.pid) return predecessorReused ? null : predecessor;
          if (pid === successor.pid && successorAlive) return successor;
          return null;
        },
        async inspectLocalExecProcessIdentity({ pid }) {
          if (pid === predecessor.pid) {
            return predecessorReused
              ? { status: "different" }
              : { status: "matching", identity: predecessor, terminationMode: "retained-child" };
          }
          if (pid === successor.pid && successorAlive) return { status: "matching", identity: successor, terminationMode: "retained-child" };
          return { status: "absent" };
        },
        async isProcessAlive({ pid }) {
          return pid === predecessor.pid || (pid === successor.pid && successorAlive);
        },
        async terminateProcess({ identity }) {
          assert.deepEqual(identity, predecessor);
          terminationCalls += 1;
          return { terminated: false };
        },
        async waitLocalExecDaemonExit() { return await new Promise(() => {}); },
      },
    });

    await supervisor.start();
    assert.equal(supervisor.state().phase, "failed");
    assert.equal(terminationCalls, 1);
    predecessorReused = true;
    await liveness.tick();
    await liveness.tick();
    assert.equal(spawnCalls, 1);
    assert.equal(terminationCalls, 1, "the unrelated process at the reused PID must not be signalled");
    assert.equal(supervisor.state().phase, "active");
    assert.equal(supervisor.state().daemon.pid, successor.pid);
    await supervisor.dispose();
  } finally {
    await loaded.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("local-exec discovery identity failures quarantine a live PID across reconciliation ticks", async () => {
  const loaded = await loadModule("source/node-agent-coordinator/local-exec/supervisor.ts");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-local-exec-supervisor-"));
  const discoveryPath = path.join(temporary, "local-exec-daemon.json");
  const entryRealpath = "C:\\app\\local-exec-daemon\\main.cjs";
  const descriptor = {
    pid: 4_151,
    startedAt: 2_000,
    entryRealpath,
    generationToken: "unreadable-generation",
    inflightCount: 0,
  };
  const liveness = controlledLocalExecPollingPolicy();
  let spawnCalls = 0;
  try {
    await writeFile(discoveryPath, JSON.stringify(descriptor), "utf8");
    const supervisor = loaded.module.createLocalExecDaemonSupervisor({
      dataDir: temporary,
      isPackaged: true,
      refreshPolicy: inertLocalExecPollingPolicy(),
      livenessPolicy: liveness.policy,
      now: () => 3_000,
      control: {
        async resolveGatewayConnection() { return { endpoint: "loopback" }; },
        async mintLocalExecDaemonCredential() { return null; },
        async spawnLocalExecDaemon() {
          spawnCalls += 1;
          assert.fail("an identity-unreadable live PID must block replacement spawn");
        },
        async getProcessIdentity() { return null; },
        async isProcessAlive({ pid }) { return pid === descriptor.pid; },
        async terminateProcess() { assert.fail("an unverified PID must never be terminated"); },
        async waitLocalExecDaemonExit() { return await new Promise(() => {}); },
      },
    });

    await supervisor.start();
    assert.equal(supervisor.state().phase, "failed");
    assert.match(supervisor.state().reason, /remained alive while its discovery identity could not be verified/);
    await liveness.tick();
    await liveness.tick();
    assert.equal(supervisor.state().phase, "failed");
    assert.equal(spawnCalls, 0);
    assert.deepEqual(JSON.parse(await readFile(discoveryPath, "utf8")), descriptor);
    await supervisor.dispose();
  } finally {
    await loaded.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("local-exec termination errors quarantine the verified predecessor before retries", async () => {
  const loaded = await loadModule("source/node-agent-coordinator/local-exec/supervisor.ts");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-local-exec-supervisor-"));
  const discoveryPath = path.join(temporary, "local-exec-daemon.json");
  const entryRealpath = "C:\\app\\local-exec-daemon\\main.cjs";
  const predecessor = localExecIdentity(4_161, 1_000, entryRealpath, "stuck-generation");
  const descriptor = {
    pid: predecessor.pid,
    startedAt: 2_000,
    entryRealpath,
    generationToken: predecessor.generationToken,
    inflightCount: 0,
  };
  const liveness = controlledLocalExecPollingPolicy();
  let spawnCalls = 0;
  let terminationCalls = 0;
  try {
    await writeFile(discoveryPath, JSON.stringify(descriptor), "utf8");
    const supervisor = loaded.module.createLocalExecDaemonSupervisor({
      dataDir: temporary,
      isPackaged: true,
      refreshPolicy: inertLocalExecPollingPolicy(),
      livenessPolicy: liveness.policy,
      now: () => 3_000,
      control: {
        async resolveGatewayConnection() { return { endpoint: "loopback" }; },
        async mintLocalExecDaemonCredential() { return null; },
        async spawnLocalExecDaemon() {
          spawnCalls += 1;
          assert.fail("a termination error must block every replacement retry");
        },
        async getProcessIdentity({ pid }) { return pid === predecessor.pid ? predecessor : null; },
        async isProcessAlive({ pid }) { return pid === predecessor.pid; },
        async terminateProcess({ identity }) {
          assert.deepEqual(identity, predecessor);
          terminationCalls += 1;
          throw new Error("simulated termination timeout");
        },
        async waitLocalExecDaemonExit() { return await new Promise(() => {}); },
      },
    });

    await supervisor.start();
    assert.equal(supervisor.state().phase, "failed");
    assert.match(supervisor.state().reason, /simulated termination timeout/);
    await liveness.tick();
    await liveness.tick();
    assert.equal(supervisor.state().phase, "failed");
    assert.equal(terminationCalls, 1);
    assert.equal(spawnCalls, 0);
    assert.deepEqual(JSON.parse(await readFile(discoveryPath, "utf8")), descriptor);
    await supervisor.dispose();
  } finally {
    await loaded.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("local-exec active healing never replaces a live process after a transient identity read failure", async () => {
  const loaded = await loadModule("source/node-agent-coordinator/local-exec/supervisor.ts");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-local-exec-supervisor-"));
  const discoveryPath = path.join(temporary, "local-exec-daemon.json");
  const entryRealpath = "C:\\app\\local-exec-daemon\\main.cjs";
  const active = localExecIdentity(4_171, 1_000, entryRealpath, "active-generation");
  const descriptor = {
    pid: active.pid,
    startedAt: 2_000,
    entryRealpath,
    generationToken: active.generationToken,
    inflightCount: 1,
  };
  const liveness = controlledLocalExecPollingPolicy();
  let identityReadable = true;
  let spawnCalls = 0;
  try {
    await writeFile(discoveryPath, JSON.stringify(descriptor), "utf8");
    const supervisor = loaded.module.createLocalExecDaemonSupervisor({
      dataDir: temporary,
      isPackaged: true,
      refreshPolicy: inertLocalExecPollingPolicy(),
      livenessPolicy: liveness.policy,
      now: () => 3_000,
      control: {
        async resolveGatewayConnection() { return { endpoint: "loopback" }; },
        async mintLocalExecDaemonCredential() { return null; },
        async spawnLocalExecDaemon() {
          spawnCalls += 1;
          assert.fail("a transient identity failure must not duplicate the active daemon");
        },
        async getProcessIdentity({ pid }) { return identityReadable && pid === active.pid ? active : null; },
        async isProcessAlive({ pid }) { return pid === active.pid; },
        async terminateProcess() { assert.fail("an identity-unreadable active PID must not be terminated"); },
        async waitLocalExecDaemonExit() { return await new Promise(() => {}); },
      },
    });

    await supervisor.start();
    assert.equal(supervisor.state().phase, "active");
    identityReadable = false;
    await liveness.tick();
    await liveness.tick();
    assert.equal(supervisor.state().phase, "failed");
    assert.match(supervisor.state().reason, /active process remained alive while its identity could not be verified/);
    await liveness.tick();
    assert.equal(spawnCalls, 0);
    assert.deepEqual(JSON.parse(await readFile(discoveryPath, "utf8")), descriptor);
    identityReadable = true;
    await liveness.tick();
    assert.equal(supervisor.state().phase, "active");
    assert.equal(supervisor.state().daemon.pid, active.pid);
    assert.equal(spawnCalls, 0);
    await supervisor.dispose();
  } finally {
    await loaded.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("an inflight Windows stable-handle adoption can be paused, retired, and resumed fresh", async () => {
  const loaded = await loadModule("source/node-agent-coordinator/local-exec/supervisor.ts");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-local-exec-supervisor-"));
  const discoveryPath = path.join(temporary, "local-exec-daemon.json");
  const entryRealpath = "C:\\app\\local-exec-daemon\\main.cjs";
  const adopted = localExecIdentity(4_176, 1_000, entryRealpath, "adopted-pause-generation");
  const successor = localExecIdentity(4_179, 4_000, entryRealpath, "pause-resume-generation");
  const descriptor = {
    pid: adopted.pid,
    startedAt: 2_000,
    entryRealpath,
    generationToken: adopted.generationToken,
    inflightCount: 1,
  };
  const successorDescriptor = {
    pid: successor.pid,
    startedAt: 4_500,
    entryRealpath,
    generationToken: successor.generationToken,
    inflightCount: 0,
  };
  let adoptedAlive = true;
  let successorAlive = false;
  let spawnCalls = 0;
  let terminationCalls = 0;
  try {
    await writeFile(discoveryPath, JSON.stringify(descriptor), "utf8");
    const supervisor = loaded.module.createLocalExecDaemonSupervisor({
      dataDir: temporary,
      isPackaged: true,
      refreshPolicy: inertLocalExecPollingPolicy(),
      livenessPolicy: inertLocalExecPollingPolicy(),
      now: () => 5_000,
      control: {
        async resolveGatewayConnection() { return { endpoint: "loopback" }; },
        async mintLocalExecDaemonCredential() { return null; },
        async reconcileLocalExecStartupQuarantine() { return { blocked: false, reason: null }; },
        async confirmLocalExecDaemonReady() { return { confirmed: true }; },
        async spawnLocalExecDaemon() {
          assert.equal(adoptedAlive, false, "resume must not spawn until the adopted daemon exits");
          spawnCalls += 1;
          successorAlive = true;
          await writeFile(discoveryPath, JSON.stringify(successorDescriptor), "utf8");
          return successor;
        },
        async getProcessIdentity({ pid }) {
          if (pid === adopted.pid && adoptedAlive) return adopted;
          if (pid === successor.pid && successorAlive) return successor;
          return null;
        },
        async inspectLocalExecProcessIdentity({ pid }) {
          if (pid === adopted.pid && adoptedAlive) {
            return { status: "matching", identity: adopted, terminationMode: "win32-stable-handle" };
          }
          if (pid === successor.pid && successorAlive) {
            return { status: "matching", identity: successor, terminationMode: "retained-child" };
          }
          return { status: "absent" };
        },
        async isProcessAlive({ pid }) {
          return (pid === adopted.pid && adoptedAlive) || (pid === successor.pid && successorAlive);
        },
        async terminateProcess({ identity }) {
          terminationCalls += 1;
          assert.deepEqual(identity, adopted);
          adoptedAlive = false;
          return { terminated: true };
        },
        async waitLocalExecDaemonExit() { return await new Promise(() => {}); },
      },
    });

    await supervisor.start();
    assert.equal(supervisor.state().phase, "active");
    assert.equal(supervisor.state().daemon.origin, "adopted");
    await supervisor.setPaused(true);
    assert.deepEqual(supervisor.state(), { phase: "absent" });
    assert.equal(terminationCalls, 1);
    await assert.rejects(readFile(discoveryPath, "utf8"), error => error?.code === "ENOENT");
    await supervisor.setPaused(false);
    assert.equal(spawnCalls, 1);
    assert.equal(supervisor.state().phase, "active");
    assert.equal(supervisor.state().daemon.origin, "spawned");
    assert.equal(supervisor.state().daemon.pid, successor.pid);
    await supervisor.dispose();
  } finally {
    await loaded.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("missing discovery retires an inflight Windows adoption before spawning its successor", async () => {
  const loaded = await loadModule("source/node-agent-coordinator/local-exec/supervisor.ts");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-local-exec-supervisor-"));
  const discoveryPath = path.join(temporary, "local-exec-daemon.json");
  const entryRealpath = "C:\\app\\local-exec-daemon\\main.cjs";
  const adopted = localExecIdentity(4_177, 1_000, entryRealpath, "adopted-missing-generation");
  const successor = localExecIdentity(4_178, 4_000, entryRealpath, "successor-generation");
  const adoptedDescriptor = {
    pid: adopted.pid,
    startedAt: 2_000,
    entryRealpath,
    generationToken: adopted.generationToken,
    inflightCount: 1,
  };
  const successorDescriptor = {
    pid: successor.pid,
    startedAt: 4_500,
    entryRealpath,
    generationToken: successor.generationToken,
    inflightCount: 0,
  };
  const liveness = controlledLocalExecPollingPolicy();
  let adoptedAlive = true;
  let successorAlive = false;
  let spawnCalls = 0;
  let terminationCalls = 0;
  try {
    await writeFile(discoveryPath, JSON.stringify(adoptedDescriptor), "utf8");
    const supervisor = loaded.module.createLocalExecDaemonSupervisor({
      dataDir: temporary,
      isPackaged: true,
      refreshPolicy: inertLocalExecPollingPolicy(),
      livenessPolicy: liveness.policy,
      now: () => 5_000,
      control: {
        async resolveGatewayConnection() { return { endpoint: "loopback" }; },
        async mintLocalExecDaemonCredential() { return null; },
        async reconcileLocalExecStartupQuarantine() { return { blocked: false, reason: null }; },
        async confirmLocalExecDaemonReady() { return { confirmed: true }; },
        async spawnLocalExecDaemon() {
          assert.equal(adoptedAlive, false, "the old daemon must be gone before replacement spawn");
          spawnCalls += 1;
          successorAlive = true;
          await writeFile(discoveryPath, JSON.stringify(successorDescriptor), "utf8");
          return successor;
        },
        async getProcessIdentity({ pid }) {
          if (pid === adopted.pid && adoptedAlive) return adopted;
          if (pid === successor.pid && successorAlive) return successor;
          return null;
        },
        async inspectLocalExecProcessIdentity({ pid }) {
          if (pid === adopted.pid && adoptedAlive) {
            return { status: "matching", identity: adopted, terminationMode: "win32-stable-handle" };
          }
          if (pid === successor.pid && successorAlive) {
            return { status: "matching", identity: successor, terminationMode: "retained-child" };
          }
          return { status: "absent" };
        },
        async isProcessAlive({ pid }) {
          return (pid === adopted.pid && adoptedAlive) || (pid === successor.pid && successorAlive);
        },
        async terminateProcess({ identity }) {
          terminationCalls += 1;
          assert.deepEqual(identity, adopted);
          adoptedAlive = false;
          return { terminated: true };
        },
        async waitLocalExecDaemonExit() { return await new Promise(() => {}); },
      },
    });

    await supervisor.start();
    assert.equal(supervisor.state().daemon.origin, "adopted");
    await rm(discoveryPath, { force: true });
    await liveness.tick();
    await liveness.tick();
    await liveness.tick();
    assert.equal(terminationCalls, 1);
    assert.equal(spawnCalls, 1);
    assert.equal(supervisor.state().phase, "active");
    assert.equal(supervisor.state().daemon.origin, "spawned");
    assert.equal(supervisor.state().daemon.pid, successor.pid);
    await supervisor.dispose();
  } finally {
    await loaded.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});
test("local-exec pause and resume preserve an unreadable live discovery without spawning", async () => {
  const loaded = await loadModule("source/node-agent-coordinator/local-exec/supervisor.ts");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-local-exec-supervisor-"));
  const discoveryPath = path.join(temporary, "local-exec-daemon.json");
  const descriptor = {
    pid: 4_181,
    startedAt: 2_000,
    entryRealpath: "C:\\app\\local-exec-daemon\\main.cjs",
    generationToken: "pause-generation",
    inflightCount: 0,
  };
  let spawnCalls = 0;
  try {
    await writeFile(discoveryPath, JSON.stringify(descriptor), "utf8");
    const supervisor = loaded.module.createLocalExecDaemonSupervisor({
      dataDir: temporary,
      isPackaged: true,
      refreshPolicy: inertLocalExecPollingPolicy(),
      livenessPolicy: inertLocalExecPollingPolicy(),
      now: () => 3_000,
      control: {
        async resolveGatewayConnection() { return { endpoint: "loopback" }; },
        async mintLocalExecDaemonCredential() { return null; },
        async spawnLocalExecDaemon() {
          spawnCalls += 1;
          assert.fail("pause/resume must not duplicate an unreadable live daemon");
        },
        async getProcessIdentity() { throw new Error("simulated CIM outage"); },
        async isProcessAlive({ pid }) { return pid === descriptor.pid; },
        async terminateProcess() { assert.fail("an unreadable PID must not be terminated"); },
        async waitLocalExecDaemonExit() { return await new Promise(() => {}); },
      },
    });

    await supervisor.setPaused(true);
    assert.equal(supervisor.state().phase, "failed");
    assert.match(supervisor.state().reason, /pause retirement could not verify its identity/);
    await supervisor.start();
    await supervisor.setPaused(false);
    assert.equal(supervisor.state().phase, "failed");
    assert.equal(spawnCalls, 0);
    assert.deepEqual(JSON.parse(await readFile(discoveryPath, "utf8")), descriptor);
    await supervisor.dispose();
  } finally {
    await loaded.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("local-exec healing quarantines both generations when successor identity lookup fails", async () => {
  const loaded = await loadModule("source/node-agent-coordinator/local-exec/supervisor.ts");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-local-exec-supervisor-"));
  const discoveryPath = path.join(temporary, "local-exec-daemon.json");
  const entryRealpath = "C:\\app\\local-exec-daemon\\main.cjs";
  const active = localExecIdentity(4_191, 1_000, entryRealpath, "active-generation");
  const successor = localExecIdentity(4_192, 3_000, entryRealpath, "successor-generation");
  const activeDescriptor = {
    pid: active.pid,
    startedAt: 2_000,
    entryRealpath,
    generationToken: active.generationToken,
    inflightCount: 1,
  };
  const successorDescriptor = {
    pid: successor.pid,
    startedAt: 3_500,
    entryRealpath,
    generationToken: successor.generationToken,
    inflightCount: 0,
  };
  const liveness = controlledLocalExecPollingPolicy();
  let successorVisible = false;
  let spawnCalls = 0;
  try {
    await writeFile(discoveryPath, JSON.stringify(activeDescriptor), "utf8");
    const supervisor = loaded.module.createLocalExecDaemonSupervisor({
      dataDir: temporary,
      isPackaged: true,
      refreshPolicy: inertLocalExecPollingPolicy(),
      livenessPolicy: liveness.policy,
      now: () => 4_000,
      control: {
        async resolveGatewayConnection() { return { endpoint: "loopback" }; },
        async mintLocalExecDaemonCredential() { return null; },
        async spawnLocalExecDaemon() {
          spawnCalls += 1;
          assert.fail("ambiguous live generations must block every replacement spawn");
        },
        async getProcessIdentity({ pid }) {
          if (pid === active.pid) return active;
          if (pid === successor.pid && successorVisible) throw new Error("simulated successor CIM failure");
          return null;
        },
        async isProcessAlive({ pid }) { return pid === active.pid || pid === successor.pid; },
        async terminateProcess() { assert.fail("ambiguous live generations must not be terminated"); },
        async waitLocalExecDaemonExit() { return await new Promise(() => {}); },
      },
    });

    await supervisor.start();
    assert.equal(supervisor.state().phase, "active");
    successorVisible = true;
    await writeFile(discoveryPath, JSON.stringify(successorDescriptor), "utf8");
    await liveness.tick();
    await liveness.tick();
    assert.equal(supervisor.state().phase, "failed");
    assert.match(supervisor.state().reason, /replacement discovery could not be verified/);
    await liveness.tick();
    assert.equal(spawnCalls, 0);
    assert.deepEqual(JSON.parse(await readFile(discoveryPath, "utf8")), successorDescriptor);
    await supervisor.dispose();
  } finally {
    await loaded.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("Windows stable-handle capability rotates an idle predecessor before spawning a new generation", async () => {
  const loaded = await loadModule("source/node-agent-coordinator/local-exec/supervisor.ts");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-local-exec-supervisor-"));
  const discoveryPath = path.join(temporary, "local-exec-daemon.json");
  const entryRealpath = "C:\\app\\local-exec-daemon\\main.cjs";
  const predecessor = localExecIdentity(4_201, 1_000, entryRealpath, "old-generation");
  const successor = localExecIdentity(4_202, 3_000, entryRealpath, "new-generation");
  const predecessorDescriptor = {
    pid: predecessor.pid,
    startedAt: 2_000,
    entryRealpath,
    generationToken: predecessor.generationToken,
    inflightCount: 0,
  };
  const successorDescriptor = {
    pid: successor.pid,
    startedAt: 3_500,
    entryRealpath,
    generationToken: successor.generationToken,
    inflightCount: 0,
  };
  const alive = new Set([predecessor.pid]);
  let spawnCalls = 0;
  try {
    await writeFile(discoveryPath, JSON.stringify(predecessorDescriptor), "utf8");
    const supervisor = loaded.module.createLocalExecDaemonSupervisor({
      dataDir: temporary,
      isPackaged: true,
      refreshPolicy: inertLocalExecPollingPolicy(),
      livenessPolicy: inertLocalExecPollingPolicy(),
      now: () => 4_000,
      delay: async () => {},
      control: {
        async resolveGatewayConnection() { return { endpoint: "loopback" }; },
        async mintLocalExecDaemonCredential() { return null; },
        async spawnLocalExecDaemon() {
          assert.equal(alive.has(predecessor.pid), false);
          spawnCalls += 1;
          alive.add(successor.pid);
          await writeFile(discoveryPath, JSON.stringify(successorDescriptor), "utf8");
          return successor;
        },
        async getProcessIdentity({ pid }) {
          if (!alive.has(pid)) return null;
          if (pid === predecessor.pid) return predecessor;
          if (pid === successor.pid) return successor;
          return null;
        },
        async inspectLocalExecProcessIdentity({ pid }) {
          if (!alive.has(pid)) return { status: "absent" };
          if (pid === predecessor.pid) {
            return {
              status: "matching",
              identity: predecessor,
              terminationMode: "win32-stable-handle",
            };
          }
          if (pid === successor.pid) {
            return {
              status: "matching",
              identity: successor,
              terminationMode: "retained-child",
            };
          }
          return { status: "different" };
        },
        async isProcessAlive({ pid }) { return alive.has(pid); },
        async terminateProcess({ identity }) {
          assert.deepEqual(identity, predecessor);
          alive.delete(identity.pid);
          return { terminated: true };
        },
        async waitLocalExecDaemonExit() { return await new Promise(() => {}); },
      },
    });

    await supervisor.start();
    assert.equal(spawnCalls, 1);
    assert.deepEqual(supervisor.state(), {
      phase: "active",
      daemon: {
        origin: "spawned",
        pid: successor.pid,
        startedAt: successorDescriptor.startedAt,
        processStartEpochMs: successor.startEpochMs,
        command: successor.command,
        entryRealpath,
        generationToken: successor.generationToken,
      },
    });
    assert.deepEqual(JSON.parse(await readFile(discoveryPath, "utf8")), successorDescriptor);
    await supervisor.dispose();
  } finally {
    await loaded.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("Windows local-exec identity parsing handles PowerShell dates with an absolute UTF-8 query", async () => {
  const loaded = await loadModule("source/electron-main/local-exec/local-exec-native.ts");
  try {
    assert.equal(loaded.module.parseWindowsProcessStartEpochMs("/Date(1788123741538)/"), 1_788_123_741_538);
    assert.equal(
      loaded.module.parseWindowsProcessStartEpochMs("2026-08-30T21:02:21.538Z"),
      Date.parse("2026-08-30T21:02:21.538Z"),
    );

    let invocation;
    const commandLine = '"C:\\app\\Grok Bot.exe" "C:\\app\\main.cjs" --sand-local-exec-generation=test-generation';
    const identity = loaded.module.readProcessIdentity(5_208, "win32", {
      environment: { SystemRoot: "D:\\Windows" },
      execFileSync(file, args, options) {
        invocation = { file, args, options };
        return JSON.stringify({
          CreationDate: "2026-08-30T21:02:21.538Z",
          CommandLine: commandLine,
        });
      },
    });
    assert.deepEqual(identity, {
      pid: 5_208,
      startEpochMs: Date.parse("2026-08-30T21:02:21.538Z"),
      command: commandLine,
    });
    assert.equal(invocation.file, "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    assert.deepEqual(invocation.args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
    assert.match(invocation.args[4], /OutputEncoding/);
    assert.match(invocation.args[4], /ToUniversalTime\(\)\.ToString\('o'\)/);
    assert.equal(invocation.options.encoding, "utf8");
    assert.equal(invocation.options.windowsHide, true);
  } finally {
    await loaded.dispose();
  }
});

test("process liveness distinguishes confirmed absence from inspection failure", async () => {
  const loaded = await loadModule("source/electron-main/local-exec/local-exec-native.ts");
  try {
    const errno = code => Object.assign(new Error(code), { code });
    assert.equal(loaded.module.isProcessAlive(101, () => { throw errno("ESRCH"); }), false);
    assert.equal(loaded.module.isProcessAlive(102, () => { throw errno("EPERM"); }, () => null), true);
    assert.equal(loaded.module.isProcessAlive(103, () => true, () => "Z"), false);
    assert.throws(
      () => loaded.module.isProcessAlive(104, () => { throw errno("EIO"); }),
      error => error?.code === "EIO",
    );
  } finally {
    await loaded.dispose();
  }
});

test("Windows local-exec termination refuses a PID-only path without a retained child handle", async () => {
  const loaded = await loadModule("source/electron-main/local-exec/local-exec-native.ts");
  try {
    let taskkillCalls = 0;
    await assert.rejects(
      loaded.module.terminateProcess(5_208, {
        platform: "win32",
        environment: { SystemRoot: "D:\\Windows" },
        execFileSync() {
          taskkillCalls += 1;
          return "";
        },
      }),
      error => error instanceof loaded.module.LocalExecTerminationIdentityError
        && /no retained child-process handle/.test(error.message),
    );
    assert.equal(taskkillCalls, 0);
  } finally {
    await loaded.dispose();
  }
});

test("Windows handleless expected-identity termination requires stable-handle opt-in", async () => {
  const loaded = await loadModule("source/electron-main/local-exec/local-exec-native.ts");
  try {
    const expected = { pid: 5_208, startEpochMs: 10, command: "expected daemon" };
    let powershellCalls = 0;
    await assert.rejects(
      loaded.module.terminateProcess(expected.pid, {
        platform: "win32",
        expectedIdentity: expected,
        readIdentity: () => expected,
        isAlive: () => true,
        execFileSync() {
          powershellCalls += 1;
          return "";
        },
      }),
      error => error instanceof loaded.module.LocalExecTerminationIdentityError
        && /no retained child-process handle/.test(error.message),
    );
    assert.equal(powershellCalls, 0);
  } finally {
    await loaded.dispose();
  }
});

test("Windows stable-handle termination rejects invalid runtime identities before PowerShell", async () => {
  const loaded = await loadModule("source/electron-main/local-exec/local-exec-native.ts");
  try {
    const invalid = [
      { pid: 5_210.5, startEpochMs: 10, command: "daemon" },
      { pid: 5_210, startEpochMs: 10.5, command: "daemon" },
      { pid: 5_210, startEpochMs: 10, command: "" },
    ];
    let powershellCalls = 0;
    for (const expected of invalid) {
      await assert.rejects(
        loaded.module.terminateProcess(expected.pid, {
          platform: "win32",
          expectedIdentity: expected,
          allowVerifiedWindowsHandleAcquisition: true,
          execFileSync() {
            powershellCalls += 1;
            return "";
          },
          readIdentity: () => expected,
          isAlive: () => true,
        }),
        error => error instanceof loaded.module.LocalExecTerminationIdentityError,
      );
    }
    assert.equal(powershellCalls, 0);
  } finally {
    await loaded.dispose();
  }
});

test("Windows updater termination acquires and validates a stable process handle in one PowerShell lane", async () => {
  const loaded = await loadModule("source/electron-main/local-exec/local-exec-native.ts");
  try {
    const expected = {
      pid: 5_210,
      startEpochMs: 1_788_123_741_538,
      command: '"C:\\사용자\\Grok Bot.exe" "C:\\사용자\\main.cjs" --sand-local-exec-generation=update-generation',
    };
    let invocation;
    let waited = false;
    await loaded.module.terminateProcess(expected.pid, {
      platform: "win32",
      expectedIdentity: expected,
      allowVerifiedWindowsHandleAcquisition: true,
      environment: { SystemRoot: "D:\\Windows" },
      execFileSync(file, args, options) {
        invocation = { file, args, options };
        return "";
      },
      readIdentity: () => expected,
      isAlive: () => true,
      async waitForExit(pid) {
        assert.equal(pid, expected.pid);
        waited = true;
      },
    });
    assert.equal(invocation.file, "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    assert.deepEqual(invocation.args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
    const script = invocation.args[4];
    assert.equal((script.match(/Get-CimInstance Win32_Process/g) ?? []).length, 2);
    assert.match(script, /GetProcessById\(5210\)/);
    assert.match(script, /\$null = \$target\.Handle/);
    assert.match(script, /\$target\.StartTime/);
    assert.match(script, /\$heldCim = Get-CimInstance/);
    assert.match(script, /\$heldCimStart/);
    assert.match(script, /\$target\.Kill\(\)/);
    assert.match(script, /WaitForExit\(5000\)/);
    assert.match(script, /\[Console\]::In\.ReadToEnd\(\)/);
    assert.match(script, /FromBase64String\(\$payloadBase64\)/);
    assert.doesNotMatch(script, /taskkill|Stop-Process|process\.kill/i);
    assert.doesNotMatch(script, /update-generation/);
    assert.doesNotMatch(invocation.args.join(" "), /update-generation/);
    assert.doesNotMatch(script, /try \{;/);
    assert.deepEqual(
      JSON.parse(Buffer.from(invocation.options.input, "base64").toString("utf8")),
      {
        startEpochMs: expected.startEpochMs,
        command: expected.command,
      },
    );
    assert.equal(invocation.options.windowsHide, true);
    assert.equal(invocation.options.timeout, 10_000);
    assert.equal(waited, true);
  } finally {
    await loaded.dispose();
  }
});

test("Windows stable-handle termination kills the exact live process without a retained ChildProcess object", {
  skip: process.platform !== "win32",
}, async () => {
  const loaded = await loadModule("source/electron-main/local-exec/local-exec-native.ts");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], {
    windowsHide: true,
    stdio: "ignore",
  });
  const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  try {
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    let identity = null;
    for (let attempt = 0; attempt < 20 && identity == null; attempt += 1) {
      identity = loaded.module.readProcessIdentity(child.pid, "win32");
      if (identity == null) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(identity != null, "Windows could not inspect the exact child identity");
    await loaded.module.terminateProcess(child.pid, {
      platform: "win32",
      expectedIdentity: identity,
      allowVerifiedWindowsHandleAcquisition: true,
    });
    const settlement = await Promise.race([
      closed,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("stable Windows handle termination did not close the child")),
        10_000,
      )),
    ]);
    assert.ok(settlement.code !== null || settlement.signal !== null);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await loaded.dispose();
  }
});

test("retained-handle termination without an expected identity requires explicit opt-in", async () => {
  const loaded = await loadModule("source/electron-main/local-exec/local-exec-native.ts");
  try {
    const signals = [];
    const ownedChild = {
      pid: 5_208,
      exitCode: null,
      signalCode: null,
      kill(signal) { signals.push(signal); return true; },
      once() {},
      off() {},
    };
    await assert.rejects(
      loaded.module.terminateProcess(5_208, {
        platform: "win32",
        ownedChild,
        isAlive: () => true,
      }),
      error => error instanceof loaded.module.LocalExecTerminationIdentityError
        && /explicit unidentified-owned opt-in/.test(error.message),
    );
    assert.deepEqual(signals, []);
  } finally {
    await loaded.dispose();
  }
});

test("Windows expected-identity termination uses only the retained process handle", async () => {
  const loaded = await loadModule("source/electron-main/local-exec/local-exec-native.ts");
  try {
    const expected = { pid: 5_209, startEpochMs: 10, command: "expected daemon" };
    const signals = [];
    let taskkillCalls = 0;
    const ownedChild = {
      pid: expected.pid,
      exitCode: null,
      signalCode: null,
      kill(signal) { signals.push(signal); return true; },
      once() {},
      off() {},
    };
    await loaded.module.terminateProcess(expected.pid, {
      platform: "win32",
      expectedIdentity: expected,
      ownedChild,
      readIdentity: () => expected,
      isAlive: () => true,
      execFileSync() {
        taskkillCalls += 1;
        assert.fail("retained-handle termination must never invoke taskkill");
      },
      async waitForExit() {},
    });
    assert.deepEqual(signals, ["SIGTERM"]);
    assert.equal(taskkillCalls, 0);
  } finally {
    await loaded.dispose();
  }
});

test("Windows local-exec exit verification requires both PID signalling and CIM identity to disappear", async () => {
  const loaded = await loadModule("source/electron-main/local-exec/local-exec-native.ts");
  try {
    let identityReads = 0;
    let delays = 0;
    await loaded.module.waitForWindowsProcessExit(5_208, {
      isAlive: () => false,
      readIdentity: () => {
        identityReads += 1;
        return identityReads === 1
          ? { pid: 5_208, startEpochMs: 1, command: "still present" }
          : null;
      },
      delay: async milliseconds => {
        assert.equal(milliseconds, 100);
        delays += 1;
      },
    });
    assert.equal(identityReads, 2);
    assert.equal(delays, 1);
  } finally {
    await loaded.dispose();
  }
});

test("Windows retained-handle termination treats an already-exited child as success", async () => {
  const loaded = await loadModule("source/electron-main/local-exec/local-exec-native.ts");
  try {
    const expected = { pid: 5_208, startEpochMs: 10, command: "expected daemon" };
    let handleSignals = 0;
    const ownedChild = {
      pid: expected.pid,
      exitCode: 0,
      signalCode: null,
      kill() { handleSignals += 1; return false; },
      once() {},
      off() {},
    };
    await loaded.module.terminateProcess(expected.pid, {
      platform: "win32",
      expectedIdentity: expected,
      ownedChild,
      readIdentity: () => null,
      isAlive: () => true,
    });
    assert.equal(handleSignals, 0);
  } finally {
    await loaded.dispose();
  }
});

test("Windows retained-handle termination refuses a mismatched PID identity before signalling", async () => {
  const loaded = await loadModule("source/electron-main/local-exec/local-exec-native.ts");
  try {
    const expected = { pid: 5_208, startEpochMs: 10, command: "expected daemon" };
    const replacement = { pid: expected.pid, startEpochMs: 11, command: "unrelated process" };
    const signals = [];
    const ownedChild = {
      pid: expected.pid,
      exitCode: null,
      signalCode: null,
      kill(signal) { signals.push(signal); return true; },
      once() {},
      off() {},
    };
    await assert.rejects(
      loaded.module.terminateProcess(expected.pid, {
        platform: "win32",
        expectedIdentity: expected,
        ownedChild,
        readIdentity: () => replacement,
        isAlive: () => true,
      }),
      error => error instanceof loaded.module.LocalExecTerminationIdentityError
        && /changed identity before owned-handle termination/.test(error.message),
    );
    assert.deepEqual(signals, []);
  } finally {
    await loaded.dispose();
  }
});

test("POSIX owned unidentified termination escalates the same retained handle from SIGTERM to SIGKILL", async () => {
  const loaded = await loadModule("source/electron-main/local-exec/local-exec-native.ts");
  try {
    const signals = [];
    let waitCalls = 0;
    const ownedChild = {
      pid: 4_201,
      exitCode: null,
      signalCode: null,
      kill(signal) { signals.push(signal); return true; },
      once() {},
      off() {},
    };
    await loaded.module.terminateProcess(4_201, {
      platform: "linux",
      ownedChild,
      allowUnidentifiedOwnedEscalation: true,
      isUnidentifiedProcessStillOwned: () => true,
      async waitForExit(pid) {
        assert.equal(pid, 4_201);
        waitCalls += 1;
        if (waitCalls === 1) throw new loaded.module.LocalExecTerminationTimeoutError(pid);
      },
    });
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(waitCalls, 2);
  } finally {
    await loaded.dispose();
  }
});

test("POSIX unidentified escalation stops before a second retained-handle signal when ownership is gone", async () => {
  const loaded = await loadModule("source/electron-main/local-exec/local-exec-native.ts");
  try {
    const signals = [];
    let ownershipChecks = 0;
    const ownedChild = {
      pid: 4_202,
      exitCode: null,
      signalCode: null,
      kill(signal) { signals.push(signal); return true; },
      once() {},
      off() {},
    };
    await loaded.module.terminateProcess(4_202, {
      platform: "linux",
      ownedChild,
      allowUnidentifiedOwnedEscalation: true,
      isUnidentifiedProcessStillOwned() {
        ownershipChecks += 1;
        return ownershipChecks === 1;
      },
      async waitForExit(pid) {
        throw new loaded.module.LocalExecTerminationTimeoutError(pid);
      },
    });
    assert.deepEqual(signals, ["SIGTERM"]);
    assert.equal(ownershipChecks, 2);
  } finally {
    await loaded.dispose();
  }
});

test("POSIX identified termination will not signal a retained handle after identity mismatch", async () => {
  const loaded = await loadModule("source/electron-main/local-exec/local-exec-native.ts");
  try {
    const expected = { pid: 4_201, startEpochMs: 10, command: "expected daemon" };
    const replacement = { pid: expected.pid, startEpochMs: 11, command: "unrelated process" };
    const signals = [];
    const ownedChild = {
      pid: expected.pid,
      exitCode: null,
      signalCode: null,
      kill(signal) { signals.push(signal); return true; },
      once() {},
      off() {},
    };
    await assert.rejects(
      loaded.module.terminateProcess(expected.pid, {
        platform: "linux",
        expectedIdentity: expected,
        ownedChild,
        readIdentity: () => replacement,
        isAlive: () => true,
        async waitForExit() { assert.fail("identity mismatch must be rejected before waiting"); },
      }),
      error => error instanceof loaded.module.LocalExecTerminationIdentityError
        && /changed identity before owned-handle termination/.test(error.message),
    );
    assert.deepEqual(signals, []);
  } finally {
    await loaded.dispose();
  }
});

test("staged-update daemon shutdown forwards an exact identity into stable Windows handle acquisition", async () => {
  const loaded = await loadModule("source/electron-main/local-exec/local-exec-native.ts");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-local-exec-update-stop-"));
  const discoveryPath = path.join(temporary, "local-exec-daemon.json");
  const entryRealpath = "C:\\app\\local-exec-daemon\\main.cjs";
  const generationToken = "staged-update-generation";
  const observed = {
    pid: 5_311,
    startEpochMs: 9_900,
    command: `node "${entryRealpath}" --sand-local-exec-generation=${generationToken}`,
  };
  let termination;
  let alive = true;
  try {
    await writeFile(discoveryPath, JSON.stringify({
      pid: observed.pid,
      startedAt: 9_950,
      entryRealpath,
      generationToken,
      inflightCount: 0,
    }), "utf8");
    await loaded.module.killLocalExecDaemon(discoveryPath, {
      expectedPid: observed.pid,
      expectedEntryRealpath: entryRealpath,
      readIdentity: () => alive ? observed : null,
      isAlive: () => alive,
      now: () => 10_000,
      async terminate(pid, options) {
        termination = { pid, options };
        alive = false;
      },
    });
    assert.equal(termination.pid, observed.pid);
    assert.deepEqual(termination.options, {
      expectedIdentity: observed,
      allowVerifiedWindowsHandleAcquisition: true,
    });
  } finally {
    await loaded.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("staged-update daemon shutdown fails closed for an unreadable live discovery", async () => {
  const loaded = await loadModule("source/electron-main/local-exec/local-exec-native.ts");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-local-exec-update-stop-"));
  const discoveryPath = path.join(temporary, "local-exec-daemon.json");
  let terminationCalls = 0;
  try {
    await writeFile(discoveryPath, JSON.stringify({
      pid: 5_312,
      startedAt: 9_950,
      entryRealpath: "C:\\app\\local-exec-daemon\\main.cjs",
      generationToken: "unreadable-live-generation",
      inflightCount: 0,
    }), "utf8");
    await assert.rejects(
      loaded.module.killLocalExecDaemon(discoveryPath, {
        expectedEntryRealpath: "C:\\app\\local-exec-daemon\\main.cjs",
        readIdentity() { return null; },
        isAlive() { return true; },
        async terminate() { terminationCalls += 1; },
      }),
      error => error instanceof loaded.module.LocalExecTerminationIdentityError
        && /remained live without a readable identity/.test(error.message),
    );
    assert.equal(terminationCalls, 0);
  } finally {
    await loaded.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("staged-update daemon shutdown treats an unreadable dead discovery as already absent", async () => {
  const loaded = await loadModule("source/electron-main/local-exec/local-exec-native.ts");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-local-exec-update-stop-"));
  const discoveryPath = path.join(temporary, "local-exec-daemon.json");
  let terminationCalls = 0;
  try {
    await writeFile(discoveryPath, JSON.stringify({
      pid: 5_313,
      startedAt: 9_950,
      entryRealpath: "C:\\app\\local-exec-daemon\\main.cjs",
      generationToken: "unreadable-dead-generation",
      inflightCount: 0,
    }), "utf8");
    await loaded.module.killLocalExecDaemon(discoveryPath, {
      expectedEntryRealpath: "C:\\app\\local-exec-daemon\\main.cjs",
      readIdentity() { return null; },
      isAlive() { return false; },
      async terminate() { terminationCalls += 1; },
    });
    assert.equal(terminationCalls, 0);
  } finally {
    await loaded.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("local-exec startup ownership is persisted before polling and cleared only after readiness", async () => {
  const source = await readFile(
    path.join(repoRoot, "source/electron-main/coordinator/coordinator-executors.ts"),
    "utf8",
  );
  const spawnStart = source.indexOf("async spawnLocalExecDaemon");
  const spawnEnd = source.indexOf("async confirmLocalExecDaemonReady", spawnStart);
  assert.ok(spawnStart >= 0 && spawnEnd > spawnStart);
  const spawnBody = source.slice(spawnStart, spawnEnd);
  assert.match(spawnBody, /spawnRequestedAt = now\(\)/);
  assert.match(spawnBody, /writeStartupQuarantine\(candidate\)/);
  assert.match(spawnBody, /for \(let attempt = 0; attempt < 40/);
  assert.ok(spawnBody.indexOf("writeStartupQuarantine(candidate)") < spawnBody.indexOf("for (let attempt = 0; attempt < 40"));
  assert.doesNotMatch(spawnBody, /releaseStartupQuarantine\(startupQuarantine\)/);
  assert.match(spawnBody, /"local-exec spawn verification and owned-child cleanup did not settle safely"/);
  assert.doesNotMatch(
    spawnBody.slice(spawnBody.indexOf("new AggregateError")),
    /LOCAL_EXEC_STARTUP_QUARANTINE_REASON/,
  );

  const reconcileStart = source.indexOf("const reconcileStartupQuarantine = async");
  const helperStart = source.indexOf("const stopUnidentifiedSpawn = async", reconcileStart);
  assert.ok(reconcileStart >= 0 && helperStart > reconcileStart);
  const reconcileBody = source.slice(reconcileStart, helperStart);
  assert.match(reconcileBody, /readStartupQuarantines\(\)/);
  assert.match(reconcileBody, /classification === "reused"/);
  assert.match(reconcileBody, /classification === "ambiguous"/);
  assert.match(reconcileBody, /readDaemonDiscovery\(\)/);
  assert.match(reconcileBody, /entry\.entryRealpath === canonicalEntryRealpath/);
  assert.match(reconcileBody, /discovery\.pid === entry\.pid/);
  assert.match(reconcileBody, /discovery\.entryRealpath === entry\.entryRealpath/);
  assert.match(reconcileBody, /discovery\.generationToken === entry\.generationToken/);
  assert.match(reconcileBody, /localExecDiscoveryTimeMatchesProcess/);
  assert.match(reconcileBody, /ownedDaemonIdentities\.set\(entry\.pid/);
  assert.match(reconcileBody, /releaseStartupQuarantine\(entry\)/);

  const helperEnd = source.indexOf("const inspectExpectedProcessIdentity", helperStart);
  assert.ok(helperEnd > helperStart);
  const helperBody = source.slice(helperStart, helperEnd);
  assert.match(helperBody, /let quarantine = persisted/);
  assert.match(helperBody, /writeStartupQuarantine\(candidate\)/);
  assert.match(helperBody, /allowUnidentifiedOwnedEscalation: true/);
  assert.match(helperBody, /isUnidentifiedProcessStillOwned: isStillOwned/);
  assert.match(helperBody, /expectedIdentity: observed/);
  assert.match(helperBody, /ownedChild: child/);
  assert.match(helperBody, /durable quarantine remains/);
  assert.match(helperBody, /classifyStartupQuarantineProcess\(durableQuarantine, observed\)/);
  assert.match(helperBody, /native\.isProcessAlive\(pid\)/);
  assert.match(helperBody, /releaseStartupQuarantine\(durableQuarantine\)/);
  assert.doesNotMatch(helperBody, /child\.kill\(/);

  const confirmStart = source.indexOf("async confirmLocalExecDaemonReady");
  const confirmEnd = source.indexOf("async terminateProcess", confirmStart);
  assert.ok(confirmStart >= 0 && confirmEnd > confirmStart);
  const confirmBody = source.slice(confirmStart, confirmEnd);
  assert.match(confirmBody, /readLocalExecDaemonDiscovery|readDaemonDiscovery/);
  assert.match(confirmBody, /localExecDiscoveryTimeMatchesProcess/);
  assert.match(confirmBody, /readStartupQuarantines\(\)/);
  assert.match(confirmBody, /quarantine\.pid === identity\.pid/);
  assert.match(confirmBody, /quarantine\.entryRealpath === identity\.entryRealpath/);
  assert.match(confirmBody, /quarantine\.generationToken === identity\.generationToken/);
  assert.match(confirmBody, /classifyStartupQuarantineProcess\(quarantine, identity\) === "match"/);
  assert.match(confirmBody, /releaseStartupQuarantine\(quarantine\)/);
  assert.match(source, /ownedDaemonChildren\.set\(identity\.pid, ownedChildRegistration\)/);
  assert.match(source, /sameLocalExecProcessIdentity\(registration\.identity, identity\)/);
  assert.match(source, /terminationMode: retainedOwnedChild\(identity\) !== undefined/);
  assert.match(source, /allowVerifiedWindowsHandleAcquisition: true as const/);
  assert.match(source, /"win32-stable-handle"/);
  assert.match(source, /reconcileLocalExecStartupQuarantine/);

  const nativeSource = await readFile(
    path.join(repoRoot, "source/electron-main/local-exec/local-exec-native.ts"),
    "utf8",
  );
  const terminateStart = nativeSource.indexOf("export async function terminateProcess");
  const terminateEnd = nativeSource.indexOf("export async function spawnLocalExecDaemon", terminateStart);
  const terminateBody = nativeSource.slice(terminateStart, terminateEnd);
  assert.match(terminateBody, /ownedChild\.kill\(signalName\)/);
  assert.match(terminateBody, /PID-only termination is forbidden/);
  assert.match(terminateBody, /requires explicit unidentified-owned opt-in/);
  assert.match(terminateBody, /allowVerifiedWindowsHandleAcquisition === true/);
  assert.doesNotMatch(terminateBody, /resolveWindowsTaskkillPath/);
  assert.doesNotMatch(terminateBody, /process\.kill/);
  assert.match(nativeSource, /terminateVerifiedWindowsProcessByHandle/);
  assert.match(nativeSource, /Number\.isSafeInteger\(pid\)/);
  assert.match(nativeSource, /Number\.isSafeInteger\(expected\.startEpochMs\)/);
  assert.match(nativeSource, /\[Console\]::In\.ReadToEnd\(\)/);
  assert.match(nativeSource, /FromBase64String\(\$payloadBase64\)/);
  assert.doesNotMatch(nativeSource, /expectedCommandBase64/);
  assert.match(nativeSource, /\$null = \$target\.Handle/);
  assert.match(nativeSource, /\$target\.StartTime/);
  assert.match(nativeSource, /\$heldCim = Get-CimInstance/);
  assert.match(nativeSource, /\$heldCimStart/);
  assert.match(nativeSource, /\$target\.Kill\(\)/);
  const killStart = nativeSource.indexOf("export async function killLocalExecDaemon");
  const killBody = nativeSource.slice(killStart);
  assert.match(killBody, /expectedPid/);
  assert.match(killBody, /requireAbsent/);
  assert.match(killBody, /post-termination identity was unreadable/);
  assert.match(killBody, /sameNativeProcessIdentity\(after, observed\)/);
  assert.match(killBody, /allowVerifiedWindowsHandleAcquisition: true as const/);

  const bindingSource = await readFile(
    path.join(repoRoot, "source/electron-main/production-binding-providers.ts"),
    "utf8",
  );
  assert.match(bindingSource, /killLocalExecDaemon\(getLocalExecDaemonDiscoveryPath\(\)\)/);
  assert.match(bindingSource, /expectedPid: pid/);
  assert.match(bindingSource, /expectedEntryRealpath: discovery\.entryRealpath/);
  assert.doesNotMatch(bindingSource, /terminate: ports\.terminate \?\? terminateProcess/);

  const legacySource = await readFile(
    path.join(repoRoot, "source/electron-main/startup/legacy-daemon-retirement.ts"),
    "utf8",
  );
  assert.match(legacySource, /options\.terminate\(pid, discovery\.value\)/);
});

test("coordinator supervisor wires structured startup, readiness, and handleless adoption", async () => {
  const mainSource = await readFile(path.join(repoRoot, "source/node-agent-coordinator/main.ts"), "utf8");
  const supervisorSource = await readFile(path.join(repoRoot, "source/node-agent-coordinator/local-exec/supervisor.ts"), "utf8");
  assert.match(mainSource, /reconcileLocalExecStartupQuarantine: \(args\) => command\(commands, "reconcileLocalExecStartupQuarantine", args\)/);
  assert.match(mainSource, /confirmLocalExecDaemonReady: \(args\) => command\(commands, "confirmLocalExecDaemonReady", args\)/);
  assert.match(mainSource, /inspectLocalExecProcessIdentity: \(args\) => command\(commands, "inspectLocalExecProcessIdentity", args\)/);
  assert.match(supervisorSource, /startupQuarantine\.blocked/);
  assert.match(supervisorSource, /inspected\.status === "different" \|\| inspected\.status === "absent"/);
  assert.match(supervisorSource, /confirmReadyIdentity\(spawned\)/);
  assert.match(supervisorSource, /confirmReadyIdentity\(identity\)/);
  assert.match(supervisorSource, /\(existing\.inflightCount \?\? 0\) > 0 \|\| terminationMode === "none"/);
  assert.match(supervisorSource, /activeGeneration\("adopted", existing, identity\)/);
  const establishStart = supervisorSource.indexOf("const establishDaemon = async");
  const healStart = supervisorSource.indexOf("const healDaemonInternal", establishStart);
  assert.ok(establishStart >= 0 && healStart > establishStart);
  const establishBody = supervisorSource.slice(establishStart, healStart);
  assert.ok(
    establishBody.indexOf("reconcileStartupQuarantine()")
      < establishBody.indexOf("readLocalExecDaemonDiscovery(paths.discoveryPath)"),
  );
  assert.doesNotMatch(supervisorSource, /state\.reason\.includes\(LOCAL_EXEC_STARTUP_QUARANTINE_REASON\)/);
});

test("local-exec process identity accepts a quoted Windows entrypoint without prefix collisions", async () => {
  const loaded = await loadModule("source/shared/local-exec-process-identity.ts");
  try {
    const entry = "C:\\Program Files\\Grok Bot\\local-exec-daemon\\main.cjs";
    const token = "generation-token";
    const command = `"C:\\Program Files\\Grok Bot\\Grok Bot.exe" "${entry}" --sand-local-exec-generation=${token}`;
    assert.equal(loaded.module.commandCarriesLocalExecGeneration(command, entry, token), true);
    assert.equal(loaded.module.commandCarriesLocalExecGeneration(command, `${entry}-other`, token), false);
    assert.equal(loaded.module.commandCarriesLocalExecGeneration(command, entry, `${token}-other`), false);
  } finally {
    await loaded.dispose();
  }
});

