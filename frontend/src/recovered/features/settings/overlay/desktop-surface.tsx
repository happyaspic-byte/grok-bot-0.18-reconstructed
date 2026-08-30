import { useCallback, useEffect, useState } from "react";
// @evidence src/app/dist/renderer/assets/index-BlqerJhg.js#byteOffset=36041 (released Settings Retry copy)
import type { ProductionCoordinatorClient } from "../../../../production/coordinator-client";
// @evidence src/app/dist/renderer/assets/index-BlqerJhg.js#L1
import type { DesktopBridge, DesktopUpdateStatus, ThemePreference } from "../../../contracts/desktop-bridge";
import {
  accountStateFromCursorStatus,
  cursorAuthErrorMessage,
  installUpdate,
  loadSettingsDesktopSnapshot,
  loadUsageState,
  cancelUsageTrial,
  checkForUpdatesWithRecovery,
  runAccountAction,
  runUsageUpgradeAction,
  runUsageUpgradeActionAndRefresh,
  saveAutoReviewSettings,
  setLocalToolPermission,
  setSecurityKeyEnabled,
  setEgressTunnelEnabled,
  setThemePreference,
  setTimeZoneOverride,
  subscribeToSettingsDesktop,
  egressTunnelFeatureGateEnabled,
  normalizeEgressTunnelStatus,
  shouldShowUsageSettings,
  usagePageFeatureGateEnabled,
  usageMetersFromSummary,
  type SettingsDesktopSnapshot
} from "./desktop";
import { GeneralSettingsPanel, RouterSettingsPanel, UpdatesSettingsPanel, UsageSettingsPanel, type RouterBoxRuntimeMode, type RouterBoxRuntimeState } from "./panels";
import { SettingsModalShell, type SettingsSectionId } from "./view";
import { DEFAULT_ROUTER_PROVIDER, isRouterProviderId, type RouterProviderId } from "./router";
import type { CliProxyStatus } from "../../../../../../source/shared/cli-proxy";
import type { AutoReviewSettings } from "./auto-review";
import type { SettingsComputerMount } from "./computer";
import { SettingsNoticeView, settingsNoticeFromEvent, type SettingsNotice } from "./notice";
import { publishSurfaceNotice, type SettingsNoticeEvent } from "../../../contracts/surface-notice";
import { SandButton } from "../../../ui/sand-kit-primitives";

const SETTINGS_FALLBACK_LABELS = { retry: "Retry" };
const LOCAL_WORKSPACE_CHANGED_EVENT = "sand-local-workspace-changed";

function normalizeRouterBoxRuntimeState(value: unknown): RouterBoxRuntimeState {
  if (typeof value !== "object" || value == null || Array.isArray(value)) throw new Error("Docker runtime returned an invalid status.");
  const record = value as Record<string, unknown>;
  if (record.mode !== "remote" && record.mode !== "local-docker") throw new Error("Docker runtime returned an unknown mode.");
  const rawStatus = record.status;
  if (typeof rawStatus !== "object" || rawStatus == null || Array.isArray(rawStatus)) return { mode: record.mode, status: null };
  const status = rawStatus as Record<string, unknown>;
  if (typeof status.available !== "boolean" || typeof status.running !== "boolean" || typeof status.ready !== "boolean"
    || typeof status.containerName !== "string" || typeof status.image !== "string" || typeof status.detail !== "string") {
    return { mode: record.mode, status: null };
  }
  return {
    mode: record.mode,
    status: {
      available: status.available,
      running: status.running,
      ready: status.ready,
      containerName: status.containerName,
      image: status.image,
      detail: status.detail
    }
  };
}

export interface SettingsDesktopSurfaceProps {
  bridge: DesktopBridge;
  coordinatorClient?: ProductionCoordinatorClient | null;
  initialSection?: SettingsSectionId;
  isOpen: boolean;
  onClose(): void;
  onNotice?(event: SettingsNoticeEvent): void;
  onStatus?(status: string): void;
  /** Root-owned computer rebuild state/actions; omitted until the root owner mounts the handoff. */
  computer?: SettingsComputerMount;
}

