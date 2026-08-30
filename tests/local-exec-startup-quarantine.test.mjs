import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(import.meta.dirname, "..");

async function loadModule(relative) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-startup-quarantine-module-"));
  const output = path.join(temporary, "module.mjs");
  await build({
    entryPoints: [path.join(repoRoot, relative)],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const imported = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return {
    module: imported,
    dispose: () => rm(temporary, { recursive: true, force: true }),
  };
}

function fakeChild(pid) {
  return {
    pid,
    exitCode: null,
    signalCode: null,
    once() {},
  };
}

function controlDependencies({ native, ledger, events = [], overrides = {} }) {
  return {
    connector: { async connect() { return {}; } },
    webauthnPrompt: {
      async requestConsent() { return { approved: false, promptId: null }; },
      async requestPin() { return { pin: null }; },
      update() {},
      finish() {},
    },
    recordSendStage() {},
    recordGatewayCommandSpan() {},
    onReachability() {},
    onDnsDiagnostic() {},
    onProcessCrash() {},
    async readLocalExecDaemonDiscovery() { return null; },
    async clearLocalExecDaemonDiscoveryIfMatches() {
      events.push("clear-discovery");
      return true;
    },
    async readLocalExecStartupQuarantines() { return [...ledger.records]; },
    async writeLocalExecStartupQuarantine(record) {
      events.push("write-quarantine");
      const existing = ledger.records.find(candidate => candidate.pid === record.pid
        && candidate.entryRealpath === record.entryRealpath
        && candidate.generationToken === record.generationToken);
      if (existing != null) return existing;
      const stored = structuredClone(record);
      ledger.records.push(stored);
      return stored;
    },
    async clearLocalExecStartupQuarantineIfMatches(expected) {
      const index = ledger.records.findIndex(candidate => JSON.stringify(candidate) === JSON.stringify(expected));
      if (index < 0) return false;
      ledger.records.splice(index, 1);
      events.push("clear-quarantine");
      return true;
    },
    now: () => 10_000,
    delay: async () => {},
    native,
    ...overrides,
  };
}

function matchingIdentity(pid, entryRealpath, generationToken) {
  return {
    pid,
    startEpochMs: 9_900,
    command: `node "${entryRealpath}" --sand-local-exec-generation=${generationToken}`,
  };
}

test("startup quarantine protocol keeps immutable records separate and rejects corruption", async () => {
  const loaded = await loadModule("source/host/local-exec/local-exec-daemon-protocol.ts");
  const directory = await mkdtemp(path.join(os.tmpdir(), "grok-startup-quarantine-ledger-"));
  const first = {
    version: 1,
    pid: 4_201,
    recordedAt: 10_000,
    entryRealpath: "C:\\app\\daemon.cjs",
    generationToken: "generation-one",
  };
  const second = {
    version: 1,
    pid: 4_202,
    recordedAt: 10_001,
    entryRealpath: "C:\\app\\daemon.cjs",
    generationToken: "generation-two",
  };
  try {
    assert.equal(loaded.module.parseLocalExecStartupQuarantine({ ...first, extra: true }), null);
    assert.deepEqual(await loaded.module.writeLocalExecStartupQuarantine(first, directory), first);
    assert.deepEqual(await loaded.module.writeLocalExecStartupQuarantine(second, directory), second);
    assert.deepEqual((await loaded.module.readLocalExecStartupQuarantines(directory)).map(record => record.generationToken).sort(), ["generation-one", "generation-two"]);

    assert.equal(
      await loaded.module.clearLocalExecStartupQuarantineIfMatches({ ...first, recordedAt: 99_999 }, directory),
      false,
    );
    assert.deepEqual((await loaded.module.readLocalExecStartupQuarantines(directory)).map(record => record.generationToken).sort(), ["generation-one", "generation-two"]);
    assert.equal(await loaded.module.clearLocalExecStartupQuarantineIfMatches(first, directory), true);
    assert.deepEqual(await loaded.module.readLocalExecStartupQuarantines(directory), [second]);

    const secondPath = loaded.module.getLocalExecStartupQuarantinePath(second, directory);
    await writeFile(secondPath, "{not-json", "utf8");
    await assert.rejects(
      loaded.module.readLocalExecStartupQuarantines(directory),
      /contains invalid JSON/,
    );
  } finally {
    await loaded.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed unidentified cleanup persists before signalling and blocks a new executor instance", async () => {
  const loaded = await loadModule("source/electron-main/coordinator/coordinator-executors.ts");
  const ledger = { records: [] };
  const events = [];
  const entryRealpath = "C:\\app\\local-exec-daemon\\main.cjs";
  const generationToken = "durable-generation";
  let firstSpawnCalls = 0;
  let secondSpawnCalls = 0;
  let terminationCalls = 0;
  let identityReads = 0;
  try {
    const first = loaded.module.createCoordinatorControlExecutors(controlDependencies({
      ledger,
      events,
      native: {
        async spawnLocalExecDaemon() {
          firstSpawnCalls += 1;
          events.push("spawn");
          return { child: fakeChild(4_301), entryRealpath, generationToken };
        },
        async terminateProcess() {
          terminationCalls += 1;
          events.push("terminate");
          throw new Error("simulated owned-child termination failure");
        },
        isProcessAlive(pid) { return pid === 4_301; },
        readProcessIdentity(pid) {
          identityReads += 1;
          return identityReads > 40 ? matchingIdentity(pid, entryRealpath, generationToken) : null;
        },
        resolveLocalExecDaemonEntryRealpath() { return entryRealpath; },
      },
    }));
    await assert.rejects(
      first.spawnLocalExecDaemon({ logPath: "test.log", env: {} }),
      /local-exec startup cleanup is quarantined/,
    );
    assert.equal(firstSpawnCalls, 1);
    assert.equal(terminationCalls, 1);
    assert.deepEqual(events.slice(-2), ["write-quarantine", "terminate"]);
    assert.equal(events.includes("clear-discovery"), false);
    assert.equal(ledger.records.length, 1);
    assert.deepEqual(ledger.records[0], {
      version: 1,
      pid: 4_301,
      recordedAt: 10_000,
      entryRealpath,
      generationToken,
    });

    const second = loaded.module.createCoordinatorControlExecutors(controlDependencies({
      ledger,
      native: {
        async spawnLocalExecDaemon() {
          secondSpawnCalls += 1;
          assert.fail("durable quarantine must block a second executor from spawning");
        },
        async terminateProcess() {
          assert.fail("an identity-unreadable live PID must not be signalled during restart reconciliation");
        },
        isProcessAlive(pid) { return pid === 4_301; },
        readProcessIdentity() { return null; },
        resolveLocalExecDaemonEntryRealpath() { return entryRealpath; },
      },
    }));
    await assert.rejects(
      second.spawnLocalExecDaemon({ logPath: "test.log", env: {} }),
      /local-exec startup cleanup is quarantined/,
    );
    assert.equal(secondSpawnCalls, 0);
    assert.equal(ledger.records.length, 1);
  } finally {
    await loaded.dispose();
  }
});

test("restart reconciliation releases a reused PID without signalling it and then permits a fresh spawn", async () => {
  const loaded = await loadModule("source/electron-main/coordinator/coordinator-executors.ts");
  const oldEntry = "C:\\app\\local-exec-daemon\\main.cjs";
  const ledger = {
    records: [{
      version: 1,
      pid: 4_401,
      recordedAt: 10_000,
      entryRealpath: oldEntry,
      generationToken: "old-generation",
    }],
  };
  const freshEntry = "C:\\app\\local-exec-daemon\\main.cjs";
  const freshGeneration = "fresh-generation";
  const freshIdentity = matchingIdentity(4_402, freshEntry, freshGeneration);
  let spawnCalls = 0;
  let terminationCalls = 0;
  try {
    const executors = loaded.module.createCoordinatorControlExecutors(controlDependencies({
      ledger,
      native: {
        async spawnLocalExecDaemon() {
          spawnCalls += 1;
          return { child: fakeChild(freshIdentity.pid), entryRealpath: freshEntry, generationToken: freshGeneration };
        },
        async terminateProcess() {
          terminationCalls += 1;
          assert.fail("a readable unrelated PID must never be signalled");
        },
        isProcessAlive() { return true; },
        readProcessIdentity(pid) {
          if (pid === 4_401) return { pid, startEpochMs: 20_000, command: "unrelated.exe --serve" };
          if (pid === freshIdentity.pid) return freshIdentity;
          return null;
        },
        resolveLocalExecDaemonEntryRealpath() { return freshEntry; },
      },
    }));
    const spawned = await executors.spawnLocalExecDaemon({ logPath: "test.log", env: {} });
    assert.deepEqual(spawned, { ...freshIdentity, entryRealpath: freshEntry, generationToken: freshGeneration });
    assert.equal(spawnCalls, 1);
    assert.equal(terminationCalls, 0);
    assert.deepEqual(ledger.records, []);
  } finally {
    await loaded.dispose();
  }
});

test("restart reconciliation signals only an exact generation and clears it after confirmed exit", async () => {
  const loaded = await loadModule("source/electron-main/coordinator/coordinator-executors.ts");
  const quarantined = {
    version: 1,
    pid: 4_501,
    recordedAt: 10_000,
    entryRealpath: "C:\\app\\local-exec-daemon\\main.cjs",
    generationToken: "owned-generation",
  };
  const exactIdentity = matchingIdentity(quarantined.pid, quarantined.entryRealpath, quarantined.generationToken);
  const freshGeneration = "next-generation";
  const freshIdentity = matchingIdentity(4_502, quarantined.entryRealpath, freshGeneration);
  const ledger = { records: [quarantined] };
  let quarantinedAlive = true;
  let terminationCalls = 0;
  try {
    const executors = loaded.module.createCoordinatorControlExecutors(controlDependencies({
      ledger,
      native: {
        async spawnLocalExecDaemon() {
          return { child: fakeChild(freshIdentity.pid), entryRealpath: quarantined.entryRealpath, generationToken: freshGeneration };
        },
        async terminateProcess(pid, options) {
          assert.equal(pid, quarantined.pid);
          assert.deepEqual(options, { expectedIdentity: exactIdentity });
          terminationCalls += 1;
          quarantinedAlive = false;
        },
        isProcessAlive(pid) { return pid === quarantined.pid ? quarantinedAlive : true; },
        readProcessIdentity(pid) {
          if (pid === quarantined.pid) return quarantinedAlive ? exactIdentity : null;
          if (pid === freshIdentity.pid) return freshIdentity;
          return null;
        },
        resolveLocalExecDaemonEntryRealpath() { return quarantined.entryRealpath; },
      },
    }));
    const spawned = await executors.spawnLocalExecDaemon({ logPath: "test.log", env: {} });
    assert.equal(spawned.pid, freshIdentity.pid);
    assert.equal(terminationCalls, 1);
    assert.deepEqual(ledger.records, []);
  } finally {
    await loaded.dispose();
  }
});

test("quarantine inspection errors fail closed before native spawn", async () => {
  const loaded = await loadModule("source/electron-main/coordinator/coordinator-executors.ts");
  let spawnCalls = 0;
  try {
    const ledger = { records: [] };
    const executors = loaded.module.createCoordinatorControlExecutors(controlDependencies({
      ledger,
      overrides: {
        async readLocalExecStartupQuarantines() {
          throw new Error("malformed durable quarantine record");
        },
      },
      native: {
        async spawnLocalExecDaemon() {
          spawnCalls += 1;
          assert.fail("a malformed durable quarantine must block spawn");
        },
        async terminateProcess() {},
        isProcessAlive() { return false; },
        readProcessIdentity() { return null; },
        resolveLocalExecDaemonEntryRealpath() { return "C:\\app\\daemon.cjs"; },
      },
    }));
    await assert.rejects(
      executors.spawnLocalExecDaemon({ logPath: "test.log", env: {} }),
      /malformed durable quarantine record/,
    );
    assert.equal(spawnCalls, 0);
  } finally {
    await loaded.dispose();
  }
});
