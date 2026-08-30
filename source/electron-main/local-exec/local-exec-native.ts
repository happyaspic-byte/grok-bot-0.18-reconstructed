import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import { readLocalExecDaemonDiscovery } from "../../host/local-exec/local-exec-daemon-protocol.js";
import {
  commandCarriesLocalExecGeneration,
  localExecDiscoveryTimeMatchesProcess,
  LOCAL_EXEC_GENERATION_TOKEN_ARG,
  LOCAL_EXEC_GENERATION_TOKEN_ENV,
} from "../../shared/local-exec-process-identity.js";
import { findSystemErrno } from "../../shared/system-errno.js";
import { reportLocalExecExited, reportLocalExecSpawnFailed, reportLocalExecSpawned, reportLocalExecTerminationFailed } from "./local-exec-lifecycle-telemetry.js";

export function daemonMainPath(moduleUrl = import.meta.url): string { return join(dirname(fileURLToPath(moduleUrl)), "..", "local-exec-daemon", "main.cjs"); }
export function resolveLocalExecDaemonEntryRealpath(mainPath = daemonMainPath(), realpath: typeof realpathSync = realpathSync): string { return realpath(mainPath); }
function attemptSync<T>(run: () => T): { ok: true; value: T } | { ok: false } { try { return { ok: true, value: run() }; } catch { return { ok: false }; } }
export interface LocalExecProcessIdentity { readonly pid: number; readonly startEpochMs: number; readonly command: string; }
function sameNativeProcessIdentity(left: LocalExecProcessIdentity, right: LocalExecProcessIdentity): boolean {
  return left.pid === right.pid
    && left.startEpochMs === right.startEpochMs
    && left.command === right.command;
}
export interface SpawnedLocalExecDaemon { readonly child: ChildProcess; readonly entryRealpath: string; readonly generationToken: string; }
export function parsePosixProcessIdentity(pid: number, output: string): LocalExecProcessIdentity | null { const match = /^(\S{3}\s+\S{3}\s+[ 0-9]\d\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(output.trim()); const started = match?.[1]; if (started == null) return null; const startEpochMs = Date.parse(started); const command = match?.[2]?.trim() ?? ""; return Number.isFinite(startEpochMs) && command.length > 0 ? { pid, startEpochMs, command } : null; }

function windowsSystemRoot(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.SystemRoot ?? environment.SYSTEMROOT ?? "C:\\Windows";
}

export function resolveWindowsPowerShellPath(environment: NodeJS.ProcessEnv = process.env): string {
  return win32.join(windowsSystemRoot(environment), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export function resolveWindowsTaskkillPath(environment: NodeJS.ProcessEnv = process.env): string {
  return win32.join(windowsSystemRoot(environment), "System32", "taskkill.exe");
}

export function parseWindowsProcessStartEpochMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.length === 0) return null;
  const dotNet = /^\/Date\((\d+)(?:[+-]\d+)?\)\/$/.exec(value);
  if (dotNet != null) return Number(dotNet[1]);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function readProcessIdentity(
  pid: number,
  platform = process.platform,
  dependencies: {
    readonly execFileSync?: typeof execFileSync;
    readonly environment?: NodeJS.ProcessEnv;
  } = {},
): LocalExecProcessIdentity | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (readProcessState(pid, platform)?.startsWith("Z") === true) return null;
  const execute = dependencies.execFileSync ?? execFileSync;
  if (platform === "win32") {
    const command = [
      "$ErrorActionPreference = 'Stop'",
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
      `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'`,
      "if ($null -ne $p) { @{CreationDate=$p.CreationDate.ToUniversalTime().ToString('o');CommandLine=$p.CommandLine}|ConvertTo-Json -Compress }",
    ].join("; ");
    const queried = attemptSync(() => execute(
      resolveWindowsPowerShellPath(dependencies.environment),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      { encoding: "utf8", timeout: 5_000, windowsHide: true },
    ));
    if (!queried.ok || typeof queried.value !== "string" || queried.value.trim().length === 0) return null;
    try {
      const parsed = JSON.parse(queried.value) as { CreationDate?: unknown; CommandLine?: unknown };
      const startEpochMs = parseWindowsProcessStartEpochMs(parsed.CreationDate);
      return startEpochMs != null && typeof parsed.CommandLine === "string" && parsed.CommandLine.trim().length > 0
        ? { pid, startEpochMs, command: parsed.CommandLine.trim() }
        : null;
    } catch {
      return null;
    }
  }
  const queried = attemptSync(() => execute(
    "ps",
    ["-p", String(pid), "-o", "lstart=", "-o", "command="],
    { encoding: "utf8", timeout: 2_000, env: { ...process.env, LC_ALL: "C" } },
  ));
  return queried.ok && typeof queried.value === "string"
    ? parsePosixProcessIdentity(pid, queried.value)
    : null;
}
export function readProcessState(pid: number, platform = process.platform): string | null { if (platform === "win32") return null; const queried = attemptSync(() => execFileSync("ps", ["-p", String(pid), "-o", "state="], { encoding: "utf8", timeout: 2_000 })); if (!queried.ok) return null; const state = queried.value.trim(); return state.length > 0 ? state : null; }
export function isProcessAlive(pid: number, kill: typeof process.kill = process.kill.bind(process), readState: (pid: number) => string | null = readProcessState): boolean { let signalable = false; try { kill(pid, 0); signalable = true; } catch (error) { const code = findSystemErrno(error); if (code === "ESRCH") return false; if (code !== "EPERM") throw error; signalable = true; } if (!signalable) return false; const state = readState(pid); return state == null || !state.startsWith("Z"); }
export function readProcessCommand(pid: number, platform = process.platform): string | null { const proc = attemptSync(() => readFileSync(`/proc/${pid}/cmdline`, "utf8")); if (proc.ok && proc.value.length > 0) return proc.value.replaceAll("\0", " ").trim(); const queried = attemptSync(() => platform === "win32" ? execFileSync(resolveWindowsPowerShellPath(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); (Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`], { encoding: "utf8", timeout: 5_000, windowsHide: true }) : execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 2_000 })); if (!queried.ok) return null; const command = queried.value.trim(); return command.length > 0 ? command : null; }
export function isLocalExecDaemonProcess(pid: number, entryRealpath?: string, generationToken?: string): boolean { if (entryRealpath == null || generationToken == null) return false; const identity = readProcessIdentity(pid); return identity != null && commandCarriesLocalExecGeneration(identity.command, entryRealpath, generationToken); }
export { commandCarriesLocalExecGeneration, LOCAL_EXEC_GENERATION_TOKEN_ARG, LOCAL_EXEC_GENERATION_TOKEN_ENV };
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
export class LocalExecTerminationTimeoutError extends Error { constructor(readonly pid: number) { super(`local-exec process ${pid} remained alive after termination timeout`); this.name = "LocalExecTerminationTimeoutError"; } }
export class LocalExecTerminationSignalError extends Error { constructor(readonly pid: number, readonly code: string | undefined, cause: unknown) { super(`local-exec process ${pid} could not be signalled${code == null ? "" : ` (${code})`}`, { cause }); this.name = "LocalExecTerminationSignalError"; } }
export class LocalExecTerminationIdentityError extends Error { constructor(readonly pid: number, message: string) { super(`local-exec process ${pid} ${message}`); this.name = "LocalExecTerminationIdentityError"; } }
export async function waitForProcessExit(pid: number, deps: { readonly isAlive?: (pid: number) => boolean; readonly delay?: (ms: number) => Promise<void> } = {}): Promise<void> { const alive = deps.isAlive ?? isProcessAlive; const wait = deps.delay ?? delay; for (let attempt = 0; attempt < 40; attempt += 1) { if (!alive(pid)) return; await wait(100); } if (alive(pid)) throw new LocalExecTerminationTimeoutError(pid); }

export async function waitForWindowsProcessExit(
  pid: number,
  deps: {
    readonly isAlive?: (pid: number) => boolean;
    readonly readIdentity?: (pid: number) => LocalExecProcessIdentity | null;
    readonly delay?: (ms: number) => Promise<void>;
    readonly expectedIdentity?: LocalExecProcessIdentity;
  } = {},
): Promise<void> {
  const alive = deps.isAlive ?? isProcessAlive;
  const identity = deps.readIdentity ?? ((candidate) => readProcessIdentity(candidate, "win32"));
  const wait = deps.delay ?? delay;
  const expected = deps.expectedIdentity;
  const hasExited = (): boolean => {
    const observed = identity(pid);
    if (expected != null && observed != null && !sameNativeProcessIdentity(observed, expected)) return true;
    return !alive(pid) && observed == null;
  };
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (hasExited()) return;
    await wait(100);
  }
  if (!hasExited()) throw new LocalExecTerminationTimeoutError(pid);
}

export async function terminateProcess(
  pid: number,
  deps: {
    readonly waitForExit?: (pid: number) => Promise<void>;
    readonly reportFailure?: (error: unknown) => void;
    readonly platform?: NodeJS.Platform;
    readonly execFileSync?: typeof execFileSync;
    readonly environment?: NodeJS.ProcessEnv;
    readonly expectedIdentity?: LocalExecProcessIdentity;
    readonly readIdentity?: (pid: number) => LocalExecProcessIdentity | null;
    readonly isAlive?: (pid: number) => boolean;
    readonly ownedChild?: Pick<ChildProcess, "pid" | "exitCode" | "signalCode" | "kill" | "once" | "off">;
    readonly allowUnidentifiedOwnedEscalation?: boolean;
    readonly isUnidentifiedProcessStillOwned?: () => boolean;
  } = {},
): Promise<void> {
  const platform = deps.platform ?? process.platform;
  const alive = deps.isAlive ?? isProcessAlive;
  const readIdentity = deps.readIdentity ?? ((candidate: number) => readProcessIdentity(
    candidate,
    platform,
    {
      ...(deps.execFileSync === undefined ? {} : { execFileSync: deps.execFileSync }),
      ...(deps.environment === undefined ? {} : { environment: deps.environment }),
    },
  ));
  const expected = deps.expectedIdentity;
  const ownedChild = deps.ownedChild;
  const reportFailure = deps.reportFailure ?? ((failure: unknown) => reportLocalExecTerminationFailed(pid, failure));
  const unidentifiedOwnership = deps.isUnidentifiedProcessStillOwned;
  if (ownedChild == null) {
    throw new LocalExecTerminationIdentityError(pid, "has no retained child-process handle, so PID-only termination is forbidden");
  }
  if (ownedChild.pid !== pid) {
    throw new LocalExecTerminationIdentityError(pid, "does not match the retained child-process handle");
  }
  if (expected == null && deps.allowUnidentifiedOwnedEscalation === true) {
    if (unidentifiedOwnership == null) {
      throw new LocalExecTerminationIdentityError(pid, "requires an owned-child liveness proof before unidentified escalation");
    }
    if (!unidentifiedOwnership()) return;
  }
  const expectedExitConfirmed = (): boolean => {
    const observed = readIdentity(pid);
    if (expected != null && observed != null && !sameNativeProcessIdentity(observed, expected)) return true;
    return observed == null && !alive(pid);
  };
  const signalOwnedChild = (signalName: NodeJS.Signals): void => {
    if (ownedChild.exitCode !== null || ownedChild.signalCode !== null) return;
    if (!ownedChild.kill(signalName) && ownedChild.exitCode === null && ownedChild.signalCode === null) {
      throw new Error(`retained child-process handle refused ${signalName}`);
    }
  };
  const waitForOwnedChildExit = async (): Promise<void> => {
    if (ownedChild.exitCode !== null || ownedChild.signalCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const onExit = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        ownedChild.off("exit", onExit);
        reject(new LocalExecTerminationTimeoutError(pid));
      }, 5_000);
      timer.unref?.();
      ownedChild.once("exit", onExit);
    });
  };

  if (expected != null) {
    const observed = readIdentity(pid);
    if (observed == null) {
      if (ownedChild?.exitCode !== null || ownedChild?.signalCode !== null || !alive(pid)) return;
      throw new LocalExecTerminationIdentityError(pid, "remained alive but its identity could not be verified before owned-handle termination");
    }
    if (!sameNativeProcessIdentity(observed, expected)) {
      throw new LocalExecTerminationIdentityError(pid, "changed identity before owned-handle termination");
    }
  }

  try {
    signalOwnedChild("SIGTERM");
  } catch (error) {
    const code = findSystemErrno(error);
    if (code === "ESRCH" || expectedExitConfirmed()) return;
    reportFailure(error);
    throw new LocalExecTerminationSignalError(pid, code, error);
  }

  const waitForExit = deps.waitForExit ?? (async () => waitForOwnedChildExit());
  try {
    await waitForExit(pid);
    return;
  } catch (error) {
    if (
      platform === "win32"
      || !(error instanceof LocalExecTerminationTimeoutError)
      || (expected == null && deps.allowUnidentifiedOwnedEscalation !== true)
    ) throw error;
  }

  if (expected != null) {
    const observed = readIdentity(pid);
    if (observed == null) {
      if (ownedChild?.exitCode !== null || ownedChild?.signalCode !== null || !alive(pid)) return;
      throw new LocalExecTerminationIdentityError(pid, "remained alive but its identity could not be verified before SIGKILL escalation");
    }
    if (!sameNativeProcessIdentity(observed, expected)) return;
  } else if (unidentifiedOwnership?.() !== true) {
    return;
  }
  try {
    signalOwnedChild("SIGKILL");
  } catch (error) {
    const code = findSystemErrno(error);
    if (code === "ESRCH" || expectedExitConfirmed()) return;
    reportFailure(error);
    throw new LocalExecTerminationSignalError(pid, code, error);
  }
  await waitForExit(pid);
}
export async function spawnLocalExecDaemon(args: { readonly logPath: string; readonly env: NodeJS.ProcessEnv; readonly mainPath?: string; readonly spawnImpl?: typeof spawn; readonly generationToken?: string; readonly realpath?: typeof realpathSync; readonly open?: typeof openSync; readonly close?: typeof closeSync }): Promise<SpawnedLocalExecDaemon> { await mkdir(dirname(args.logPath), { recursive: true }); const entryRealpath = resolveLocalExecDaemonEntryRealpath(args.mainPath ?? daemonMainPath(), args.realpath ?? realpathSync); const generationToken = args.generationToken ?? randomUUID(); if (generationToken.length === 0) throw new Error("local-exec generation token must not be empty"); const logFd = (args.open ?? openSync)(args.logPath, "a"); try { const child = (args.spawnImpl ?? spawn)(process.execPath, [entryRealpath, `${LOCAL_EXEC_GENERATION_TOKEN_ARG}${generationToken}`], { detached: true, stdio: ["ignore", logFd, logFd], env: { ...process.env, ...args.env, [LOCAL_EXEC_GENERATION_TOKEN_ENV]: generationToken } }); const spawnedAt = performance.now(); let spawnSucceeded = false; child.once("error", (error) => reportLocalExecSpawnFailed(error)); child.once("spawn", () => { spawnSucceeded = true; reportLocalExecSpawned(child.pid); }); child.once("exit", (exitCode, signal) => { if (spawnSucceeded) reportLocalExecExited({ ...(child.pid === undefined ? {} : { pid: child.pid }), exitCode, signal, uptimeMs: performance.now() - spawnedAt }); }); child.unref(); return { child, entryRealpath, generationToken }; } finally { (args.close ?? closeSync)(logFd); } }
export async function killLocalExecDaemon(discoveryPath: string, deps: { readonly expectedEntryRealpath?: string; readonly readIdentity?: typeof readProcessIdentity; readonly terminate?: (pid: number) => Promise<void>; readonly now?: () => number } = {}): Promise<void> { const existing = await readLocalExecDaemonDiscovery(discoveryPath); if (existing == null || existing.entryRealpath == null || existing.generationToken == null) return; const expectedEntryRealpath = deps.expectedEntryRealpath ?? realpathSync(daemonMainPath()); if (existing.entryRealpath !== expectedEntryRealpath) return; const observed = (deps.readIdentity ?? readProcessIdentity)(existing.pid); if (observed == null || !localExecDiscoveryTimeMatchesProcess(existing.startedAt, observed.startEpochMs, (deps.now ?? Date.now)()) || !commandCarriesLocalExecGeneration(observed.command, expectedEntryRealpath, existing.generationToken)) return; if (deps.terminate != null) await deps.terminate(existing.pid); else await terminateProcess(existing.pid, { expectedIdentity: observed }); }
