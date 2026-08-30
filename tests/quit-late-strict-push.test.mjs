import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(import.meta.dirname, "..");

async function loadModules() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-quit-late-strict-push-"));
  const entries = {
    deadline: "source/electron-main/quit-deadline.ts",
    legs: "source/electron-main/coordinator/coordinator-main-legs.ts",
    resync: "source/electron-main/coordinator/coordinator-resync.ts",
    docker: "source/electron-main/box/local-docker-host-connector.ts",
  };
  await Promise.all(Object.entries(entries).map(async ([name, relative]) => {
    await build({
      entryPoints: [path.join(repoRoot, relative)],
      outfile: path.join(temporary, `${name}.mjs`),
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
    });
  }));
  const imported = await Promise.all(Object.keys(entries).map(async (name) => [
    name,
    await import(`${pathToFileURL(path.join(temporary, `${name}.mjs`)).href}?${Date.now()}`),
  ]));
  return {
    modules: Object.fromEntries(imported),
    dispose: () => rm(temporary, { recursive: true, force: true }),
  };
}

function resyncDependencies(legs) {
  return {
    legs,
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
  };
}

test("cutting coordinator legs prevents a timed-out queued strict push from posting late", async () => {
  const loaded = await loadModules();
  try {
    const requests = [];
    let noteFirstRequest;
    const firstRequest = new Promise((resolve) => { noteFirstRequest = resolve; });
    const listeners = { message: [], close: [] };
    const port = {
      postMessage(frame) {
        if (frame.kind !== "request") return;
        requests.push(frame);
        noteFirstRequest();
      },
      close() {
        for (const listener of listeners.close) listener();
      },
      on(event, listener) { listeners[event].push(listener); },
      start() {},
    };
    const coordinatorLegs = loaded.modules.legs.createCoordinatorMainLegs({
      onProblem(problem) { assert.fail(problem); },
    });
    coordinatorLegs.adoptPort(port);
    const chain = loaded.modules.resync.createCoordinatorResyncChain(
      resyncDependencies(coordinatorLegs.legs),
    );

    const blocker = chain.pushHostSettingsStrict({ blocker: true });
    await firstRequest;
    const lateClear = chain.pushHostSettingsStrict({ clearCliProxyCredentialLease: true });
    await assert.rejects(
      loaded.modules.deadline.withDesktopQuitDeadline("lease clear", lateClear, 10),
      (error) => error.name === "DesktopQuitDeadlineError",
    );

    coordinatorLegs.dispose();
    await assert.rejects(blocker, /main data port settled/);
    await assert.rejects(lateClear, /no live coordinator session/);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].args, { blocker: true });
  } finally {
    await loaded.dispose();
  }
});

