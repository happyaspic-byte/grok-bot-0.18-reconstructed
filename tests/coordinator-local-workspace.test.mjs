import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

test("local Docker isolates its network and model shell before carrying a 9Router lease", async () => {
  const source = await readFile(path.join(repoRoot, "source/electron-main/box/local-docker-host-connector.ts"), "utf8");
  assert.match(source, /cursorenvironments\/universal@sha256:3f9e25e1e382b7c4b71e08eb549098a6106fadc615feba848e6cc5c1ef4be3b6/);
  assert.doesNotMatch(source, /cursorenvironments\/universal:sand-box-latest/);
  assert.match(source, /LOCAL_DOCKER_SCHEMA_VERSION = "11"/);
  assert.match(source, /LOCAL_DOCKER_NETWORK = "grok-bot-local-vm-net"/);
  assert.match(source, /com\.docker\.network\.bridge\.enable_icc=false/);
  assert.match(source, /foreignContainers\.length > 0/);
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
  assert.match(source, /provider === "codex" \|\| provider === "claude-code" \? provider : undefined/);
  assert.match(source, /provider === "codex"[\s\S]*\["\.codex", "\/root\/\.codex"\][\s\S]*\["\.claude", "\/root\/\.claude"\]/);
  assert.match(source, /inspected\.localAuthProvider !== localAuthProviderLabel/);
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
