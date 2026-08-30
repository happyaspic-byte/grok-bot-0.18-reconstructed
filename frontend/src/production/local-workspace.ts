import type { CursorAuthStatus, DesktopBridge } from "../recovered/contracts/desktop-bridge";

export const LOCAL_9ROUTER_WORKSPACE_ID = "local:9router";
export const LOCAL_WORKSPACE_CHANGED_EVENT = "sand-local-workspace-changed";

export type LocalWorkspaceReadiness =
  | { readonly kind: "checking" }
  | { readonly kind: "disabled" }
  | { readonly kind: "ready"; readonly workspaceId: typeof LOCAL_9ROUTER_WORKSPACE_ID };

export type WorkspaceSession =
  | { readonly kind: "checking"; readonly accountSlot: null; readonly identity: null; readonly source: null }
  | { readonly kind: "unavailable"; readonly accountSlot: null; readonly identity: null; readonly source: null }
  | { readonly kind: "ready"; readonly accountSlot: string; readonly identity: string; readonly source: "cursor" | "local-9router" };

interface BoxRuntimeReader {
  getBoxRuntime(): Promise<unknown>;
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value != null && !Array.isArray(value) ? Reflect.get(value, key) : undefined;
}

/**
 * Reads the three existing settings surfaces concurrently. This is a renderer
 * capability check only: the main process remains responsible for launching
 * and authorizing the local coordinator.
 */
export async function readLocalWorkspaceReadiness(bridge: Pick<DesktopBridge, "agent" | "cliProxy">): Promise<LocalWorkspaceReadiness> {
  const agent = bridge.agent as typeof bridge.agent & BoxRuntimeReader;
  if (typeof agent.getBoxRuntime !== "function") return { kind: "disabled" };
  try {
    const [router, runtime, credential] = await Promise.all([
      agent.getInferenceRouter(),
      agent.getBoxRuntime(),
      bridge.cliProxy.status()
    ]);
    const model = field(credential, "model");
    const protocol = field(credential, "protocol");
    return field(router, "provider") === "cli-proxy"
      && field(runtime, "mode") === "local-docker"
      && credential.configured === true
      && typeof model === "string"
      && model.trim().length > 0
      && protocol !== "responses"
      ? { kind: "ready", workspaceId: LOCAL_9ROUTER_WORKSPACE_ID }
      : { kind: "disabled" };
  } catch {
    return { kind: "disabled" };
  }
}

export function projectWorkspaceSession(
  account: CursorAuthStatus | null,
  localWorkspace: LocalWorkspaceReadiness
): WorkspaceSession {
  if (account?.kind === "logged-in") {
    const accountSlot = account.authId ?? account.email ?? "account";
    return {
      kind: "ready",
      accountSlot,
      identity: `cursor:${accountSlot}`,
      source: "cursor"
    };
  }
  if (account == null || localWorkspace.kind === "checking") {
    return { kind: "checking", accountSlot: null, identity: null, source: null };
  }
  if (account.kind === "logging-in") {
    return { kind: "unavailable", accountSlot: null, identity: null, source: null };
  }
  if (localWorkspace.kind === "ready") {
    return {
      kind: "ready",
      accountSlot: localWorkspace.workspaceId,
      identity: localWorkspace.workspaceId,
      source: "local-9router"
    };
  }
  return { kind: "unavailable", accountSlot: null, identity: null, source: null };
}
