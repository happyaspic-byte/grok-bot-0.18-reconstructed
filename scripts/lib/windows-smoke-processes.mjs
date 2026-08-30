import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const LOCAL_EXEC_GENERATION_TOKEN_ARG = "--sand-local-exec-generation=";
const LOCAL_EXEC_PUBLICATION_LAG_MS = 60_000;
const PROCESS_CLOCK_SKEW_MS = 5_000;

export function normalizeWindowsPath(value) {
  return typeof value === "string" && value.length > 0
    ? path.win32.normalize(value).toLowerCase()
    : "";
}

export function parseWindowsProcessCreationDate(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.length === 0) return null;
  const dotNet = /^\/Date\((\d+)(?:[+-]\d+)?\)\/$/.exec(value);
  if (dotNet != null) return Number(dotNet[1]);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parsePowerShellProcessJson(raw) {
  const normalized = String(raw).replace(/^\uFEFF/, "").trim();
  if (normalized.length === 0 || normalized === "null") return [];
  const parsed = JSON.parse(normalized);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function commandContainsExactArgument(commandLine, argument) {
  if (typeof commandLine !== "string" || argument.length === 0) return false;
  let offset = commandLine.indexOf(argument);
  while (offset >= 0) {
    const before = offset === 0 || /[\s"]/.test(commandLine[offset - 1]);
    const end = offset + argument.length;
    const after = end === commandLine.length || /[\s"]/.test(commandLine[end]);
    if (before && after) return true;
    offset = commandLine.indexOf(argument, offset + 1);
  }
  return false;
}

function normalizeProcess(entry) {
  const pid = Number(entry?.ProcessId ?? entry?.pid);
  const parentPid = Number(entry?.ParentProcessId ?? entry?.parentPid);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(parentPid) || parentPid < 0) return null;
  const creationDate = entry?.CreationDate ?? entry?.creationDate ?? null;
  return {
    pid,
    parentPid,
    name: typeof (entry?.Name ?? entry?.name) === "string" ? (entry.Name ?? entry.name) : null,
    executablePath: typeof (entry?.ExecutablePath ?? entry?.executablePath) === "string"
      ? (entry.ExecutablePath ?? entry.executablePath)
      : null,
    commandLine: typeof (entry?.CommandLine ?? entry?.commandLine) === "string"
      ? (entry.CommandLine ?? entry.commandLine)
      : null,
    creationDate,
    creationEpochMs: parseWindowsProcessCreationDate(creationDate),
  };
}

function sanitizeDiscovery(discovery, identityVerified) {
  if (discovery == null || !Number.isInteger(discovery.pid) || discovery.pid <= 0) return null;
  return {
    pid: discovery.pid,
    startedAt: typeof discovery.startedAt === "number" ? discovery.startedAt : null,
    entryRealpath: typeof discovery.entryRealpath === "string" ? discovery.entryRealpath : null,
    generationTokenPresent: typeof discovery.generationToken === "string" && discovery.generationToken.length > 0,
    inflightCount: Number.isInteger(discovery.inflightCount) ? discovery.inflightCount : null,
    identityVerified,
  };
}

export function classifyRelatedWindowsProcesses({
  processes,
  rootPid,
  executable,
  userDataDir,
  dataRoot,
  launchStartedAtMs,
  observedAtMs = Date.now(),
  localExecDiscovery,
}) {
  const rows = processes.map(normalizeProcess).filter(Boolean);
  const launchLowerBound = Number.isFinite(launchStartedAtMs)
    ? launchStartedAtMs - PROCESS_CLOCK_SKEW_MS
    : observedAtMs - LOCAL_EXEC_PUBLICATION_LAG_MS;
  const inLaunchWindow = entry =>
    entry.creationEpochMs != null
    && entry.creationEpochMs >= launchLowerBound
    && entry.creationEpochMs <= observedAtMs + PROCESS_CLOCK_SKEW_MS;

  const relatedPids = new Set(Number.isInteger(rootPid) && rootPid > 0 ? [rootPid] : []);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of rows) {
      if (!inLaunchWindow(entry) || !relatedPids.has(entry.parentPid) || relatedPids.has(entry.pid)) continue;
      relatedPids.add(entry.pid);
      changed = true;
    }
  }

  const executableKey = normalizeWindowsPath(executable);
  const profileArgument = typeof userDataDir === "string" && userDataDir.length > 0
    ? `--user-data-dir=${userDataDir}`
    : null;
  const discoveryPid = Number.isInteger(localExecDiscovery?.pid) ? localExecDiscovery.pid : null;
  const relevantProcesses = rows.filter(entry =>
    relatedPids.has(entry.pid)
      || entry.pid === discoveryPid
      || (inLaunchWindow(entry)
        && executableKey.length > 0
        && normalizeWindowsPath(entry.executablePath) === executableKey)
      || (inLaunchWindow(entry)
        && profileArgument != null
        && commandContainsExactArgument(entry.commandLine, profileArgument))
  ).sort((left, right) => left.pid - right.pid);

  let verifiedDaemon = null;
  if (
    discoveryPid != null
    && typeof localExecDiscovery?.startedAt === "number"
    && Number.isFinite(localExecDiscovery.startedAt)
    && typeof localExecDiscovery?.entryRealpath === "string"
    && localExecDiscovery.entryRealpath.length > 0
    && typeof localExecDiscovery?.generationToken === "string"
    && localExecDiscovery.generationToken.length > 0
  ) {
    const candidate = relevantProcesses.find(entry => entry.pid === discoveryPid);
    const commandKey = candidate?.commandLine?.toLowerCase() ?? "";
    const entryKey = normalizeWindowsPath(localExecDiscovery.entryRealpath);
    const discoveryFollowsSpawn = candidate?.creationEpochMs != null
      && localExecDiscovery.startedAt >= candidate.creationEpochMs
      && localExecDiscovery.startedAt - candidate.creationEpochMs <= LOCAL_EXEC_PUBLICATION_LAG_MS
      && localExecDiscovery.startedAt <= observedAtMs + PROCESS_CLOCK_SKEW_MS;
    if (
      candidate != null
      && normalizeWindowsPath(candidate.executablePath) === executableKey
      && entryKey.length > 0
      && commandKey.includes(entryKey)
      && commandContainsExactArgument(
        candidate.commandLine,
        `${LOCAL_EXEC_GENERATION_TOKEN_ARG}${localExecDiscovery.generationToken}`,
      )
      && discoveryFollowsSpawn
    ) verifiedDaemon = candidate;
  }

  const unexpectedProcesses = relevantProcesses.filter(entry => entry.pid !== verifiedDaemon?.pid);
  const onlyExpectedPersistentDaemon = verifiedDaemon != null
    && relevantProcesses.length === 1
    && unexpectedProcesses.length === 0;
  return {
    rootPid: Number.isInteger(rootPid) ? rootPid : null,
    localExecDiscovery: sanitizeDiscovery(localExecDiscovery, verifiedDaemon != null),
    relevantProcesses,
    unexpectedProcesses,
    verifiedLocalExecDaemonPid: verifiedDaemon?.pid ?? null,
    onlyExpectedPersistentDaemon,
    cleanExitSurvivors: relevantProcesses.length === 0 || onlyExpectedPersistentDaemon,
  };
}

