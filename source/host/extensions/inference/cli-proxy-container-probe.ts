import {
  normalizeCliProxyTurnConfig,
  type CliProxyTurnConfig,
} from "../../../shared/cli-proxy.js";
import {
  fetchCliProxyModels,
  type CliProxyModelsProbe,
} from "../../../shared/node/cli-proxy-models.js";
import { requireCliProxyCredentialLease } from "./cli-proxy-credential-lease.js";

export interface CliProxyContainerProbeReceipt {
  readonly outcome: CliProxyModelsProbe["outcome"];
  readonly latencyMs: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isReachabilityFailure(error: unknown): boolean {
  return /could not connect|timed out/iu.test(errorMessage(error));
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

export function cliProxyContainerProbeError(
  config: CliProxyTurnConfig,
  error: unknown,
): Error {
  if (!isReachabilityFailure(error)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  const url = new URL(config.baseUrl);
  if (isLoopbackHost(url.hostname)) {
    return new Error(
      "The Local Docker VM cannot reach a same-PC 9Router through 127.0.0.1 or ::1: container loopback points to the Docker VM, not Windows. Use the 9Router server's literal Tailscale IP on port 20128, enable Allow HTTP over Tailscale, and retry.",
      { cause: error },
    );
  }
  if (url.protocol === "http:" && config.allowTailscaleHttp) {
    return new Error(
      "The Local Docker VM could not reach 9Router over Tailscale. Confirm Docker Desktop has outbound network access, the Tailscale peer IP is current and reachable from Windows, tailnet ACLs allow port 20128, and 9Router is listening on that address.",
      { cause: error },
    );
  }
  return new Error(
    "The Local Docker VM could not reach 9Router. Confirm Docker Desktop has outbound network access and the configured endpoint is reachable from a Linux container.",
    { cause: error },
  );
}

/**
 * Runs only behind the bearer-authenticated desktop-to-host gateway. The
 * credential comes exclusively from the short-lived host memory lease; this
 * call accepts no credential/config argument and returns no credential data.
 */
export async function probeCliProxyModelsFromContainer(
  options: Parameters<typeof fetchCliProxyModels>[1] = {},
): Promise<CliProxyContainerProbeReceipt> {
  const config = Object.freeze({
    ...normalizeCliProxyTurnConfig(requireCliProxyCredentialLease()),
  });
  try {
    const probe = await fetchCliProxyModels(config, options);
    return Object.freeze({ outcome: probe.outcome, latencyMs: probe.latencyMs });
  } catch (error) {
    throw cliProxyContainerProbeError(config, error);
  }
}
