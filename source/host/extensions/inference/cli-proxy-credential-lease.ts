import {
  normalizeCliProxyTurnConfig,
  type CliProxyTurnConfig,
} from "../../../shared/cli-proxy.js";

export const CLI_PROXY_CREDENTIAL_LEASE_TTL_MS = 30 * 60 * 1_000;

type InstalledLease = {
  readonly config: CliProxyTurnConfig;
  readonly expiresAtMs: number;
};

let installedLease: InstalledLease | undefined;
let expiryTimer: ReturnType<typeof setTimeout> | undefined;

function clearExpiryTimer(): void {
  if (expiryTimer === undefined) return;
  clearTimeout(expiryTimer);
  expiryTimer = undefined;
}

function clearExpiredLease(nowMs: number): void {
  if (installedLease === undefined || installedLease.expiresAtMs > nowMs) return;
  installedLease = undefined;
  clearExpiryTimer();
}

/**
 * Installs a short-lived, memory-only credential supplied over the authenticated
 * desktop-to-host gateway. The API key is never persisted or exposed through a
 * getter on that gateway.
 */
export function installCliProxyCredentialLease(
  rawConfig: unknown,
  nowMs = Date.now(),
): { readonly expiresAtMs: number } {
  const config = Object.freeze({ ...normalizeCliProxyTurnConfig(rawConfig) });
  const expiresAtMs = nowMs + CLI_PROXY_CREDENTIAL_LEASE_TTL_MS;
  installedLease = { config, expiresAtMs };
  clearExpiryTimer();
  expiryTimer = setTimeout(() => {
    if (installedLease?.expiresAtMs === expiresAtMs) installedLease = undefined;
    expiryTimer = undefined;
  }, CLI_PROXY_CREDENTIAL_LEASE_TTL_MS);
  expiryTimer.unref?.();
  return { expiresAtMs };
}

export function hasCliProxyCredentialLease(nowMs = Date.now()): boolean {
  clearExpiredLease(nowMs);
  return installedLease !== undefined;
}

export function requireCliProxyCredentialLease(nowMs = Date.now()): CliProxyTurnConfig {
  clearExpiredLease(nowMs);
  if (installedLease === undefined) {
    throw new Error("9Router credential lease is unavailable. Reconnect it in Settings → Router.");
  }
  return installedLease.config;
}

/** Test/process-shutdown helper. It deliberately returns no prior credential. */
export function clearCliProxyCredentialLease(): void {
  installedLease = undefined;
  clearExpiryTimer();
}