function powershellExecutable(environment = process.env) {
  const systemRoot = environment.SystemRoot ?? environment.SYSTEMROOT ?? "C:\\Windows";
  return path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

async function readDiscovery(dataRoot, readFileImpl) {
  try {
    const value = JSON.parse(await readFileImpl(path.join(dataRoot, "local-exec-daemon.json"), "utf8"));
    return value != null && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

export async function inspectRelatedWindowsProcesses({
  rootPid,
  executable,
  userDataDir,
  dataRoot,
  launchStartedAtMs,
  observedAtMs = Date.now(),
  execFileImpl = execFileAsync,
  readFileImpl = readFile,
  environment = process.env,
}) {
  const localExecDiscovery = await readDiscovery(dataRoot, readFileImpl);
  try {
    const command = [
      "$ErrorActionPreference = 'Stop'",
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
      "Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,CreationDate | ConvertTo-Json -Depth 3 -Compress",
    ].join("; ");
    const { stdout } = await execFileImpl(
      powershellExecutable(environment),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      { timeout: 10_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
    );
    return classifyRelatedWindowsProcesses({
      processes: parsePowerShellProcessJson(stdout),
      rootPid,
      executable,
      userDataDir,
      dataRoot,
      launchStartedAtMs,
      observedAtMs,
      localExecDiscovery,
    });
  } catch (error) {
    return {
      rootPid: Number.isInteger(rootPid) ? rootPid : null,
      localExecDiscovery: sanitizeDiscovery(localExecDiscovery, false),
      inventoryError: error instanceof Error ? error.message : String(error),
      relevantProcesses: [],
      unexpectedProcesses: [],
      verifiedLocalExecDaemonPid: null,
      onlyExpectedPersistentDaemon: false,
      cleanExitSurvivors: false,
    };
  }
}

export async function terminateVerifiedLocalExecDaemon(options) {
  const state = await inspectRelatedWindowsProcesses(options);
  if (state.localExecDiscovery == null || state.relevantProcesses.length === 0) return { terminated: false };
  if (
    state.inventoryError != null
    || state.verifiedLocalExecDaemonPid == null
    || state.unexpectedProcesses.length > 0
  ) throw new Error("Refusing to terminate an unverified or ambiguously related Windows process");
  const taskkill = path.win32.join(
    options.environment?.SystemRoot ?? options.environment?.SYSTEMROOT ?? process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "taskkill.exe",
  );
  const targetPid = state.verifiedLocalExecDaemonPid;
  await (options.execFileImpl ?? execFileAsync)(
    taskkill,
    ["/PID", String(targetPid), "/T", "/F"],
    { timeout: 10_000, windowsHide: true },
  );
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const observed = await inspectRelatedWindowsProcesses(options);
    if (!observed.relevantProcesses.some(process => process.pid === targetPid)) {
      return { terminated: true, pid: targetPid };
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Verified local-exec daemon ${targetPid} remained alive after taskkill`);
}
