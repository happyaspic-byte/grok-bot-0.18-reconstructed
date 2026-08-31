import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(import.meta.dirname, "..");
const ROOT_AGENT_ID = "root-production-agent";

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-host-production-subagents-"));
  const output = path.join(temporary, "host-production-subagents.mjs");
  try {
    await symlink(
      path.join(repoRoot, "node_modules"),
      path.join(temporary, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await build({
      stdin: {
        contents: `
          export {
            createHostRunnerComposition,
            PRODUCTION_RUNNER_SHUTDOWN_DRAIN_TIMEOUT_MS,
          } from "./source/host/host-runner-composition.ts";
          export {
            installShutdownHandlers,
            SHUTDOWN_WATCHDOG_MS,
          } from "./source/host/main.ts";
          export {
            BOX_EXEC_DAEMON_STOP_TIMEOUT_MS,
          } from "./source/host/box/exec-daemon-process.ts";
          export { SandHost } from "./source/host/sand-host.ts";
          export { createTurnSettle } from "./source/host/runner/turn-settle.ts";
          export { SandAgentRunner } from "./source/host/runner/sand-agent-runner.ts";
          export { SandAutoReviewController } from "./source/host/runner/sand-auto-review.ts";
          export { createContext } from "./source/packages/context/core.ts";
          export { loggerKey } from "./source/packages/context/logger.ts";
          export { createMockPromptExecutor } from "./source/packages/chat-inference/mock-prompt-executor.ts";
          export { InMemoryBlobStore } from "./source/packages/agent-kv/blob-store.ts";
          export {
            ConversationStateStructure,
          } from "./source/packages/proto/generated/agent/v1/agent_pb.ts";
          export {
            SubagentArgs,
          } from "./source/packages/proto/generated/agent/v1/subagent_exec_pb.ts";
          export {
            BackgroundShellSpawnResult,
            BackgroundShellSpawnSuccess,
            WriteShellStdinResult,
            WriteShellStdinSuccess,
          } from "./source/packages/proto/generated/agent/v1/background_shell_exec_pb.ts";
          export {
            ShellResult,
            ShellSuccess,
          } from "./source/packages/proto/generated/agent/v1/shell_exec_pb.ts";
          export {
            ComputerUseResult,
            ComputerUseSuccess,
          } from "./source/packages/proto/generated/agent/v1/computer_use_tool_pb.ts";
          export { subagentExecutorResource } from "./source/packages/agent-exec/subagent.ts";
          export {
            backgroundShellExecutorResource,
            writeBackgroundShellInputExecutorResource,
          } from "./source/packages/agent-exec/background-shell.ts";
          export { computerUseExecutorResource } from "./source/packages/agent-exec/computer-use.ts";
          export { readExecutorResource } from "./source/packages/agent-exec/read.ts";
          export { shellExecutorResource } from "./source/packages/agent-exec/shell.ts";
          export { shellStreamExecutorResource } from "./source/packages/agent-exec/shell-stream.ts";
          export {
            SAND_BROWSER_ENCRYPTED_RESULT_MARKER,
            SAND_BROWSER_STDIN_READY_MARKER,
          } from "./source/host/runner/tools/sand-browser-driver-source.ts";
        `,
        resolveDir: repoRoot,
        sourcefile: "host-production-subagents-test-entry.ts",
        loader: "ts",
      },
      outfile: output,
      bundle: true,
      packages: "external",
      format: "esm",
      logLevel: "silent",
      platform: "node",
      target: "node22",
    });
    return {
      module: await import(`${pathToFileURL(output).href}?${Date.now()}`),
      dispose: () => rm(temporary, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

function subagentConfigNames(configs) {
  return configs.map((config) => config.subagent_type?.type?.value?.name);
}

function toolNames(tools) {
  return (tools ?? []).map((tool) => tool.name).filter((name) => typeof name === "string");
}

function createDeferred() {
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function waitFor(promise, label, timeoutMs = 5_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function makeEncryptedBrowserResult(loaded, stdin, response) {
  const envelope = JSON.parse(Buffer.from(stdin.trim(), "base64").toString("utf8"));
  const responseKey = Buffer.from(envelope.responseKey, "hex");
  assert.equal(responseKey.length, 32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", responseKey, iv);
  cipher.setAAD(Buffer.from("sand-browser-result-v1", "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(response), "utf8"),
    cipher.final(),
  ]);
  const packet = Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ciphertext]);
  return {
    request: envelope.request,
    output: [
      loaded.SAND_BROWSER_STDIN_READY_MARKER,
      `${loaded.SAND_BROWSER_ENCRYPTED_RESULT_MARKER}${packet.toString("base64")}`,
      "---",
      "exit_code: 0",
      "---",
      "",
    ].join("\n"),
  };
}

function createHarness(loaded, options = {}) {
  const heldComputerChild = options.holdComputerChild === true
      ? {
        started: createDeferred(),
        unwind: createDeferred(),
      }
    : undefined;
  const heldChildDispose = options.holdChildDispose === true
    ? createDeferred()
    : undefined;
  const heldBoxRelease = options.holdBoxRelease === true
    ? createDeferred()
    : undefined;
  const heldMirrorClose = options.holdMirrorClose === true
    ? createDeferred()
    : undefined;
  const heldRemoteAvailability = options.holdRemoteAvailability === true
    ? { started: createDeferred(), release: createDeferred() }
    : undefined;
  const heldPrivacy = options.holdPrivacy === true
    ? {
        started: createDeferred(),
        allStarted: createDeferred(),
        release: createDeferred(),
        calls: 0,
        expectedStarts: options.privacyStartCount ?? 1,
      }
    : undefined;
  const heldRootStream = options.holdRootStream === true
    ? { started: createDeferred(), release: createDeferred() }
    : undefined;
  const heldMirrorPrepare = options.holdMirrorPrepare === true
    ? {
        started: createDeferred(),
        release: createDeferred(),
        calls: 0,
        holdAt: options.mirrorPrepareHoldAt ?? 1,
      }
    : undefined;
  const heldCheckpointStore = options.holdCheckpointStore === true
    ? { started: createDeferred(), release: createDeferred() }
    : undefined;
  const records = {
    builtRunnerOptions: [],
    builtRunners: [],
    childRunIds: [],
    disposedRunnerIds: [],
    interruptedRunnerIds: [],
    inferenceSessions: [],
    toolStreams: [],
    transportUpdates: [],
    runLifecycleEvents: [],
    actionAuditRecords: [],
    analyticsEvents: [],
    transcriptMirrorCalls: [],
    localEnsureReadyIds: [],
    remoteEnsureReadyIds: [],
    foreverBoxReleaseAgentIds: [],
    remoteWindowAgentIds: [],
    remoteUploadIds: [],
    remoteDownloadIds: [],
    localResourceExecutions: [],
    remoteResourceExecutions: [],
    browserRequestViewIds: [],
    checkpointWrites: [],
    persistenceEvents: [],
    profileSnapshotWrites: [],
    productionOwners: [],
  };
  const browserTerminal = {
    output: loaded.SAND_BROWSER_STDIN_READY_MARKER,
  };

  const shellResult = (command = "") => new loaded.ShellResult({
    result: {
      case: "success",
      value: new loaded.ShellSuccess({
        command,
        workingDirectory: "/workspace",
        exitCode: 0,
        stdout: "",
        stderr: "",
      }),
    },
  });

  function executorAccessor(surface) {
    const executions = surface === "local"
      ? records.localResourceExecutions
      : records.remoteResourceExecutions;
    return {
      get(resource) {
        if (resource === loaded.shellStreamExecutorResource) {
          return {
            execute(_context, args) {
              executions.push({ resource: "shellStream", command: args.command });
              return (async function* () {})();
            },
          };
        }
        if (resource === loaded.backgroundShellExecutorResource) {
          return {
            async execute(_context, args) {
              executions.push({ resource: "backgroundShell", command: args.command });
              return new loaded.BackgroundShellSpawnResult({
                result: {
                  case: "success",
                  value: new loaded.BackgroundShellSpawnSuccess({
                    shellId: 41,
                    command: args.command,
                    workingDirectory: args.workingDirectory,
                  }),
                },
              });
            },
          };
        }
        if (resource === loaded.writeBackgroundShellInputExecutorResource) {
          return {
            async execute(_context, args) {
              executions.push({ resource: "writeBackgroundShellInput" });
              assert.equal(args.chars.endsWith("\x04"), true, "Browser stdin must close after its one request");
              const encrypted = makeEncryptedBrowserResult(loaded, args.chars.slice(0, -1), {
                ok: true,
                summary: "browser child tool executed",
                screenshot: true,
              });
              records.browserRequestViewIds.push(encrypted.request.viewId);
              browserTerminal.output = encrypted.output;
              return new loaded.WriteShellStdinResult({
                result: {
                  case: "success",
                  value: new loaded.WriteShellStdinSuccess({ shellId: args.shellId }),
                },
              });
            },
          };
        }
        if (resource === loaded.shellExecutorResource) {
          return {
            async execute(_context, args) {
              executions.push({ resource: "shell", command: args.command });
              return shellResult(args.command);
            },
          };
        }
        if (resource === loaded.computerUseExecutorResource) {
          return {
            async execute(_context, args) {
              executions.push({ resource: "computerUse", actions: args.actions.length });
              return new loaded.ComputerUseResult({
                result: {
                  case: "success",
                  value: new loaded.ComputerUseSuccess({}),
                },
              });
            },
          };
        }
        if (resource === loaded.readExecutorResource) {
          return { execute: async () => ({ result: { case: "error", value: { error: "unused" } } }) };
        }
        throw new Error(`${surface} test accessor received an unexpected resource`);
      },
    };
  }

  const localAccessor = executorAccessor("local");
  const remoteAccessor = executorAccessor("remote");
  const localBox = {
    async ensureReady(_context, agentId) {
      records.localEnsureReadyIds.push(agentId);
      return { terminalsFolder: "/tmp/local-terminals", remoteAccessor: localAccessor };
    },
    async uploadFile() {},
    async downloadFile() { return new Uint8Array(); },
  };
  const remoteBox = {
    async ensureReady(_context, agentId) {
      records.remoteEnsureReadyIds.push(agentId);
      return { terminalsFolder: "/tmp/remote-terminals", remoteAccessor };
    },
    getAgentWindowIndex(agentId) {
      records.remoteWindowAgentIds.push(agentId);
      return 7;
    },
    async uploadFile(_context, agentId, _boxPath, _bytes) {
      records.remoteUploadIds.push(agentId);
    },
    async downloadFile(_context, agentId, boxPath) {
      records.remoteDownloadIds.push(agentId);
      if (boxPath.endsWith("/41.txt")) {
        return Buffer.from(browserTerminal.output, "utf8");
      }
      if (boxPath.endsWith(".png")) return Buffer.from("browser-screenshot", "utf8");
      return new Uint8Array();
    },
    getTerminalsFolder: () => "/tmp/remote-terminals",
    async isAvailable() {
      if (heldRemoteAvailability !== undefined) {
        heldRemoteAvailability.started.resolve();
        await heldRemoteAvailability.release.promise;
      }
      return options.remoteAvailable !== false;
    },
    isPreparing: () => false,
  };

  const autoReviewModes = {
    hostShell: "off",
    boxShell: "off",
    mcp: "off",
    computer: "off",
    automationWrite: "off",
    cloudAgent: "off",
    subagentLaunch: "off",
  };
  const autoReviewController = new loaded.SandAutoReviewController({
    agentId: ROOT_AGENT_ID,
    hostGeneration: "test-host-generation",
  });

  const inferencePort = {
    resolvePrivacyMode: async () => {
      if (heldPrivacy !== undefined) {
        heldPrivacy.calls += 1;
        heldPrivacy.started.resolve();
        if (heldPrivacy.calls >= heldPrivacy.expectedStarts) {
          heldPrivacy.allStarted.resolve();
        }
        await heldPrivacy.release.promise;
      }
      return 2;
    },
    createSession(onRequestId, sessionOptions = {}) {
      const capturedOptions = { ...sessionOptions };
      onRequestId(`inference-${records.inferenceSessions.length + 1}`);
      records.inferenceSessions.push(capturedOptions);
      let invocation = 0;
      const executor = loaded.createMockPromptExecutor(() => {
        invocation += 1;
        if (capturedOptions.isComputerUseSubagent === true && invocation === 1) {
          return {
            response: "",
            toolCalls: [{
              toolCallId: "computer-child-tool",
              toolName: "Computer",
              args: { action: "screenshot" },
            }],
          };
        }
        if (capturedOptions.isBrowserUseSubagent === true && invocation === 1) {
          return {
            response: "",
            toolCalls: [{
              toolCallId: "browser-child-tool",
              toolName: "browser_snapshot",
              args: {},
            }],
          };
        }
        return { response: "child-ok", chunkSize: 8 };
      });
      const originalStream = executor.stream.bind(executor);
      executor.stream = (context, invocationId, tools, streamOptions) => {
        records.toolStreams.push({
          sessionOptions: capturedOptions,
          names: toolNames(tools),
        });
        const result = originalStream(context, invocationId, tools, streamOptions);
        if (
          heldRootStream !== undefined
          && capturedOptions.isComputerUseSubagent === false
          && capturedOptions.isBrowserUseSubagent === false
        ) {
          const fullStream = result.fullStream;
          return {
            ...result,
            fullStream: (async function* () {
              heldRootStream.started.resolve();
              await heldRootStream.release.promise;
              yield* fullStream;
            })(),
          };
        }
        return result;
      };
      return {
        getModelId: () => "test-model",
        getExecutor: () => executor,
      };
    },
  };
  inferencePort.createSummarizationSession = (onRequestId, sessionOptions = {}) => {
    const capturedOptions = { ...sessionOptions, summaryOwner: true };
    onRequestId(`summary-${records.inferenceSessions.length + 1}`);
    records.inferenceSessions.push(capturedOptions);
    return {
      getModelId: () => "test-summary-model",
      getExecutor: () => loaded.createMockPromptExecutor(() => ({ response: "summary" })),
    };
  };

  const extensionApis = new Map(Object.entries({
    auth: {},
    "local-tool-permission": {},
    attachments: {},
    memory: {},
    transcript: {
      listAgentsSync: () => [],
      listAgents: async () => [],
    },
    experiments: {
      isBrowserUseSubagentEnabled: () => options.experimentEnabled === true,
      isMultitaskEnabled: () => false,
      isSendMessageDeliveryOwedEnabled: () => false,
      isDynamicToolsEnabled: () => false,
      isSpotlightEnabled: () => false,
      isMcpMultiAccountEnabled: () => false,
      isUnicodeTypingEnabled: () => false,
      isCloudAgentsDisabledByTeam: () => true,
      checkFeatureGate: () => false,
      checkGate: () => false,
    },
    telemetry: {
      analytics: {
        trackEvent(name, properties) {
          records.analyticsEvents.push({ name, properties });
          if (options.throwTelemetry === true) {
            throw new Error("test telemetry failure");
          }
        },
      },
    },
    mcp: {
      mcp: {
        getCustomInstructions: async () => new Map(),
        getTools: async () => [],
        refreshAccountConfig() {},
      },
      management: {},
    },
    session: {
      transcriptsDir: () => "/tmp/test-transcripts",
      store: { ensureConversationCapacityForTurn() {} },
      startHandoff: async () => ({ kind: "started", requestId: "test-handoff" }),
    },
    settings: {
      getUserTimeZone: () => "UTC",
      isLocalWorkspaceBrowserUseEnabled: () => options.localCapability === true,
    },
    "cloud-agents": {},
    "forever-box": {
      box: remoteBox,
      async releaseAgent(agentId) {
        records.foreverBoxReleaseAgentIds.push(agentId);
        await heldBoxRelease?.promise;
      },
    },
    "action-audit": {
      record(record) {
        records.actionAuditRecords.push(record);
      },
    },
    "auto-review": {
      bindRunner: () => ({
        autoReviewController,
        autoReviewModes,
        getAutoReviewModes: () => autoReviewModes,
      }),
    },
    automations: {},
    inference: { port: inferencePort },
    "local-exec": {
      box: localBox,
      userComputers: { resolve: () => undefined, list: () => [] },
    },
    "managed-setup": {},
  }));

  const blobStore = new loaded.InMemoryBlobStore();
  let rootState = new loaded.ConversationStateStructure();
  let profilePromptSnapshot = options.profilePromptSnapshot;
  const agentStore = {
    getBlobStore: () => blobStore,
    getConversationStateStructure: () => rootState.clone(),
    async handleCheckpoint(_context, checkpoint) {
      records.persistenceEvents.push("store:start");
      if (heldCheckpointStore !== undefined) {
        heldCheckpointStore.started.resolve();
        await heldCheckpointStore.release.promise;
      }
      records.checkpointWrites.push(checkpoint.clone());
      rootState = checkpoint.clone();
      records.persistenceEvents.push("store:durable");
    },
    getMetadata: () => "",
  };
  const session = {
    id: ROOT_AGENT_ID,
    dbPath: "/tmp/test-agents/root-production-agent/agent.db",
    agentStore,
    db: {
      getAgentProfilePromptSnapshot: () => profilePromptSnapshot,
      setAgentProfilePromptSnapshot(snapshot) {
        profilePromptSnapshot = snapshot;
        records.profileSnapshotWrites.push(snapshot);
      },
    },
  };
  const context = loaded.createContext().with(loaded.loggerKey, { log() {} });
  const composition = loaded.createHostRunnerComposition({
    extensions: { api: (id) => extensionApis.get(id) ?? {} },
    ctx: context,
    emitGatewayEvent() {},
    buildRunner(runnerOptions) {
      const productionShell = runnerOptions.productionTurnRunShell;
      if (productionShell?.createOwner !== undefined) {
        const createOwner = productionShell.createOwner;
        runnerOptions.productionTurnRunShell = {
          ...productionShell,
          async createOwner(input) {
            const owner = await createOwner(input);
            records.productionOwners.push(owner);
            return owner;
          },
        };
      }
      records.builtRunnerOptions.push(runnerOptions);
      const runner = new loaded.SandAgentRunner(runnerOptions);
      if (runnerOptions.subagentType !== undefined) {
        const run = runner.run.bind(runner);
        runner.run = async (...args) => {
          records.childRunIds.push(
            runnerOptions.getAgentId?.() ?? runnerOptions.conversationId,
          );
          const result = await run(...args);
          if (
            heldComputerChild !== undefined
            && runnerOptions.subagentType === "computerUse"
          ) {
            heldComputerChild.started.resolve();
            await heldComputerChild.unwind.promise;
          }
          return result;
        };
      }
      const interrupt = runner.interrupt.bind(runner);
      runner.interrupt = (...args) => {
        records.interruptedRunnerIds.push(
          runnerOptions.getAgentId?.() ?? runnerOptions.conversationId,
        );
        return interrupt(...args);
      };
      const dispose = runner.dispose.bind(runner);
      runner.dispose = async () => {
        const agentId = runnerOptions.getAgentId?.() ?? runnerOptions.conversationId;
        records.disposedRunnerIds.push(agentId);
        dispose();
        if (
          heldChildDispose !== undefined
          && runnerOptions.subagentType === "computerUse"
        ) {
          await heldChildDispose.promise;
        }
      };
      records.builtRunners.push(runner);
      return runner;
    },
    createRequestContext: () => ({
      resolve: () => ({
        osVersion: "Linux test",
        shell: "bash",
        timeZone: "UTC",
        transcriptsFolder: "/tmp/test-transcripts",
      }),
      resolveRules: async () => [],
    }),
    createTranscriptMirror: (mirrorOptions) => {
      if (heldMirrorClose !== undefined) mirrorOptions.pool();
      return {
        async prepareCheckpoint(_context, transcriptId) {
          records.transcriptMirrorCalls.push({ operation: "prepare", transcriptId });
          records.persistenceEvents.push("prepare");
          assert.equal(transcriptId, ROOT_AGENT_ID, "a child used the root transcript mirror");
          if (heldMirrorPrepare !== undefined) {
            heldMirrorPrepare.calls += 1;
            if (heldMirrorPrepare.calls === heldMirrorPrepare.holdAt) {
              heldMirrorPrepare.started.resolve();
              await heldMirrorPrepare.release.promise;
            }
          }
        },
        async abortCheckpoint(_context, transcriptId) {
          records.transcriptMirrorCalls.push({ operation: "abort", transcriptId });
          records.persistenceEvents.push("abort");
          assert.equal(transcriptId, ROOT_AGENT_ID, "a child used the root transcript mirror");
        },
        async commitCheckpoint(_context, transcriptId) {
          records.transcriptMirrorCalls.push({ operation: "commit", transcriptId });
          records.persistenceEvents.push("commit");
          assert.equal(transcriptId, ROOT_AGENT_ID, "a child used the root transcript mirror");
        },
        async skipCheckpoint(_context, transcriptId) {
          records.transcriptMirrorCalls.push({ operation: "skip", transcriptId });
          assert.equal(transcriptId, ROOT_AGENT_ID, "a child used the root transcript mirror");
        },
      };
    },
    ...(heldMirrorClose === undefined
      ? {}
      : {
          mirrorPoolFactory: () => ({
            closeAll: () => heldMirrorClose.promise,
          }),
        }),
    ...(options.shutdownDrainTimeoutMs === undefined
      ? {}
      : { productionRunnerShutdownDrainTimeoutMs: options.shutdownDrainTimeoutMs }),
  });
  const runner = composition.createRunner(session, {
    transport: {
      onUpdate(update) {
        records.transportUpdates.push(update);
      },
    },
    onRunLifecycle(event) {
      records.runLifecycleEvents.push(event);
    },
    ...(options.agentProfile === undefined
      ? {}
      : { agentProfileProvider: () => options.agentProfile }),
  });

  async function createRootOwner() {
    const productionShell = records.builtRunnerOptions[0]?.productionTurnRunShell;
    assert.equal(typeof productionShell?.createOwner, "function");
    return await productionShell.createOwner({
      requestId: "root-owner-request",
      runOptions: { isSilenceAllowed: true },
      context,
      cancelThisRun() {},
      emitUpdate() {},
    });
  }

  return {
    composition,
    context,
    createRootOwner,
    heldBoxRelease,
    heldComputerChild,
    heldChildDispose,
    heldCheckpointStore,
    heldMirrorClose,
    heldMirrorPrepare,
    heldPrivacy,
    heldRemoteAvailability,
    heldRootStream,
    records,
    runner,
  };
}

test("live production composition gates built-in desktop Task configs", async (t) => {
  const loaded = await loadModule();
  t.after(loaded.dispose);
  const matrix = [
    {
      name: "no gate and no local capability",
      options: {},
      expected: ["computerUse"],
    },
    {
      name: "feature gate",
      options: { experimentEnabled: true },
      expected: ["computerUse", "browserUse"],
    },
    {
      name: "local-workspace capability",
      options: { localCapability: true },
      expected: ["computerUse", "browserUse"],
    },
    {
      name: "remote desktop explicitly unavailable",
      options: { experimentEnabled: true, localCapability: true, remoteAvailable: false },
      expected: [],
    },
  ];

  for (const entry of matrix) {
    await t.test(entry.name, async () => {
      const harness = createHarness(loaded.module, entry.options);
      const owner = await harness.createRootOwner();
      try {
        assert.deepEqual(
          subagentConfigNames(owner.buildInput.turn.subagentConfigs ?? []),
          entry.expected,
        );
      } finally {
        owner.dispose();
        await harness.composition.dispose();
      }
    });
  }
});

test("live production Task runs computerUse and browserUse children to completion", async (t) => {
  const loaded = await loadModule();
  t.after(loaded.dispose);
  const harness = createHarness(loaded.module, { localCapability: true });
  t.after(() => harness.composition.dispose());

  const rootResult = await harness.runner.run("Inspect the live root tool projection", {
    inferenceRequestId: "root-tool-projection",
    isSilenceAllowed: true,
  });
  assert.equal(rootResult?.text, "child-ok");
  const rootTools = harness.records.toolStreams.find((entry) =>
    entry.sessionOptions.isComputerUseSubagent === false
      && entry.sessionOptions.isBrowserUseSubagent === false)?.names ?? [];
  for (const requiredName of [
    "Task",
    "ExternalShell",
    "ExternalRead",
    "Shell",
    "Read",
    "CopyToBox",
    "CopyFromBox",
    "Screenshot",
    "request_box_help",
  ]) {
    assert.ok(rootTools.includes(requiredName), `root did not offer ${requiredName}`);
  }
  assert.ok(harness.records.transcriptMirrorCalls.length > 0);
  assert.ok(harness.records.transcriptMirrorCalls.every(
    (entry) => entry.transcriptId === ROOT_AGENT_ID));
  const rootTranscriptMirrorCallCount = harness.records.transcriptMirrorCalls.length;
  assert.ok(harness.records.runLifecycleEvents.length > 0);
  assert.ok(harness.records.transportUpdates.length > 0);
  harness.records.runLifecycleEvents.length = 0;
  harness.records.transportUpdates.length = 0;

  const owner = await harness.createRootOwner();
  t.after(() => owner.dispose());

  assert.deepEqual(
    subagentConfigNames(owner.buildInput.turn.subagentConfigs ?? []),
    ["computerUse", "browserUse"],
  );
  const executor = owner.buildInput.resourceAccessor.get(
    loaded.module.subagentExecutorResource,
  );
  assert.equal(typeof executor?.execute, "function");
  // Root owner creation legitimately reports its own inference request IDs.
  // From this point onward only children run, and their callbacks must stay
  // isolated from the parent transport/lifecycle.
  harness.records.runLifecycleEvents.length = 0;
  harness.records.transportUpdates.length = 0;

  const completions = [];
  harness.runner.setBackgroundSubagentHandler((completion) => {
    completions.push(completion);
  });

  async function dispatch(subagentType, toolCallId) {
    const result = await executor.execute(
      harness.context,
      new loaded.module.SubagentArgs({
        parentConversationId: ROOT_AGENT_ID,
        prompt: `Run the ${subagentType} behavioral probe`,
        subagentType,
        toolCallId,
      }),
      { execId: toolCallId },
    );
    assert.equal(result.result.case, "success");
    const childId = result.result.value.agentId;
    assert.match(childId, /^subagent-/);
    await harness.runner.subagents.drainBackgroundSubagents();
    const completion = completions.find((entry) => entry.subagentAgentId === childId);
    assert.equal(
      completion?.status,
      "completed",
      `background child failed: ${JSON.stringify(completion)}`,
    );
    assert.equal(completion?.result, "child-ok");
    assert.equal(
      harness.runner.subagents.listSubagents().find((entry) => entry.subagentId === childId)?.status,
      "done",
    );
    return childId;
  }

  const computerChildId = await dispatch("computerUse", "task-computer-child");
  const browserChildId = await dispatch("browserUse", "task-browser-child");

  assert.equal(harness.records.builtRunnerOptions.length, 3);
  const childOptions = harness.records.builtRunnerOptions.slice(1);
  assert.deepEqual(childOptions.map((entry) => entry.getAgentId()), [
    computerChildId,
    browserChildId,
  ]);
  assert.deepEqual(childOptions.map((entry) => entry.getBoxId()), [
    ROOT_AGENT_ID,
    ROOT_AGENT_ID,
  ]);
  assert.deepEqual(childOptions.map((entry) => entry.conversationId), [
    computerChildId,
    browserChildId,
  ]);
  assert.ok(childOptions.every((entry) => entry.productionTurnRunShell != null));

  const agentInferenceSessions = harness.records.inferenceSessions.filter(
    (entry) => entry.summaryOwner !== true,
  );
  assert.ok(agentInferenceSessions.some((entry) =>
    entry.isComputerUseSubagent === true && entry.isBrowserUseSubagent === false));
  assert.ok(agentInferenceSessions.some((entry) =>
    entry.isComputerUseSubagent === false && entry.isBrowserUseSubagent === true));

  const computerTools = harness.records.toolStreams.find(
    (entry) => entry.sessionOptions.isComputerUseSubagent === true,
  )?.names ?? [];
  assert.deepEqual(new Set(computerTools), new Set(["Shell", "Read", "Computer"]));
  assert.equal(computerTools.length, 3);
  const browserTools = harness.records.toolStreams.find(
    (entry) => entry.sessionOptions.isBrowserUseSubagent === true,
  )?.names ?? [];
  const browserToolNames = [
    "browser_navigate",
    "browser_snapshot",
    "browser_click",
    "browser_mouse_click_xy",
    "browser_type",
    "browser_fill",
    "browser_select_option",
    "browser_press_key",
    "browser_scroll",
    "browser_drag",
    "browser_get_bounding_box",
    "browser_highlight",
    "browser_cdp",
    "browser_tabs",
    "browser_take_screenshot",
  ];
  assert.deepEqual(
    new Set(browserTools),
    new Set(["Shell", "Read", ...browserToolNames]),
  );
  assert.equal(browserTools.length, 17);
  assert.equal(browserTools.filter((name) => name.startsWith("browser_")).length, 15);

  assert.ok(harness.records.remoteResourceExecutions.some(
    (entry) => entry.resource === "computerUse"));
  assert.ok(harness.records.remoteResourceExecutions.some(
    (entry) => entry.resource === "backgroundShell"));
  assert.equal(harness.records.localResourceExecutions.some(
    (entry) => entry.resource === "computerUse"), false);
  assert.equal(harness.records.localResourceExecutions.some(
    (entry) => entry.resource === "backgroundShell"), false);

  assert.deepEqual(
    new Set(harness.records.remoteEnsureReadyIds),
    new Set([computerChildId, browserChildId]),
  );
  assert.deepEqual(
    new Set(harness.records.remoteWindowAgentIds),
    new Set([computerChildId, browserChildId]),
  );
  assert.equal(harness.records.localEnsureReadyIds.includes(computerChildId), false);
  assert.equal(harness.records.localEnsureReadyIds.includes(browserChildId), false);
  assert.deepEqual(harness.records.browserRequestViewIds, [browserChildId]);
  assert.ok(harness.records.remoteUploadIds.length > 0);
  assert.ok(harness.records.remoteDownloadIds.length > 0);
  assert.ok(harness.records.remoteUploadIds.every((id) => id === ROOT_AGENT_ID));
  assert.ok(harness.records.remoteDownloadIds.every((id) => id === ROOT_AGENT_ID));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    new Set(harness.records.foreverBoxReleaseAgentIds),
    new Set([computerChildId, browserChildId]),
  );
  assert.equal(harness.records.foreverBoxReleaseAgentIds.length, 2);
  assert.deepEqual(
    new Set(harness.records.disposedRunnerIds),
    new Set([computerChildId, browserChildId]),
  );
  assert.equal(harness.records.disposedRunnerIds.length, 2);

  const computerRunner = harness.records.builtRunners[1];
  assert.equal(computerRunner.getComputerUseUsageSnapshot()?.turnEndedCount, 1);
  assert.equal(computerRunner.getComputerUseAuditActionCounts().get("screenshot"), 1);
  const computerAudit = harness.records.actionAuditRecords.find(
    (entry) => entry.action?.kind === "computerUseSession",
  );
  assert.equal(computerAudit?.agentId, ROOT_AGENT_ID);
  assert.equal(computerAudit?.boxId, ROOT_AGENT_ID);
  assert.equal(computerAudit?.action?.toolCallId, "task-computer-child");
  assert.equal(computerAudit?.action?.actionCount, 1);
  assert.equal(computerAudit?.action?.screenshotCount, 1);

  assert.deepEqual(harness.records.runLifecycleEvents, []);
  assert.deepEqual(harness.records.transportUpdates, []);
  assert.ok(harness.records.transcriptMirrorCalls.every(
    (entry) => entry.transcriptId === ROOT_AGENT_ID));
  assert.equal(
    harness.records.transcriptMirrorCalls.length,
    rootTranscriptMirrorCallCount,
    "a child invoked the root transcript mirror",
  );

  const runnerCountBeforeResume = harness.records.builtRunnerOptions.length;
  const resumeResult = await executor.execute(
    harness.context,
    new loaded.module.SubagentArgs({
      parentConversationId: ROOT_AGENT_ID,
      prompt: "Do not recreate a completed child",
      resumeAgentId: computerChildId,
      subagentType: "computerUse",
      toolCallId: "task-resume-completed-child",
    }),
    { execId: "task-resume-completed-child" },
  );
  if (resumeResult.result.case === "success") {
    await harness.runner.subagents.drainBackgroundSubagents();
  }
  assert.equal(resumeResult.result.case, "error");
  assert.match(
    resumeResult.result.value.error,
    /completed|cannot be resumed|no longer available/i,
  );
  assert.equal(harness.records.builtRunnerOptions.length, runnerCountBeforeResume);
});

test("production composition disposal drains an active desktop child before release", async (t) => {
  const loaded = await loadModule();
  t.after(loaded.dispose);
  const harness = createHarness(loaded.module, {
    holdComputerChild: true,
    localCapability: true,
  });
  const held = harness.heldComputerChild;
  assert.ok(held);
  const owner = await harness.createRootOwner();
  const executor = owner.buildInput.resourceAccessor.get(
    loaded.module.subagentExecutorResource,
  );
  let disposePromise;
  let disposeSettled = false;
  let reentrantDisposePromise;
  try {
    const result = await executor.execute(
      harness.context,
      new loaded.module.SubagentArgs({
        parentConversationId: ROOT_AGENT_ID,
        prompt: "Stay active until host shutdown interrupts this child",
        subagentType: "computerUse",
        toolCallId: "task-computer-disposal",
      }),
      { execId: "task-computer-disposal" },
    );
    assert.equal(result.result.case, "success");
    const childId = result.result.value.agentId;
    await waitFor(held.started.promise, "the held computer child to start");
    assert.equal(
      harness.runner.steerSubagent(
        childId,
        "This queued steer must not resurrect the child during shutdown",
      ),
      "ok",
    );
    assert.deepEqual(harness.records.childRunIds, [childId]);

    const interruptAll = harness.runner.interruptAll.bind(harness.runner);
    harness.runner.interruptAll = (...args) => {
      reentrantDisposePromise = harness.composition.dispose();
      return interruptAll(...args);
    };

    disposePromise = harness.composition.dispose().then(() => {
      disposeSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const settledBeforeChildUnwind = disposeSettled;
    assert.equal(
      reentrantDisposePromise,
      harness.composition.dispose(),
      "reentrant shutdown did not observe the memoized composition disposal",
    );
    assert.ok(harness.records.interruptedRunnerIds.includes(childId));

    held.unwind.resolve();
    await Promise.all([
      disposePromise,
      harness.runner.subagents.drainBackgroundSubagents(),
    ]);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(
      {
        settledBeforeChildUnwind,
        releasedAgentIds: harness.records.foreverBoxReleaseAgentIds,
      },
      {
        settledBeforeChildUnwind: false,
        releasedAgentIds: [childId],
      },
      "composition disposal must drain a child before releasing its window once",
    );
    assert.ok(harness.records.disposedRunnerIds.includes(childId));
    assert.deepEqual(
      harness.records.childRunIds,
      [childId],
      "a pending MessageSubagent steer started another child turn during shutdown",
    );
  } finally {
    held.unwind.resolve();
    owner.dispose();
    await disposePromise;
    await harness.composition.dispose();
  }
});

test("production composition bounds a stuck child drain and keeps cleanup one-shot", async (t) => {
  const loaded = await loadModule();
  t.after(loaded.dispose);
  const harness = createHarness(loaded.module, {
    holdBoxRelease: true,
    holdChildDispose: true,
    holdComputerChild: true,
    holdMirrorClose: true,
    localCapability: true,
    shutdownDrainTimeoutMs: 80,
    throwTelemetry: true,
  });
  const heldRelease = harness.heldBoxRelease;
  const held = harness.heldComputerChild;
  const heldDispose = harness.heldChildDispose;
  const heldMirror = harness.heldMirrorClose;
  assert.ok(heldRelease);
  assert.ok(held);
  assert.ok(heldDispose);
  assert.ok(heldMirror);
  const owner = await harness.createRootOwner();
  const executor = owner.buildInput.resourceAccessor.get(
    loaded.module.subagentExecutorResource,
  );
  let disposePromise;
  try {
    const result = await executor.execute(
      harness.context,
      new loaded.module.SubagentArgs({
        parentConversationId: ROOT_AGENT_ID,
        prompt: "Remain stuck past the bounded host shutdown drain",
        subagentType: "computerUse",
        toolCallId: "task-computer-bounded-disposal",
      }),
      { execId: "task-computer-bounded-disposal" },
    );
    assert.equal(result.result.case, "success");
    const childId = result.result.value.agentId;
    await waitFor(held.started.promise, "the stuck computer child to start");

    const disposeStartedAt = Date.now();
    disposePromise = harness.composition.dispose();
    assert.equal(
      harness.composition.dispose(),
      disposePromise,
      "composition disposal must be memoized while cleanup is active",
    );
    assert.throws(
      () => harness.composition.createRunner(
        { id: "late-root", dbPath: "/tmp/test-agents/late-root/agent.db" },
        { transport: { onUpdate() {} } },
      ),
      /shutting down/i,
    );
    await waitFor(disposePromise, "bounded production composition disposal", 1_000);
    const disposeElapsedMs = Date.now() - disposeStartedAt;
    assert.ok(disposeElapsedMs >= 50, `shutdown deadline fired too early (${disposeElapsedMs}ms)`);
    assert.ok(
      disposeElapsedMs < 240,
      `cleanup phases exceeded one shared shutdown deadline (${disposeElapsedMs}ms)`,
    );
    assert.deepEqual(harness.records.foreverBoxReleaseAgentIds, [childId]);
    assert.equal(
      harness.records.disposedRunnerIds.filter((id) => id === childId).length,
      1,
    );
    assert.ok(harness.records.analyticsEvents.some((entry) =>
      entry.name === "sand.runner_shutdown_drain_timed_out"
      && entry.properties?.timeout_ms === 80));
    assert.ok(harness.records.analyticsEvents.some((entry) =>
      entry.name === "sand.runner_shutdown_dispose_timed_out"
      && entry.properties?.timeout_ms === 80));
    assert.ok(harness.records.analyticsEvents.some((entry) =>
      entry.name === "sand.subagent_box_release_failed"));
    assert.ok(harness.records.analyticsEvents.some((entry) =>
      entry.name === "sand.runner_shutdown_mirror_close_timed_out"
      && entry.properties?.timeout_ms === 80));

    const runnerCountAfterDisposal = harness.records.builtRunnerOptions.length;
    const lateChild = await executor.execute(
      harness.context,
      new loaded.module.SubagentArgs({
        parentConversationId: ROOT_AGENT_ID,
        prompt: "Do not launch after host shutdown",
        subagentType: "browserUse",
        toolCallId: "task-after-composition-disposal",
      }),
      { execId: "task-after-composition-disposal" },
    );
    assert.equal(lateChild.result.case, "error");
    assert.match(lateChild.result.value.error, /shutting down/i);
    assert.equal(harness.records.builtRunnerOptions.length, runnerCountAfterDisposal);
    await assert.rejects(
      () => harness.runner.run("Do not start a root turn after shutdown"),
      /disposed|shutting down/i,
    );

    heldRelease.resolve();
    heldDispose.resolve();
    heldMirror.resolve();
    held.unwind.resolve();
    await harness.runner.subagents.drainBackgroundSubagents();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      harness.records.foreverBoxReleaseAgentIds,
      [childId],
      "late child settlement released the window more than once",
    );
    assert.equal(
      harness.records.disposedRunnerIds.filter((id) => id === childId).length,
      1,
      "late child settlement disposed the runner more than once",
    );
  } finally {
    heldRelease.resolve();
    heldDispose.resolve();
    heldMirror.resolve();
    held.unwind.resolve();
    owner.dispose();
    await disposePromise;
    await harness.composition.dispose();
  }
});

test("production composition rejects a child dispatch that straddles shutdown", async (t) => {
  const loaded = await loadModule();
  t.after(loaded.dispose);
  const harness = createHarness(loaded.module, { localCapability: true });
  const owner = await harness.createRootOwner();
  const executor = owner.buildInput.resourceAccessor.get(
    loaded.module.subagentExecutorResource,
  );
  let disposePromise;
  try {
    const launchPromise = executor.execute(
      harness.context,
      new loaded.module.SubagentArgs({
        parentConversationId: ROOT_AGENT_ID,
        prompt: "Do not begin this child after shutdown starts",
        subagentType: "browserUse",
        toolCallId: "task-straddled-by-composition-disposal",
      }),
      { execId: "task-straddled-by-composition-disposal" },
    );
    assert.equal(
      harness.records.builtRunnerOptions.length,
      2,
      "the child construction side of the shutdown race was not reached",
    );
    const childId = harness.records.builtRunnerOptions[1].getAgentId();

    disposePromise = harness.composition.dispose();
    const launchResult = await launchPromise;
    assert.equal(launchResult.result.case, "error");
    assert.match(launchResult.result.value.error, /shutting down/i);
    await disposePromise;
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(harness.records.builtRunnerOptions.length, 2);
    assert.equal(
      harness.records.disposedRunnerIds.filter((id) => id === childId).length,
      1,
    );
    assert.deepEqual(harness.records.foreverBoxReleaseAgentIds, [childId]);
    assert.deepEqual(harness.runner.subagents.listSubagents(), []);
  } finally {
    owner.dispose();
    await disposePromise;
    await harness.composition.dispose();
  }
});

test("production composition rejects a root turn paused across shutdown", async (t) => {
  const loaded = await loadModule();
  t.after(loaded.dispose);
  const harness = createHarness(loaded.module, {
    holdRemoteAvailability: true,
    localCapability: true,
  });
  const heldAvailability = harness.heldRemoteAvailability;
  assert.ok(heldAvailability);
  let disposePromise;
  try {
    const runPromise = harness.runner.run(
      "Do not reach inference after host shutdown starts",
      { inferenceRequestId: "root-turn-straddled-by-shutdown" },
    ).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await waitFor(
      heldAvailability.started.promise,
      "the root turn availability check to start",
    );

    disposePromise = harness.composition.dispose();
    heldAvailability.release.resolve();
    const outcome = await runPromise;
    if ("error" in outcome) {
      assert.match(String(outcome.error), /disposed|shutting down|interrupt/i);
    } else {
      assert.equal(outcome.value?.aborted, true);
    }
    await disposePromise;

    assert.deepEqual(harness.records.inferenceSessions, []);
    assert.deepEqual(harness.records.toolStreams, []);
    await assert.rejects(
      () => harness.runner.run("A disposed root must stay closed"),
      /disposed|shutting down/i,
    );
  } finally {
    heldAvailability.release.resolve();
    await disposePromise;
    await harness.composition.dispose();
  }
});

test("production composition does no root owner work after disposal", async (t) => {
  const loaded = await loadModule();
  t.after(loaded.dispose);
  const harness = createHarness(loaded.module, {
    holdPrivacy: true,
    localCapability: true,
    shutdownDrainTimeoutMs: 30,
  });
  const heldPrivacy = harness.heldPrivacy;
  assert.ok(heldPrivacy);
  const runPromise = harness.runner.run(
    "Hold root owner construction across host disposal",
    { inferenceRequestId: "held-root-owner" },
  );
  try {
    await waitFor(
      heldPrivacy.started.promise,
      "the root privacy resolution to start",
    );
    const disposal = harness.composition.dispose();
    await assert.rejects(
      () => harness.runner.run("A new root turn must be rejected immediately"),
      /shutting down/i,
    );
    await disposal;

    assert.deepEqual(harness.records.inferenceSessions, []);
    assert.deepEqual(harness.records.localEnsureReadyIds, []);
    assert.deepEqual(harness.records.remoteEnsureReadyIds, []);
    assert.deepEqual(harness.records.checkpointWrites, []);

    heldPrivacy.release.resolve();
    const result = await runPromise;
    assert.equal(result?.aborted, true);
    assert.deepEqual(harness.records.inferenceSessions, []);
    assert.deepEqual(harness.records.localEnsureReadyIds, []);
    assert.deepEqual(harness.records.remoteEnsureReadyIds, []);
    assert.deepEqual(harness.records.checkpointWrites, []);
  } finally {
    heldPrivacy.release.resolve();
    await runPromise.catch(() => undefined);
    await harness.composition.dispose();
  }
});

test("production composition cancels a root when shutdown re-enters before controller registration", async (t) => {
  const loaded = await loadModule();
  t.after(loaded.dispose);
  const harness = createHarness(loaded.module, { localCapability: true });
  const beginEpoch = harness.runner.beginAutoReviewUserMessageEpoch.bind(
    harness.runner,
  );
  let disposal;
  harness.runner.beginAutoReviewUserMessageEpoch = () => {
    beginEpoch();
    disposal ??= harness.composition.dispose();
  };

  try {
    const result = await harness.runner.run(
      "Re-enter shutdown before the root controller is registered",
      { inferenceRequestId: "pre-controller-shutdown-reentry" },
    );
    await disposal;
    assert.equal(result?.aborted, true);
    assert.deepEqual(harness.records.inferenceSessions, []);
    assert.deepEqual(harness.records.localEnsureReadyIds, []);
    assert.deepEqual(harness.records.remoteEnsureReadyIds, []);
    assert.deepEqual(harness.records.toolStreams, []);
    assert.deepEqual(harness.records.checkpointWrites, []);
  } finally {
    await disposal;
    await harness.composition.dispose();
  }
});

test("production composition cancels every overlapping root turn", async (t) => {
  const loaded = await loadModule();
  t.after(loaded.dispose);
  const harness = createHarness(loaded.module, {
    holdPrivacy: true,
    privacyStartCount: 2,
    localCapability: true,
    shutdownDrainTimeoutMs: 30,
  });
  const heldPrivacy = harness.heldPrivacy;
  assert.ok(heldPrivacy);
  const runs = [
    harness.runner.run("Hold the first overlapping root", {
      inferenceRequestId: "overlapping-root-one",
    }),
    harness.runner.run("Hold the second overlapping root", {
      inferenceRequestId: "overlapping-root-two",
    }),
  ];
  try {
    await waitFor(
      heldPrivacy.allStarted.promise,
      "both overlapping roots to enter privacy resolution",
    );
    await harness.composition.dispose();
    heldPrivacy.release.resolve();
    const results = await Promise.all(runs);

    assert.deepEqual(results.map((result) => result?.aborted), [true, true]);
    assert.deepEqual(harness.records.inferenceSessions, []);
    assert.deepEqual(harness.records.localEnsureReadyIds, []);
    assert.deepEqual(harness.records.remoteEnsureReadyIds, []);
    assert.deepEqual(harness.records.toolStreams, []);
    assert.deepEqual(harness.records.checkpointWrites, []);
    assert.deepEqual(harness.records.transcriptMirrorCalls, []);
  } finally {
    heldPrivacy.release.resolve();
    await Promise.allSettled(runs);
    await harness.composition.dispose();
  }
});

test("production composition prevents late root checkpoint persistence", async (t) => {
  const loaded = await loadModule();
  t.after(loaded.dispose);
  const harness = createHarness(loaded.module, {
    holdRootStream: true,
    localCapability: true,
    shutdownDrainTimeoutMs: 30,
  });
  const heldRootStream = harness.heldRootStream;
  assert.ok(heldRootStream);
  const runPromise = harness.runner.run(
    "Hold a dispatched root stream across host disposal",
    { inferenceRequestId: "held-root-stream" },
  );
  try {
    await waitFor(
      heldRootStream.started.promise,
      "the root inference stream to start",
    );
    await harness.composition.dispose();

    assert.deepEqual(harness.records.checkpointWrites, []);
    assert.deepEqual(harness.records.transcriptMirrorCalls, []);

    heldRootStream.release.resolve();
    const result = await runPromise;
    assert.equal(result?.aborted, true);
    assert.deepEqual(harness.records.checkpointWrites, []);
    assert.deepEqual(harness.records.transcriptMirrorCalls, []);
  } finally {
    heldRootStream.release.resolve();
    await runPromise.catch(() => undefined);
    await harness.composition.dispose();
  }
});

test("production composition drains an active root turn before disposal", async (t) => {
  const loaded = await loadModule();
  t.after(loaded.dispose);
  const harness = createHarness(loaded.module, {
    holdRootStream: true,
    localCapability: true,
    shutdownDrainTimeoutMs: 500,
  });
  const heldRootStream = harness.heldRootStream;
  assert.ok(heldRootStream);
  const runPromise = harness.runner.run(
    "Unwind this active root turn during host disposal",
    { inferenceRequestId: "drained-root-stream" },
  );
  let disposeSettled = false;
  let disposePromise;
  try {
    await waitFor(
      heldRootStream.started.promise,
      "the drainable root inference stream to start",
    );
    disposePromise = harness.composition.dispose().then(() => {
      disposeSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(disposeSettled, false);

    heldRootStream.release.resolve();
    const result = await runPromise;
    await disposePromise;
    assert.equal(result?.aborted, true);
    assert.equal(disposeSettled, true);
    assert.deepEqual(harness.records.checkpointWrites, []);
    assert.deepEqual(harness.records.transcriptMirrorCalls, []);
  } finally {
    heldRootStream.release.resolve();
    await runPromise.catch(() => undefined);
    await disposePromise;
    await harness.composition.dispose();
  }
});

test("production composition cancels checkpoint persistence already in prepare", async (t) => {
  const loaded = await loadModule();
  t.after(loaded.dispose);
  const harness = createHarness(loaded.module, {
    holdMirrorPrepare: true,
    localCapability: true,
    shutdownDrainTimeoutMs: 30,
  });
  const heldMirrorPrepare = harness.heldMirrorPrepare;
  assert.ok(heldMirrorPrepare);
  const runPromise = harness.runner.run(
    "Hold root checkpoint preparation across host disposal",
    { inferenceRequestId: "held-root-checkpoint-prepare" },
  );
  try {
    await waitFor(
      heldMirrorPrepare.started.promise,
      "the root transcript mirror prepare to start",
    );
    await harness.composition.dispose();

    assert.deepEqual(harness.records.checkpointWrites, []);
    assert.deepEqual(
      harness.records.transcriptMirrorCalls.map((entry) => entry.operation),
      ["prepare"],
    );

    heldMirrorPrepare.release.resolve();
    const result = await runPromise;
    assert.equal(result?.aborted, true);
    assert.deepEqual(harness.records.checkpointWrites, []);
    assert.equal(
      harness.records.transcriptMirrorCalls.some(
        (entry) => entry.operation === "commit",
      ),
      false,
      "a canceled checkpoint committed after composition disposal",
    );
    assert.ok(
      harness.records.transcriptMirrorCalls.every(
        (entry) => entry.operation === "prepare" || entry.operation === "abort",
      ),
      "checkpoint cleanup performed an unexpected mirror operation",
    );
  } finally {
    heldMirrorPrepare.release.resolve();
    await runPromise.catch(() => undefined);
    await harness.composition.dispose();
  }
});

test("production composition completes a prepared mirror after the durable store starts", async (t) => {
  const loaded = await loadModule();
  t.after(loaded.dispose);
  const harness = createHarness(loaded.module, {
    holdCheckpointStore: true,
    localCapability: true,
    shutdownDrainTimeoutMs: 500,
  });
  const heldCheckpointStore = harness.heldCheckpointStore;
  assert.ok(heldCheckpointStore);
  const runPromise = harness.runner.run(
    "Hold the durable root checkpoint write across host disposal",
    { inferenceRequestId: "held-root-checkpoint-store" },
  );
  let disposalSettled = false;
  let disposal;
  try {
    await waitFor(
      heldCheckpointStore.started.promise,
      "the durable root checkpoint store to start",
    );
    disposal = harness.composition.dispose().then(() => {
      disposalSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(disposalSettled, false);
    assert.deepEqual(harness.records.persistenceEvents, ["prepare", "store:start"]);

    heldCheckpointStore.release.resolve();
    const result = await runPromise;
    await disposal;
    assert.equal(result?.aborted, true);
    assert.deepEqual(harness.records.persistenceEvents, [
      "prepare",
      "store:start",
      "store:durable",
      "commit",
    ]);
    assert.equal(harness.records.checkpointWrites.length, 1);
    assert.equal(harness.records.persistenceEvents.includes("abort"), false);
  } finally {
    heldCheckpointStore.release.resolve();
    await runPromise.catch(() => undefined);
    await disposal;
    await harness.composition.dispose();
  }
});

test("superseded checkpoint preparation does not persist a profile announcement", async (t) => {
  const loaded = await loadModule();
  t.after(loaded.dispose);
  const heldPrepare = { started: createDeferred(), release: createDeferred() };
  const profileWrites = [];
  let superseded = false;
  const settle = loaded.module.createTurnSettle({
    isSubagentRunner: false,
    transcriptMirror: {
      async prepareCheckpoint() {
        heldPrepare.started.resolve();
        await heldPrepare.release.promise;
      },
      async abortCheckpoint() {},
      async commitCheckpoint() {},
      async skipCheckpoint() {},
    },
    getTranscriptId: () => ROOT_AGENT_ID,
    getBlobStore: () => undefined,
    agentStore: () => ({
      async handleCheckpoint() {},
      getMetadata: () => undefined,
    }),
    setLocalState() {},
    ownsRunner: () => true,
    isRunSuperseded: () => superseded,
    latestPromptMessages: () => [],
    persistAnnouncedAgentProfile(_snapshots, _snapshot, identity) {
      profileWrites.push(identity);
    },
  }, {
    conversationId: ROOT_AGENT_ID,
    profilePromptSnapshots: {},
  });
  settle.setProfileSnapshot({});
  settle.noteProfileUpdateAppended({ name: "late", description: "blocked" });
  const persistence = settle.persistStepCheckpoint(
    {},
    new loaded.module.ConversationStateStructure(),
  );
  await heldPrepare.started.promise;
  superseded = true;
  heldPrepare.release.resolve();
  await persistence;
  assert.deepEqual(profileWrites, []);
});

test("live production turn persists an appended profile announcement", async (t) => {
  const loaded = await loadModule();
  t.after(loaded.dispose);
  const oldIdentity = { name: "Old Agent", description: "Old profile" };
  const newIdentity = { name: "New Agent", description: "Updated profile" };
  const liveProfile = {
    ...oldIdentity,
    filePath: "/tmp/test-agent/profile.json",
    settingsFilePath: "/tmp/test-agent/settings.json",
  };
  const harness = createHarness(loaded.module, {
    localCapability: true,
    profilePromptSnapshot: {
      version: 1,
      profileSection: "Agent profile:\nTitle: Old Agent",
      systemIdentity: oldIdentity,
      announcedIdentity: oldIdentity,
      compactionEpoch: 0,
    },
    agentProfile: liveProfile,
  });
  try {
    await harness.runner.run("Establish the original live profile", {
      inferenceRequestId: "live-profile-baseline",
    });
    assert.ok(
      (harness.records.checkpointWrites.at(-1)?.rootPromptMessagesJson?.length ?? 0) > 0,
      "the baseline turn did not persist root prompt history",
    );
    harness.records.profileSnapshotWrites.length = 0;
    Object.assign(liveProfile, newIdentity);
    const result = await harness.runner.run("Observe the changed live profile", {
      inferenceRequestId: "live-profile-announcement",
    });
    assert.equal(result?.aborted, false);
    const owner = harness.records.productionOwners.at(-1);
    assert.deepEqual(owner?.runContext.profileUpdateForTurn?.identity, newIdentity);
    assert.equal(typeof owner?.built.config.messageHistoryModifier, "function");
    assert.ok(harness.records.profileSnapshotWrites.length > 0);
    assert.deepEqual(
      harness.records.profileSnapshotWrites.at(-1)?.announcedIdentity,
      newIdentity,
    );
  } finally {
    await harness.composition.dispose();
  }
});

test("shutdown during live profile checkpoint preparation writes no announcement", async (t) => {
  const loaded = await loadModule();
  t.after(loaded.dispose);
  const oldIdentity = { name: "Old Agent", description: "Old profile" };
  const liveProfile = {
    ...oldIdentity,
    filePath: "/tmp/test-agent/profile.json",
    settingsFilePath: "/tmp/test-agent/settings.json",
  };
  const harness = createHarness(loaded.module, {
    holdMirrorPrepare: true,
    // Arm the hold after the baseline turn so this remains robust if a normal
    // turn gains another durable checkpoint boundary.
    mirrorPrepareHoldAt: Number.MAX_SAFE_INTEGER,
    shutdownDrainTimeoutMs: 30,
    localCapability: true,
    profilePromptSnapshot: {
      version: 1,
      profileSection: "Agent profile:\nTitle: Old Agent",
      systemIdentity: oldIdentity,
      announcedIdentity: oldIdentity,
      compactionEpoch: 0,
    },
    agentProfile: liveProfile,
  });
  const heldMirrorPrepare = harness.heldMirrorPrepare;
  assert.ok(heldMirrorPrepare);
  await harness.runner.run("Establish the original profile before shutdown", {
    inferenceRequestId: "shutdown-profile-baseline",
  });
  heldMirrorPrepare.holdAt = heldMirrorPrepare.calls + 1;
  harness.records.profileSnapshotWrites.length = 0;
  Object.assign(liveProfile, {
    name: "New Agent",
    description: "Updated profile",
  });
  const runPromise = harness.runner.run(
    "Hold the live profile checkpoint during shutdown",
    { inferenceRequestId: "shutdown-profile-announcement" },
  );
  try {
    await waitFor(
      heldMirrorPrepare.started.promise,
      "the live profile checkpoint to enter mirror preparation",
    );
    await harness.composition.dispose();
    assert.deepEqual(harness.records.profileSnapshotWrites, []);
    heldMirrorPrepare.release.resolve();
    const result = await runPromise;
    assert.equal(result?.aborted, true);
    assert.deepEqual(harness.records.profileSnapshotWrites, []);
  } finally {
    heldMirrorPrepare.release.resolve();
    await runPromise.catch(() => undefined);
    await harness.composition.dispose();
  }
});

test("host disposal is one-shot and drains runners before transcript stores", async (t) => {
  const loaded = await loadModule();
  t.after(loaded.dispose);
  const releaseRunnerDisposal = createDeferred();
  const releaseSuspendWakes = createDeferred();
  const events = [];
  const extensionApis = new Map([
    ["managed-setup", { dispose() {} }],
    ["automations", {
      async suspendWakes() {
        events.push("suspend:start");
        await releaseSuspendWakes.promise;
        events.push("suspend:end");
      },
    }],
    ["cross-user-sharing", { prepareForUpgrade() {} }],
    ["auto-review", { expirePendingApprovals() {} }],
    ["transcript", {
      isQuiescingForUpgrade: () => false,
      async dispose() {
        events.push("transcript");
      },
    }],
  ]);
  const host = new loaded.module.SandHost({
    now: () => 0,
    log: { log() {}, error() {} },
  });
  host.hostExtensions = {
    order: [],
    api: (id) => extensionApis.get(id) ?? {},
    async stop() {
      events.push("extensions");
    },
  };
  host.runnerComposition = {
    async dispose() {
      events.push("runners:start");
      await releaseRunnerDisposal.promise;
      events.push("runners:end");
    },
  };

  const first = host.dispose();
  const second = host.dispose();
  assert.strictEqual(first, second);
  assert.deepEqual(events, ["runners:start", "suspend:start"]);

  releaseSuspendWakes.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    events,
    ["runners:start", "suspend:start", "suspend:end"],
  );

  releaseRunnerDisposal.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(
    events,
    [
      "runners:start",
      "suspend:start",
      "suspend:end",
      "runners:end",
      "transcript",
      "extensions",
    ],
  );
});

test("process shutdown closes host admission before waiting for the gateway", async (t) => {
  const loaded = await loadModule();
  t.after(loaded.dispose);
  assert.ok(
    loaded.module.PRODUCTION_RUNNER_SHUTDOWN_DRAIN_TIMEOUT_MS
      <= loaded.module.SHUTDOWN_WATCHDOG_MS - 1_000,
    "runner drain leaves no watchdog margin for remaining host cleanup",
  );
  assert.ok(
    loaded.module.BOX_EXEC_DAEMON_STOP_TIMEOUT_MS
      <= loaded.module.SHUTDOWN_WATCHDOG_MS - 1_000,
    "daemon stop leaves no process watchdog cleanup margin",
  );

  const gatewayRelease = createDeferred();
  const hostRelease = createDeferred();
  const daemonRelease = createDeferred();
  const exited = createDeferred();
  const events = [];
  const registration = loaded.module.installShutdownHandlers({
    dispose() {
      events.push("host:start");
      return hostRelease.promise.then(() => {
        events.push("host:end");
      });
    },
    reportProcessCrash() {
      events.push("crash");
    },
    async flushTelemetryForFatalExit() {
      events.push("flush");
    },
  }, {
    close() {
      events.push("gateway:start");
      return gatewayRelease.promise.then(() => {
        events.push("gateway:end");
      });
    },
  }, {
    release() {
      events.push("lock");
    },
  }, async () => {
    events.push("discovery");
  }, {
    argv: [],
    pid: 1,
    on() {},
    exit(code) {
      events.push(`exit:${code}`);
      exited.resolve();
    },
  }, { log() {} }, 1_000, {
    close() {
      events.push("daemon:start");
      return daemonRelease.promise.then(() => {
        events.push("daemon:end");
      });
    },
  });

  registration.shutdown("SIGTERM");
  assert.deepEqual(events, ["host:start", "daemon:start", "gateway:start"]);
  gatewayRelease.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [
    "host:start",
    "daemon:start",
    "gateway:start",
    "gateway:end",
  ]);
  hostRelease.resolve();
  daemonRelease.resolve();
  await waitFor(exited.promise, "clean host process exit");
  assert.deepEqual(events, [
    "host:start",
    "daemon:start",
    "gateway:start",
    "gateway:end",
    "host:end",
    "daemon:end",
    "discovery",
    "lock",
    "exit:0",
  ]);
});