export function SettingsDesktopSurface({ bridge, coordinatorClient = null, initialSection = "general", isOpen, onClose, onNotice, onStatus, computer }: SettingsDesktopSurfaceProps) {
  const [snapshot, setSnapshot] = useState<SettingsDesktopSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [surfaceNotice, setSurfaceNotice] = useState<SettingsNotice | null>(null);
  const [cancelTrialDialogOpen, setCancelTrialDialogOpen] = useState(false);
  const [routerProvider, setRouterProvider] = useState<RouterProviderId>(DEFAULT_ROUTER_PROVIDER);
  const [routerPending, setRouterPending] = useState(false);
  const [boxRuntime, setBoxRuntime] = useState<RouterBoxRuntimeState | null>(null);
  const [boxRuntimePending, setBoxRuntimePending] = useState(false);
  const [boxRuntimeError, setBoxRuntimeError] = useState<string | null>(null);
  const [cliProxyStatus, setCliProxyStatus] = useState<CliProxyStatus | null>(null);
  const [cliProxyPending, setCliProxyPending] = useState(false);
  const handleCancelTrialDialogOpen = useCallback((open: boolean) => setCancelTrialDialogOpen(open), []);
  const handleNotice = useCallback((event: SettingsNoticeEvent) => {
    setSurfaceNotice(settingsNoticeFromEvent(event));
    onNotice?.(event);
  }, [onNotice]);
  const refreshLocalWorkspace = useCallback(async () => {
    try { await bridge.forceGatewayReconnect(); } catch {}
    window.dispatchEvent(new Event(LOCAL_WORKSPACE_CHANGED_EVENT));
  }, [bridge]);

  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    setBoxRuntimeError(null);
    let unsubscribe = () => {};
    setSnapshot(null);
    setError(null);
    const refreshEgressAvailability = () => {
      if (coordinatorClient == null) return;
      void coordinatorClient.isEgressTunnelAvailable().then((available) => {
        if (!active) return;
        setSnapshot((current) => current == null ? current : { ...current, egressTunnel: { ...current.egressTunnel, available } });
      }).catch(() => {
        // The shipped capability store keeps the last value on a failed reread.
      });
    };
    void loadSettingsDesktopSnapshot(bridge, coordinatorClient ?? undefined).then((value) => {
      if (!active) return;
      setSnapshot(value);
      unsubscribe = subscribeToSettingsDesktop(bridge, {
        account: (status) => {
          setSnapshot((current) => current == null ? current : {
            ...current,
            account: accountStateFromCursorStatus(
              status,
              current.account.kind === "logged-in" ? current.account.avatarDataUrl : undefined
            ),
            accountPending: current.accountPending,
            accountError: status.kind === "logged-out" ? status.errorMessage ?? null : null
          });
          refreshEgressAvailability();
        },
        theme: (state) => setSnapshot((current) => current == null ? current : { ...current, theme: state.preference }),
        update: (update) => setSnapshot((current) => current == null ? current : { ...current, update }),
        securityKey: updateSecurityKey,
        experiments: (experimentSnapshot) => setSnapshot((current) => current == null ? current : {
          ...current,
          usagePageFeatureGateEnabled: usagePageFeatureGateEnabled(experimentSnapshot),
          egressTunnel: { ...current.egressTunnel, featureGateEnabled: egressTunnelFeatureGateEnabled(experimentSnapshot) }
        }),
        egressTunnel: (enabled) => setSnapshot((current) => current == null ? current : {
          ...current,
          egressTunnel: { ...current.egressTunnel, enabled }
        }),
        egressTunnelStatus: (status) => setSnapshot((current) => current == null ? current : {
          ...current,
          egressTunnel: { ...current.egressTunnel, status: normalizeEgressTunnelStatus(status) }
        })
      });
      const unsubscribeCoordinator = coordinatorClient?.subscribeTransport((state) => {
        if (state === "connected") refreshEgressAvailability();
      });
      const previousUnsubscribe = unsubscribe;
      unsubscribe = () => {
        previousUnsubscribe();
        unsubscribeCoordinator?.();
      };
    }).catch((reason: unknown) => {
      if (!active) return;
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      publishSurfaceNotice({ kind: "error", operation: "settings-load", message }, handleNotice, onStatus);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [bridge, coordinatorClient, handleNotice, isOpen, onStatus, reload]);

  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    void bridge.agent.getInferenceRouter().then((value) => {
      const provider = typeof value === "object" && value != null && "provider" in value ? value.provider : null;
      if (active) setRouterProvider(isRouterProviderId(provider) ? provider : DEFAULT_ROUTER_PROVIDER);
    }).catch(() => {
      if (active) setRouterProvider(DEFAULT_ROUTER_PROVIDER);
    });
    void bridge.cliProxy.status().then((status) => { if (active) setCliProxyStatus(status); }).catch(() => { if (active) setCliProxyStatus(null); });
    void bridge.agent.getBoxRuntime().then((status) => {
      if (active) setBoxRuntime(normalizeRouterBoxRuntimeState(status));
    }).catch((reason: unknown) => {
      if (!active) return;
      setBoxRuntime(null);
      setBoxRuntimeError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { active = false; };
  }, [bridge, isOpen]);

  const mutate = async <Value,>(action: () => Promise<Value>, operation: SettingsNoticeEvent["operation"], apply: (value: Value) => void): Promise<Value> => {
    try {
      const value = await action();
      apply(value);
      return value;
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      publishSurfaceNotice({ kind: "error", operation, message }, handleNotice, onStatus);
      throw reason;
    }
  };

  const updateSnapshot = (update: DesktopUpdateStatus) => setSnapshot((current) => current == null ? current : { ...current, update });
  const updateTheme = (theme: ThemePreference) => setSnapshot((current) => current == null ? current : { ...current, theme });
  const updateTimeZone = (timeZone: SettingsDesktopSnapshot["timeZone"]) => setSnapshot((current) => current == null ? current : { ...current, timeZone });
  const updateLocalToolPermission = (permission: SettingsDesktopSnapshot["localToolPermission"]["permission"]) => setSnapshot((current) => current == null ? current : {
    ...current,
    localToolPermission: { ...current.localToolPermission, permission }
  });
  const updateSecurityKey = (securityKeyEnabled: boolean) => setSnapshot((current) => current == null ? current : { ...current, securityKeyEnabled });
  const updateAutoReview = (autoReview: AutoReviewSettings) => setSnapshot((current) => current == null ? current : { ...current, autoReview });
  const refreshUsage = async () => {
    const previous = snapshot?.usage;
    setSnapshot((current) => current == null ? current : {
      ...current,
      usage: { status: "loading", summary: current.usage.summary },
      usageSummary: current.usage.summary
    });
    const usage = await loadUsageState(bridge, previous);
    setSnapshot((current) => current == null ? current : { ...current, usage, usageSummary: usage.summary });
  };

  return (
    <>
      <SettingsNoticeView notice={surfaceNotice} onDismiss={() => setSurfaceNotice(null)} />
      <SettingsModalShell
      initialSection={initialSection}
      isOpen={isOpen}
      onClose={onClose}
      renderSection={(section: SettingsSectionId) => {
        // Router configuration is intentionally independent from the signed-in
        // settings snapshot so a fresh profile can configure 9Router first.
        if (section === "router") return (
          <RouterSettingsPanel
            boxRuntime={{
              state: boxRuntime,
              pending: boxRuntimePending,
              error: boxRuntimeError,
              onChange: async (mode) => {
                if (boxRuntimePending || boxRuntime?.mode === mode) return;
                setBoxRuntimePending(true);
                setBoxRuntimeError(null);
                try {
                  const result = normalizeRouterBoxRuntimeState(await bridge.agent.setBoxRuntime(mode));
                  setBoxRuntime(result);
                  await refreshLocalWorkspace();
                } catch (reason) {
                  const message = reason instanceof Error ? reason.message : String(reason);
                  setBoxRuntimeError(message);
                  publishSurfaceNotice({ kind: "error", operation: "settings-router-provider", message }, handleNotice, onStatus);
                } finally {
                  setBoxRuntimePending(false);
                }
              }
            }}
            cliProxy={{
              status: cliProxyStatus,
              pending: cliProxyPending,
              onSave: async (config) => {
                setCliProxyPending(true);
                try {
                  setCliProxyStatus(await bridge.cliProxy.save(config));
                  await refreshLocalWorkspace();
                }
                catch (reason) {
                  const message = reason instanceof Error ? reason.message : String(reason);
                  publishSurfaceNotice({ kind: "error", operation: "settings-router-provider", message }, handleNotice, onStatus);
                  throw reason;
                } finally { setCliProxyPending(false); }
              },
              onDelete: async () => {
                setCliProxyPending(true);
                try {
                  setCliProxyStatus(await bridge.cliProxy.remove());
                  await refreshLocalWorkspace();
                }
                catch (reason) {
                  const message = reason instanceof Error ? reason.message : String(reason);
                  publishSurfaceNotice({ kind: "error", operation: "settings-router-provider", message }, handleNotice, onStatus);
                  throw reason;
                } finally { setCliProxyPending(false); }
              },
              onTest: async () => {
                setCliProxyPending(true);
                try { setCliProxyStatus(await bridge.cliProxy.status({ testConnection: true })); }
                catch (reason) {
                  const message = reason instanceof Error ? reason.message : String(reason);
                  publishSurfaceNotice({ kind: "error", operation: "settings-router-provider", message }, handleNotice, onStatus);
                  throw reason;
                } finally { setCliProxyPending(false); }
              }
            }}
            onChange={async (provider) => {
              if (routerPending || provider === routerProvider) return;
              const previous = routerProvider;
              setRouterProvider(provider);
              setRouterPending(true);
              try {
                const result = await bridge.agent.setInferenceRouter(provider);
                const applied = typeof result === "object" && result != null && "provider" in result ? result.provider : provider;
                if (!isRouterProviderId(applied)) throw new Error("Router returned an unknown provider.");
                setRouterProvider(applied);
                await refreshLocalWorkspace();
              } catch (reason) {
                setRouterProvider(previous);
                const message = reason instanceof Error ? reason.message : String(reason);
                publishSurfaceNotice({ kind: "error", operation: "settings-router-provider", message }, handleNotice, onStatus);
              } finally {
                setRouterPending(false);
              }
            }}
            pending={routerPending}
            provider={routerProvider}
          />
        );
        if (snapshot == null) return (
          <div aria-live="polite" role={error == null ? "status" : "alert"}>
            {error == null ? null : <>
              <span>{error}</span>
              <SandButton aria-label="Retry" onClick={() => setReload((value) => value + 1)} size="sm" variant="secondary">{SETTINGS_FALLBACK_LABELS.retry}</SandButton>
            </>}
          </div>
        );
        if (section === "general") return (
          <GeneralSettingsPanel
            account={snapshot.account}
            autoReview={{
              settings: snapshot.autoReview,
              onChange: (settings) => mutate(() => saveAutoReviewSettings(bridge, settings), "settings-auto-review", updateAutoReview)
            }}
            accountError={snapshot.accountError}
            accountPending={snapshot.accountPending}
            platform={bridge.platform === "win32" ? "windows" : "mac"}
            onAccountAction={() => {
              setSnapshot((current) => current == null ? current : { ...current, accountPending: true, accountError: null });
              void mutate(() => runAccountAction(bridge, snapshot.account), "settings-account", (status) => {
                setSnapshot((current) => current == null ? current : {
                  ...current,
                  account: accountStateFromCursorStatus(status, current.account.kind === "logged-in" ? current.account.avatarDataUrl : undefined),
                  accountPending: false,
                  accountError: status.kind === "logged-out" ? status.errorMessage ?? null : null
                });
              }).catch((reason: unknown) => {
                setSnapshot((current) => current == null ? current : {
                  ...current,
                  accountPending: false,
                  accountError: cursorAuthErrorMessage(reason)
                });
              });
            }}
            onThemeChange={(theme) => mutate(() => setThemePreference(bridge, theme), "settings-theme", (state) => updateTheme(state.preference))}
            localToolPermission={{
              state: snapshot.localToolPermission,
              onChange: (permission) => mutate(() => setLocalToolPermission(bridge, permission), "settings-local-tool-permission", updateLocalToolPermission)
            }}
            securityKey={{
              enabled: snapshot.securityKeyEnabled,
              onChange: (enabled) => mutate(() => setSecurityKeyEnabled(bridge, enabled), "settings-security-key", updateSecurityKey),
              platform: bridge.platform
            }}
            timeZone={{
              state: snapshot.timeZone,
              onChange: (timeZone) => mutate(() => setTimeZoneOverride(bridge, timeZone), "settings-time-zone", updateTimeZone)
            }}
            theme={snapshot.theme}
          />
        );
        if (section === "usage") return (
          <UsageSettingsPanel
            meters={usageMetersFromSummary(snapshot.usageSummary)}
            onCancelDialogOpen={handleCancelTrialDialogOpen}
            onCancelTrial={() => mutate(() => cancelUsageTrial(bridge), "settings-usage-cancel-trial", (usage) => {
              if (usage.ok) refreshUsage();
            })}
            onRetry={refreshUsage}
            onUpgrade={(action) => runUsageUpgradeActionAndRefresh(bridge, action, refreshUsage)}
            state={snapshot.usage}
            provider={routerProvider}
          />
        );
        return (
          <UpdatesSettingsPanel
            autoUpdateWhenIdle={snapshot.update?.autoUpdateWhenIdleOptIn ?? false}
            availableTracks={snapshot.update?.availableTracks ?? []}
            onCheck={() => checkForUpdatesWithRecovery(bridge, updateSnapshot).catch((reason: unknown) => {
              const message = reason instanceof Error ? reason.message : String(reason);
              publishSurfaceNotice({ kind: "error", operation: "settings-update-check", message }, handleNotice, onStatus);
              throw reason;
            })}
            onInstall={() => mutate(() => installUpdate(bridge), "settings-update-install", () => {})}
            onSetAutoUpdateWhenIdle={(enabled) => mutate(() => bridge.update.setAutoUpdateWhenIdleOptIn(enabled), "settings-update-auto-update-when-idle", updateSnapshot)}
            onSetTrack={(track) => mutate(() => bridge.update.setTrack(track), "settings-update-track", updateSnapshot)}
            egressTunnel={{
              available: snapshot.egressTunnel.available,
              enabled: snapshot.egressTunnel.enabled,
              featureGateEnabled: snapshot.egressTunnel.featureGateEnabled,
              onChange: (enabled) => setEgressTunnelEnabled(bridge, enabled).then((nextEnabled) => {
                setSnapshot((current) => current == null ? current : {
                  ...current,
                  egressTunnel: { ...current.egressTunnel, enabled: nextEnabled }
                });
                return nextEnabled;
              }),
              status: snapshot.egressTunnel.status
            }}
            computer={computer}
            status={snapshot.update}
          />
        );
      }}
      showUsage={snapshot != null && (routerProvider !== "cursor" || shouldShowUsageSettings(snapshot.usagePageFeatureGateEnabled, snapshot.usage))}
      iconPlatform={bridge.platform === "win32" ? "windows" : "mac"}
      closeOnBackdrop={!cancelTrialDialogOpen}
      closeOnEscape={!cancelTrialDialogOpen}
      trapFocus={!cancelTrialDialogOpen}
      />
    </>
  );
}
