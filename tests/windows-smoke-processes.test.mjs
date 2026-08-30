import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  classifyRelatedWindowsProcesses,
  parsePowerShellProcessJson,
  parseWindowsProcessCreationDate,
  terminateVerifiedLocalExecDaemon,
} from "../scripts/lib/windows-smoke-processes.mjs";

const launchStartedAtMs = Date.parse("2026-08-30T20:28:35.000Z");
const observedAtMs = launchStartedAtMs + 20_000;
const executable = "C:\\app\\Grok Bot 0.18 Reconstructed.exe";
const userDataDir = "C:\\smoke\\user-data";
const dataRoot = "C:\\smoke\\sand-data";
const entryRealpath = "C:\\app\\resources\\app.asar\\dist\\local-exec-daemon\\main.cjs";
const generationToken = "generation-token";
const generationFingerprint = createHash("sha256").update(generationToken, "utf8").digest("hex");
const daemonStartedAt = launchStartedAtMs + 2_000;

function processEntry({
  pid,
  parentPid,
  executablePath = executable,
  commandLine = `"${executable}" --type=utility`,
  creationEpochMs = launchStartedAtMs + 1_000,
}) {
  return {
    ProcessId: pid,
    ParentProcessId: parentPid,
    Name: "Grok Bot 0.18 Reconstructed.exe",
    ExecutablePath: executablePath,
    CommandLine: commandLine,
    CreationDate: new Date(creationEpochMs).toISOString(),
  };
}

function daemonEntry(overrides = {}) {
  return processEntry({
    pid: 1_380,
    parentPid: 8_676,
    commandLine: `"${executable}" "${entryRealpath}" --sand-local-exec-generation=${generationToken}`,
    ...overrides,
  });
}

function discovery(overrides = {}) {
  return {
    pid: 1_380,
    startedAt: daemonStartedAt,
    entryRealpath,
    generationToken,
    inflightCount: 0,
    ...overrides,
  };
}

function classify(processes, localExecDiscovery = discovery()) {
  return classifyRelatedWindowsProcesses({
    processes,
    rootPid: 8_676,
    executable,
    userDataDir,
    dataRoot,
    launchStartedAtMs,
    observedAtMs,
    localExecDiscovery,
  });
}

test("PowerShell process JSON accepts empty, singleton, array, BOM, and .NET dates", () => {
  assert.deepEqual(parsePowerShellProcessJson(""), []);
  assert.deepEqual(parsePowerShellProcessJson("null"), []);
  assert.deepEqual(parsePowerShellProcessJson('\uFEFF{"ProcessId":1}'), [{ ProcessId: 1 }]);
  assert.deepEqual(parsePowerShellProcessJson('[{"ProcessId":1},{"ProcessId":2}]'), [
    { ProcessId: 1 },
    { ProcessId: 2 },
  ]);
  assert.equal(parseWindowsProcessCreationDate("/Date(1788121716000)/"), 1_788_121_716_000);
  assert.equal(
    parseWindowsProcessCreationDate("2026-08-30T20:28:36.000Z"),
    Date.parse("2026-08-30T20:28:36.000Z"),
  );
});

test("only an exact discovery-bound local-exec daemon is an allowed post-exit survivor", () => {
  const result = classify([daemonEntry()]);
  assert.equal(result.cleanExitSurvivors, true);
  assert.equal(result.onlyExpectedPersistentDaemon, true);
  assert.equal(result.verifiedLocalExecDaemonPid, 1_380);
  assert.deepEqual(result.unexpectedProcesses, []);
  assert.deepEqual(result.localExecDiscovery, {
    pid: 1_380,
    startedAt: daemonStartedAt,
    entryRealpath,
    generationTokenPresent: true,
    generationFingerprint,
    inflightCount: 0,
    identityVerified: true,
  });
  assert.equal("generationToken" in result.localExecDiscovery, false);
  assert.equal(JSON.stringify(result).includes(generationToken), false);
  assert.match(result.relevantProcesses[0].commandLine, /--sand-local-exec-generation=\[REDACTED\]/);
});

test("out-of-order descendants and any unknown survivor fail the quit classification", () => {
  const descendant = processEntry({
    pid: 303,
    parentPid: 202,
    executablePath: "C:\\app\\worker.exe",
    commandLine: "worker.exe",
  });
  const intermediate = processEntry({
    pid: 202,
    parentPid: 8_676,
    executablePath: "C:\\app\\worker.exe",
    commandLine: "worker.exe",
  });
  const result = classify([descendant, daemonEntry(), intermediate]);
  assert.equal(result.cleanExitSurvivors, false);
  assert.equal(result.onlyExpectedPersistentDaemon, false);
  assert.deepEqual(result.unexpectedProcesses.map(process => process.pid), [202, 303]);
});

