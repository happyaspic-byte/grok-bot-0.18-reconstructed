import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyRelatedWindowsProcesses,
  parsePowerShellProcessJson,
  parseWindowsProcessCreationDate,
} from "../scripts/lib/windows-smoke-processes.mjs";

const launchStartedAtMs = Date.parse("2026-08-30T20:28:35.000Z");
const observedAtMs = launchStartedAtMs + 20_000;
const executable = "C:\\app\\Grok Bot 0.18 Reconstructed.exe";
const userDataDir = "C:\\smoke\\user-data";
const dataRoot = "C:\\smoke\\sand-data";
const entryRealpath = "C:\\app\\resources\\app.asar\\dist\\local-exec-daemon\\main.cjs";
const generationToken = "generation-token";
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
    inflightCount: 0,
    identityVerified: true,
  });
  assert.equal("generationToken" in result.localExecDiscovery, false);
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