test("the final serialized Docker stop wins over an ensure already started by a strict push", async () => {
  const loaded = await loadModules();
  try {
    const ensureSettingsPath = "C:/quit-late-strict-push/settings.json";
    const quitSettingsPath = "c:/QUIT-LATE-STRICT-PUSH/./settings.json";
    let hostRunning = false;
    let releaseEnsure;
    let noteEnsureStarted;
    const ensureGate = new Promise((resolve) => { releaseEnsure = resolve; });
    const ensureStarted = new Promise((resolve) => { noteEnsureStarted = resolve; });
    const order = [];

    const lateEnsure = loaded.modules.docker.serializeLocalDockerLifecycleMutation(
      ensureSettingsPath,
      async () => {
        order.push("ensure:start");
        noteEnsureStarted();
        await ensureGate;
        hostRunning = true;
        order.push("ensure:started-host");
      },
    );
    await ensureStarted;

    // This is the quit path's final host mutation, enqueued only after the RPC
    // legs and coordinator runtime have been disposed. It closes intake before
    // waiting for the previously admitted ensure.
    const finalStop = loaded.modules.docker.stopLocalDockerBoxForQuit(
      quitSettingsPath,
      async (args) => {
        if (args[0] === "inspect") {
          return {
            ok: true,
            output: JSON.stringify({
              State: { Running: hostRunning },
              Config: { Labels: { "com.grok-bot.local-vm": "1" } },
            }),
          };
        }
        assert.deepEqual(args, ["stop", loaded.modules.docker.LOCAL_DOCKER_BOX_CONTAINER]);
        hostRunning = false;
        order.push("stop");
        return { ok: true, output: "" };
      },
    );
    await assert.rejects(
      () => loaded.modules.docker.serializeLocalDockerLifecycleMutation(
        ensureSettingsPath,
        async () => { order.push("ensure:too-late"); },
      ),
      (error) => error.name === "LocalDockerLifecycleClosedError",
    );
    await assert.rejects(
      () => loaded.modules.docker.serializeLocalDockerLifecycleMutation(
        quitSettingsPath,
        async () => { order.push("ensure:too-late-alias"); },
      ),
      (error) => error.name === "LocalDockerLifecycleClosedError",
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(order, ["ensure:start"], "the stop must wait behind the in-flight ensure");

    releaseEnsure();
    const ensured = await lateEnsure;
    assert.equal(ensured.isSuperseded(), true, "queuing the final stop must supersede the late ensure");
    await finalStop;
    assert.deepEqual(order, ["ensure:start", "ensure:started-host", "stop"]);
    assert.equal(hostRunning, false);
  } finally {
    await loaded.dispose();
  }
});

test("a timed-out mutating Docker CLI cannot release the lifecycle lane before close", async () => {
  const loaded = await loadModules();
  try {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = undefined;
    const kills = [];
    let noteForced;
    const forced = new Promise((resolve) => { noteForced = resolve; });
    child.kill = (signal) => {
      kills.push(signal);
      if (signal === "SIGKILL") noteForced();
      return true;
    };

    let hostRunning = false;
    let mutationSettled = false;
    const mutation = loaded.modules.docker.serializeLocalDockerLifecycleMutation(
      "C:/late-docker-command/settings.json",
      async () => {
        const result = await loaded.modules.docker.runDockerCommand(
          ["start", loaded.modules.docker.LOCAL_DOCKER_BOX_CONTAINER],
          undefined,
          {
            timeoutMs: 5,
            terminationGraceMs: 5,
            spawn: () => child,
          },
        );
        hostRunning = true;
        return result;
      },
    ).then((result) => {
      mutationSettled = true;
      return result;
    });

    await forced;
    child.emit("error", new Error("kill acknowledgement was lost"));
    let finalStopSettled = false;
    const finalStop = loaded.modules.docker.stopLocalDockerBoxForQuit(
      "c:/LATE-DOCKER-COMMAND/./settings.json",
      async (args) => {
        if (args[0] === "inspect") {
          return {
            ok: true,
            output: JSON.stringify({
              State: { Running: hostRunning },
              Config: { Labels: { "com.grok-bot.local-vm": "1" } },
            }),
          };
        }
        assert.deepEqual(args, ["stop", loaded.modules.docker.LOCAL_DOCKER_BOX_CONTAINER]);
        hostRunning = false;
        return { ok: true, output: "" };
      },
    ).then(() => { finalStopSettled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(mutationSettled, false, "a forced mutating CLI still needs a confirmed close");
    assert.equal(finalStopSettled, false, "the final stop must remain behind that CLI");
    assert.deepEqual(kills, ["SIGTERM", "SIGKILL"]);

    child.emit("close", null);
    const result = await mutation;
    assert.equal(result.value.ok, false);
    assert.match(result.value.output, /timed out after 5 ms/);
    assert.equal(result.isSuperseded(), true);
    await finalStop;
    assert.equal(hostRunning, false, "the serialized quit stop must be the last host mutation");
  } finally {
    await loaded.dispose();
  }
});

test("partial-startup quit stops Docker before bounded graph disposal even when reporting fails", async () => {
  const loaded = await loadModules();
  try {
    const order = [];
    await loaded.modules.deadline.settlePartialDesktopQuit({
      async stopLocalDocker() {
        order.push("stop");
        throw new Error("stop failed");
      },
      async disposeGraph() {
        order.push("dispose");
      },
      reportFailure(area, leg, error) {
        order.push(`report:${area}:${leg}:${error.message}`);
        throw new Error("reporter failed");
      },
      disposeTimeoutMs: 20,
    });
    assert.deepEqual(order, [
      "stop",
      "report:coordinator:cli-proxy-quit-revoke:stop failed",
      "dispose",
    ]);
  } finally {
    await loaded.dispose();
  }
});

test("partial-startup quit bounds a stuck graph disposal after closing Docker intake", async () => {
  const loaded = await loadModules();
  try {
    const order = [];
    await loaded.modules.deadline.settlePartialDesktopQuit({
      async stopLocalDocker() { order.push("stop"); },
      async disposeGraph() {
        order.push("dispose");
        return await new Promise(() => undefined);
      },
      reportFailure(area, leg, error) {
        order.push(`report:${area}:${leg}`);
        assert.equal(error.name, "DesktopQuitDeadlineError");
      },
      disposeTimeoutMs: 5,
    });
    assert.deepEqual(order, ["stop", "dispose", "report:main:dispose-deadline"]);
  } finally {
    await loaded.dispose();
  }
});

test("main quit wiring fail-closes the singleton Docker lifecycle during partial startup", async () => {
  const source = await readFile(
    path.join(repoRoot, "source/electron-main/main-production-services.ts"),
    "utf8",
  );
  assert.match(
    source,
    /if \(context == null \|\| telemetry == null\) \{[\s\S]*?const partialSettings = settings;[\s\S]*?stopLocalDockerBoxForQuit\(partialSettings\.settingsStore\.settingsPath\)[\s\S]*?return "prevent";/u,
  );
});