test("PID-only, wrong-generation, stale, and profile-prefix matches never authorize termination", () => {
  const wrongGeneration = classify([
    daemonEntry({
      commandLine: `"${executable}" "${entryRealpath}" --sand-local-exec-generation=other-token`,
    }),
  ]);
  assert.equal(wrongGeneration.verifiedLocalExecDaemonPid, null);
  assert.equal(wrongGeneration.cleanExitSurvivors, false);

  const stale = classifyRelatedWindowsProcesses({
    processes: [processEntry({
      pid: 900,
      parentPid: 1,
      creationEpochMs: launchStartedAtMs - 120_000,
      commandLine: `"${executable}" --user-data-dir=${userDataDir}`,
    })],
    rootPid: 8_676,
    executable,
    userDataDir,
    dataRoot,
    launchStartedAtMs,
    observedAtMs,
    localExecDiscovery: null,
  });
  assert.deepEqual(stale.relevantProcesses, []);

  const prefixCollision = classifyRelatedWindowsProcesses({
    processes: [processEntry({
      pid: 901,
      parentPid: 1,
      executablePath: "C:\\other\\worker.exe",
      commandLine: `worker.exe --user-data-dir=${userDataDir}-other`,
    })],
    rootPid: 8_676,
    executable,
    userDataDir,
    dataRoot,
    launchStartedAtMs,
    observedAtMs,
    localExecDiscovery: null,
  });
  assert.deepEqual(prefixCollision.relevantProcesses, []);
});

function createTerminationHarness({ snapshots, discoveryValue = discovery() }) {
  let processSnapshotIndex = 0;
  let taskkillCalls = 0;
  const execFileImpl = async executablePath => {
    if (/powershell\.exe$/i.test(executablePath)) {
      const snapshot = snapshots[Math.min(processSnapshotIndex, snapshots.length - 1)];
      processSnapshotIndex += 1;
      if (snapshot instanceof Error) throw snapshot;
      return { stdout: JSON.stringify(snapshot), stderr: "" };
    }
    if (/taskkill\.exe$/i.test(executablePath)) {
      taskkillCalls += 1;
      return { stdout: "", stderr: "" };
    }
    throw new Error(`Unexpected executable: ${executablePath}`);
  };
  return {
    options: {
      rootPid: 8_676,
      executable,
      userDataDir,
      dataRoot,
      launchStartedAtMs,
      observedAtMs,
      execFileImpl,
      readFileImpl: async () => JSON.stringify(discoveryValue),
      environment: { SystemRoot: "C:\\Windows" },
    },
    taskkillCalls: () => taskkillCalls,
  };
}

test("verified daemon termination confirms identity twice and requires an empty post-kill inventory", async () => {
  const harness = createTerminationHarness({
    snapshots: [[daemonEntry()], [daemonEntry()], []],
  });
  assert.deepEqual(await terminateVerifiedLocalExecDaemon(harness.options), {
    terminated: true,
    pid: 1_380,
  });
  assert.equal(harness.taskkillCalls(), 1);
});

test("daemon termination fails closed on inventory errors and missing discovery identity", async () => {
  const inventoryFailure = createTerminationHarness({
    snapshots: [new Error("CIM unavailable")],
  });
  await assert.rejects(
    terminateVerifiedLocalExecDaemon(inventoryFailure.options),
    /Windows process inventory failed: CIM unavailable/,
  );
  assert.equal(inventoryFailure.taskkillCalls(), 0);

  const missingDiscovery = createTerminationHarness({
    snapshots: [[daemonEntry()]],
    discoveryValue: null,
  });
  await assert.rejects(
    terminateVerifiedLocalExecDaemon(missingDiscovery.options),
    /refusing an unverified or ambiguously related Windows process/,
  );
  assert.equal(missingDiscovery.taskkillCalls(), 0);
});

test("daemon termination never treats a failed post-kill inventory or another survivor as success", async () => {
  const postKillInventoryFailure = createTerminationHarness({
    snapshots: [[daemonEntry()], [daemonEntry()], new Error("post-kill CIM unavailable")],
  });
  await assert.rejects(
    terminateVerifiedLocalExecDaemon(postKillInventoryFailure.options),
    /After local-exec termination: Windows process inventory failed/,
  );
  assert.equal(postKillInventoryFailure.taskkillCalls(), 1);

  const replacement = processEntry({
    pid: 2_000,
    parentPid: 1,
    commandLine: `"${executable}" --type=utility`,
  });
  const otherSurvivor = createTerminationHarness({
    snapshots: [[daemonEntry()], [daemonEntry()], [replacement]],
  });
  await assert.rejects(
    terminateVerifiedLocalExecDaemon(otherSurvivor.options),
    /exited but other related Windows processes remained/,
  );
  assert.equal(otherSurvivor.taskkillCalls(), 1);
});

