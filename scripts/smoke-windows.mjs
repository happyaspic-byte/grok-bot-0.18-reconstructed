import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import WebSocket from "ws";

import { outputWindowsPortable } from "./lib/config.mjs";
import { pathExists } from "./lib/windows-runtime.mjs";
import { verifyWindowsPortable } from "./lib/windows-package.mjs";

const execFileAsync = promisify(execFile);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const SMOKE_MODEL = "smoke/tool-capable-model";
const SECOND_SMOKE_MODEL = "smoke/secondary-model";
const SMOKE_CONTAINER = "grok-bot-local-vm";
const RETRYABLE_TEMP_CLEANUP_ERRORS = new Set(["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"]);
const childClosePromises = new WeakMap();
const childLaunchErrors = new WeakMap();

async function waitForHarnessState(predicate, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(50);
  }
  throw new Error(label);
}

async function removeTemporaryDirectory(target, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await rm(target, { recursive: true, force: true, maxRetries: 0 });
      return;
    } catch (error) {
      lastError = error;
      if (!RETRYABLE_TEMP_CLEANUP_ERRORS.has(error?.code)) throw error;
      await delay(250);
    }
  }
  throw lastError ?? new Error(`Timed out removing Windows smoke temporary directory: ${target}`);
}

function parseArguments(argv) {
  let root = outputWindowsPortable;
  let basic = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--app") {
      const value = argv[++index];
      if (!value) throw new Error("Usage: node scripts/smoke-windows.mjs [--app portable-directory] [--basic]");
      root = path.resolve(value);
    } else if (argv[index] === "--basic") basic = true;
    else throw new Error("Usage: node scripts/smoke-windows.mjs [--app portable-directory] [--basic]");
  }
  return { root, basic };
}

async function waitForDebugEndpoint(userDataDir, child, timeoutMs = 30_000) {
  const activePort = path.join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const launchError = childLaunchErrors.get(child);
    if (launchError != null) throw new Error(`Portable process failed to launch: ${launchError.message}`, { cause: launchError });
    if (child.exitCode != null) throw new Error(`Portable process exited before renderer startup (${child.exitCode})`);
    if (await pathExists(activePort)) {
      const [line] = (await readFile(activePort, "utf8")).trim().split(/\r?\n/);
      const port = Number(line);
      if (Number.isInteger(port) && port > 0 && port <= 65535) {
        try {
          const remainingMs = Math.max(1, deadline - Date.now());
          const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`, {
            signal: AbortSignal.timeout(Math.min(1_000, remainingMs)),
          })).json();
          const page = pages.find(candidate => candidate.type === "page" && typeof candidate.webSocketDebuggerUrl === "string");
          if (page != null) return page.webSocketDebuggerUrl;
        } catch {
          // Chromium may write the port before its loopback debugger is ready.
        }
      }
    }
    await delay(250);
  }
  throw new Error("Timed out waiting for the packaged renderer debugger");
}

async function connectCdp(endpoint) {
  const socket = new WebSocket(endpoint);
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out connecting to renderer debugger")), 10_000);
      socket.once("open", () => { clearTimeout(timeout); resolve(); });
      socket.once("error", error => { clearTimeout(timeout); reject(error); });
    });
  } catch (error) {
    socket.terminate();
    throw error;
  }
  let id = 0;
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for CDP ${method}`)), 10_000);
    const listener = data => {
      const message = JSON.parse(data.toString());
      if (message.id !== requestId) return;
      clearTimeout(timeout);
      socket.off("message", listener);
      if (message.error != null) reject(new Error(`CDP ${method} failed: ${JSON.stringify(message.error)}`));
      else resolve(message.result);
    };
    socket.on("message", listener);
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  const evaluate = async expression => {
    const result = await request("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result?.exceptionDetails != null) throw new Error(`Renderer evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
    return result?.result?.value;
  };
  return { request, evaluate, close: () => socket.close() };
}

async function waitForRendererState(cdp, expression, predicate, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  let lastError;
  while (Date.now() < deadline) {
    try {
      lastValue = await cdp.evaluate(expression);
      if (predicate(lastValue)) return lastValue;
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  const detail = lastError instanceof Error ? lastError.message : JSON.stringify(lastValue);
  throw new Error(`${label}: ${detail}`);
}

function processHasExited(child) {
  return child == null || child.exitCode != null || child.signalCode != null;
}

async function waitForProcessClose(child, timeoutMs = 5_000) {
  if (child == null) return;
  const closed = childClosePromises.get(child);
  if (closed == null) throw new Error("Packaged process close was not tracked from spawn");
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for packaged process close ${child.pid ?? "unknown"}`)),
      timeoutMs,
    );
    closed.then(() => { clearTimeout(timeout); resolve(); });
  });
}

async function stopProcess(child) {
  if (child == null) return;
  if (!processHasExited(child) && child.pid != null) {
    try { await execFileAsync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { timeout: 10_000, windowsHide: true }); }
    catch { if (!processHasExited(child)) child.kill(); }
  }
  await waitForProcessClose(child);
  child.stdout?.destroy();
  child.stderr?.destroy();
}

async function stopPortableGracefully(launched, { label, leaseRevoked = () => true, timeoutMs = 60_000 }) {
  const requested = await launched.cdp.evaluate(`(() => {
    const close = window.desktop?.windowControls?.close;
    if (typeof close !== 'function') return false;
    setTimeout(() => { void close.call(window.desktop.windowControls); }, 0);
    return true;
  })()`);
  if (requested !== true) throw new Error(`${label}: the packaged renderer did not expose its normal window-close path`);

  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      if (processHasExited(launched.child)) {
        if (launched.child.signalCode != null || launched.child.exitCode !== 0) {
          throw new Error(`the packaged process did not exit cleanly (code=${launched.child.exitCode}, signal=${launched.child.signalCode})`);
        }
        if (!leaseRevoked()) throw new Error("the process exited before its final 9Router credential lease revocation was acknowledged");
        await waitForProcessClose(launched.child);
        launched.cdp.close();
        return;
      }
      await delay(100);
    }
    throw new Error(`timed out after ${timeoutMs} ms`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    let cleanupDetail = "";
    try { await stopProcess(launched.child); }
    catch (cleanupError) { cleanupDetail = `, which also failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`; }
    throw new Error(`${label}: ${detail}; taskkill was used only as failure cleanup${cleanupDetail}`, { cause: error });
  }
}

function appendBoundedLog(logs, chunk) {
  const value = chunk.toString();
  const currentSize = logs.reduce((sum, entry) => sum + entry.length, 0);
  if (currentSize < 1024 * 1024) logs.push(value.slice(0, 1024 * 1024 - currentSize));
}

async function launchPortable(verified, environment, userDataDir, logs, onLaunch = () => {}) {
  await rm(path.join(userDataDir, "DevToolsActivePort"), { force: true }).catch(() => undefined);
  const child = spawn(verified.executable, [
    `--user-data-dir=${userDataDir}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    "--disable-gpu",
    "--no-first-run",
  ], {
    cwd: verified.outputRoot,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  childClosePromises.set(child, new Promise(resolve => child.once("close", () => resolve())));
  child.once("error", error => childLaunchErrors.set(child, error));
  const launched = { child, cdp: undefined };
  // Publish ownership immediately: failures while discovering or mounting the
  // renderer must not orphan an Electron process that still owns this profile.
  onLaunch(launched);
  for (const stream of [child.stdout, child.stderr]) stream?.on("data", chunk => appendBoundedLog(logs, chunk));
  const cdp = await connectCdp(await waitForDebugEndpoint(userDataDir, child));
  launched.cdp = cdp;
  await waitForRendererState(
    cdp,
    `(() => ({ readyState: document.readyState, title: document.title, text: document.body?.innerText ?? "", rootChildren: document.getElementById("root")?.childElementCount ?? 0 }))()`,
    value => value?.readyState === "complete" && value.rootChildren > 0,
    "Packaged clean renderer did not mount",
  );
  return launched;
}

async function openRouterSettings(cdp) {
  return await waitForRendererState(
    cdp,
    `(() => { const visible = node => node.isConnected && node.getClientRects().length > 0 && !node.disabled; const candidates = [...document.querySelectorAll('button,[role="button"]')]; const configure = candidates.find(node => visible(node) && (/^configure 9router$/i.test((node.textContent ?? '').trim()) || /^configure 9router$/i.test(node.getAttribute('aria-label') ?? ''))); configure?.click(); return { clicked: configure != null, controls: candidates.filter(visible).map(node => [node.textContent?.trim(), node.getAttribute('aria-label')].filter(Boolean).join(' | ')).filter(Boolean).slice(0, 60) }; })()`,
    value => value?.clicked === true,
    "Fresh isolated profile did not expose the credential-independent 9Router setup",
  );
}

async function select9RouterProvider(cdp) {
  await waitForRendererState(
    cdp,
    `(() => { const visible = node => node.isConnected && node.getClientRects().length > 0 && !node.disabled; const candidates = [...document.querySelectorAll('[aria-label],button,[role="button"]')]; const provider = candidates.find(node => visible(node) && /^router provider$/i.test(node.getAttribute('aria-label') ?? '')); provider?.click(); return { clicked: provider != null, controls: candidates.filter(visible).map(node => [node.textContent?.trim(), node.getAttribute('aria-label')].filter(Boolean).join(' | ')).filter(Boolean).slice(0, 60) }; })()`,
    value => value?.clicked === true,
    "Router settings did not expose the provider selector",
  );
  await waitForRendererState(
    cdp,
    `(() => { const visible = node => node.isConnected && node.getClientRects().length > 0 && !node.disabled; const candidates = [...document.querySelectorAll('button,[role="option"],[role="menuitem"],[role="radio"]')]; const option = candidates.find(node => visible(node) && (node.textContent ?? '').trim().toLowerCase() === 'openai-compatible / 9router'); option?.click(); return { clicked: option != null, controls: candidates.filter(visible).map(node => [node.textContent?.trim(), node.getAttribute('aria-label')].filter(Boolean).join(' | ')).filter(Boolean).slice(0, 60) }; })()`,
    value => value?.clicked === true,
    "Router provider selector did not expose the 9Router option",
  );
  await waitForRendererState(
    cdp,
    `(async () => { const input = document.querySelector('input[aria-label="9Router Base URL"]'); const state = await window.desktop.agent.getInferenceRouter(); return { provider: state?.provider ?? null, hasEditableBaseUrl: input instanceof HTMLInputElement && !input.disabled && !input.readOnly, baseUrl: input instanceof HTMLInputElement ? input.value : null, text: document.body?.innerText ?? "" }; })()`,
    value => value?.provider === "cli-proxy" && value.hasEditableBaseUrl === true && /9Router connection/i.test(value.text ?? ""),
    "Fresh isolated profile cannot select 9Router or edit its Base URL",
  );
}

function setInputsExpression(values) {
  return `(() => {
    const setValue = (label, value) => {
      const input = document.querySelector('input[aria-label="' + label + '"]');
      if (!(input instanceof HTMLInputElement) || input.disabled || input.readOnly) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (typeof setter !== 'function') return false;
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return input.value === value;
    };
    const values = ${JSON.stringify(values)};
    return Object.fromEntries(Object.entries(values).map(([label, value]) => [label, setValue(label, value)]));
  })()`;
}

function clickButtonExpression(label) {
  return `(() => {
    const visible = node => node.isConnected && node.getClientRects().length > 0 && !node.disabled;
    const button = [...document.querySelectorAll('button,[role="button"]')].find(node => visible(node) && (node.textContent ?? '').trim() === ${JSON.stringify(label)});
    button?.click();
    return { clicked: button != null, disabled: button?.disabled ?? null };
  })()`;
}

async function clickButton(cdp, label, failureLabel) {
  await waitForRendererState(cdp, clickButtonExpression(label), value => value?.clicked === true, failureLabel);
}

async function closeSettings(cdp) {
  await waitForRendererState(
    cdp,
    `(() => { const dialog = document.querySelector('[role="dialog"][aria-label="Grok Bot settings"]'); const close = dialog?.querySelector('button[aria-label="Close"]'); if (close instanceof HTMLButtonElement && !close.disabled) close.click(); return { clicked: close instanceof HTMLButtonElement, dialog: dialog != null }; })()`,
    value => value?.clicked === true,
    "Router settings could not be closed",
  );
  await waitForRendererState(cdp, `document.querySelector('[role="dialog"][aria-label="Grok Bot settings"]') == null`, value => value === true, "Router settings remained open");
}

async function assertSignedOutLanding(cdp, label) {
  return await waitForRendererState(
    cdp,
    `(async () => { const visible = node => node != null && node.isConnected && node.getClientRects().length > 0; const auth = await window.desktop.cursorAccount.getStatus(); const landing = document.querySelector('[role="main"][aria-label="Grok Bot"]'); const configure = document.querySelector('button[aria-label="Configure 9Router"]'); return { authKind: auth?.kind ?? null, landing: visible(landing), configure: visible(configure) }; })()`,
    value => value?.authKind === "logged-out" && value.landing === true && value.configure === true,
    label,
  );
}

async function assertLoginFreeWorkspace(cdp, expectedBaseUrl, { probe = false } = {}) {
  const expression = `(async () => {
    const visible = node => node != null && node.isConnected && node.getClientRects().length > 0 && !node.disabled;
    const [auth, router, runtime, credential] = await Promise.all([
      window.desktop.cursorAccount.getStatus(),
      window.desktop.agent.getInferenceRouter(),
      window.desktop.agent.getBoxRuntime(),
      window.desktop.cliProxy.status(${probe ? "{ testConnection: true }" : ""}),
    ]);
    const landing = document.querySelector('[role="main"][aria-label="Grok Bot"]');
    const configure = document.querySelector('button[aria-label="Configure 9Router"]');
    const create = document.querySelector('button[aria-label="New"]');
    const connected = document.querySelector('[role="status"][aria-label="Connected"]');
    const emptyWorkspace = document.querySelector('main[aria-label="New chat"]');
    const shell = document.querySelector('.sand-shell');
    return {
      authKind: auth?.kind ?? null,
      provider: router?.provider ?? null,
      runtimeMode: runtime?.mode ?? null,
      runtimeReady: runtime?.status?.ready === true,
      configured: credential?.configured === true,
      persistent: credential?.isPersistent === true,
      baseUrl: credential?.baseUrl ?? null,
      model: credential?.model ?? null,
      protocol: credential?.protocol ?? null,
      probeModels: credential?.probe?.models ?? [],
      landing: visible(landing),
      configure: visible(configure),
      create: visible(create),
      connected: visible(connected),
      emptyWorkspace: visible(emptyWorkspace) && /No chats yet/i.test(emptyWorkspace?.textContent ?? ''),
      workspace: shell?.getAttribute('data-workspace') ?? null,
    };
  })()`;
  return await waitForRendererState(
    cdp,
    expression,
    value => value?.authKind === "logged-out"
      && value.provider === "cli-proxy"
      && value.runtimeMode === "local-docker"
      && value.runtimeReady === true
      && value.configured === true
      && value.persistent === true
      && value.baseUrl === expectedBaseUrl
      && value.model === SMOKE_MODEL
      && value.protocol === "chat-completions"
      && (!probe || value.probeModels?.includes(SMOKE_MODEL))
      && value.landing === false
      && value.configure === false
      && value.create === true
      && value.connected === true
      && value.emptyWorkspace === true
      && value.workspace === "local-9router",
    probe ? "Persisted 9Router credential could not be decrypted or the login-free workspace did not reopen" : "Completed 9Router setup did not unlock the login-free workspace",
    60_000,
  );
}

async function listenLoopback(server, port) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server.address().port;
}

async function closeServer(server, label) {
  if (server == null || !server.listening) return;
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error != null && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      server.closeAllConnections?.();
      server.unref?.();
      finish(new Error(`Timed out closing the Windows smoke ${label}`));
    }, 5_000);
    server.close(finish);
    // Stop accepting first, then terminate persistent SSE/keep-alive sockets so
    // a reconnect cannot race into the close callback and mask the real error.
    server.closeAllConnections?.();
  });
}

async function readJsonRequest(request, maximumBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) throw new Error(`Gateway smoke request exceeded ${maximumBytes} bytes`);
    chunks.push(chunk);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
  response.end(JSON.stringify(value));
}

async function startHarnessServers(secretCanary) {
  const routerRequests = [];
  const router = createServer((request, response) => {
    const authorized = request.headers.authorization === `Bearer ${secretCanary}`;
    routerRequests.push({ method: request.method ?? "", url: request.url ?? "", authorized });
    response.setHeader("cache-control", "no-store");
    if (!authorized) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "invalid smoke credential" } }));
      return;
    }
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: SMOKE_MODEL }, { id: SECOND_SMOKE_MODEL }] }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "smoke" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "unexpected smoke route" } }));
  });
  const routerPort = await listenLoopback(router, 0);
  const routerBaseUrl = `http://127.0.0.1:${routerPort}/v1`;

  const gatewayRequests = [];
  const gatewayState = {
    token: null,
    hostSettings: {},
    healthChecks: 0,
    eventConnections: 0,
    holdNextCliProxyProbe: false,
    cliProxyProbeHeld: false,
    releaseHeldCliProxyProbe: null,
    cliProxyLeaseActive: false,
    cliProxyLeaseInstalls: 0,
    cliProxyModelProbes: 0,
  };
  let cliProxyLease;
  let cliProxyLeaseExpiryTimer;
  const clearHarnessCliProxyLease = () => {
    if (cliProxyLeaseExpiryTimer != null) clearTimeout(cliProxyLeaseExpiryTimer);
    cliProxyLeaseExpiryTimer = undefined;
    cliProxyLease = undefined;
    gatewayState.cliProxyLeaseActive = false;
  };
  const handleGatewayRequest = async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      gatewayState.healthChecks += 1;
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ ok: true, harness: "windows-packaged-smoke" }));
      return;
    }

    const authorization = request.headers.authorization ?? "";
    const tokenMatch = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(authorization);
    const presentedToken = tokenMatch?.[1] ?? null;
    if (gatewayState.token == null && presentedToken != null && presentedToken !== secretCanary) gatewayState.token = presentedToken;
    const authorized = presentedToken != null && presentedToken === gatewayState.token && presentedToken !== secretCanary;
    const audit = { method: request.method ?? "", url: request.url ?? "", authorized };
    gatewayRequests.push(audit);
    if (!authorized) {
      writeJson(response, 401, { error: "invalid smoke gateway credential" });
      return;
    }

    if (request.method === "GET" && request.url === "/events") {
      gatewayState.eventConnections += 1;
      audit.eventConnection = gatewayState.eventConnections;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      response.flushHeaders?.();
      response.write(": windows-packaged-smoke-connected\n\n");
      const heartbeat = setInterval(() => {
        if (!response.destroyed) response.write(": heartbeat\n\n");
      }, 5_000);
      heartbeat.unref?.();
      response.once("close", () => clearInterval(heartbeat));
      response.once("error", () => clearInterval(heartbeat));
      return;
    }

    if (request.method === "POST" && request.url?.startsWith("/api/")) {
      const command = request.url.slice("/api/".length);
      const args = await readJsonRequest(request);
      if (command === "setHostSettings") {
        if (typeof args !== "object" || args == null || Array.isArray(args)) throw new Error("setHostSettings needs an object");
        audit.clearedCliProxyLease = args.clearCliProxyCredentialLease === true;
        if (audit.clearedCliProxyLease || (args.inferenceProvider !== undefined && args.inferenceProvider !== "cli-proxy")) {
          clearHarnessCliProxyLease();
        }
        const hostSettingsUpdate = { ...args };
        delete hostSettingsUpdate.clearCliProxyCredentialLease;
        gatewayState.hostSettings = { ...gatewayState.hostSettings, ...hostSettingsUpdate };
        writeJson(response, 200, gatewayState.hostSettings);
        return;
      }
      if (command === "getHostSettings") {
        writeJson(response, 200, gatewayState.hostSettings);
        return;
      }
      if (command === "listAgents") {
        writeJson(response, 200, []);
        return;
      }
      if (["isAgentNetworkEnabled", "isEgressTunnelAvailable", "isGlobalSearchEnabled"].includes(command)) {
        writeJson(response, 200, false);
        return;
      }
      if (command === "setBoxSecrets") {
        writeJson(response, 200, { isApplied: true });
        return;
      }
      if (command === "setWindowFocused") {
        writeJson(response, 200, { ok: true });
        return;
      }
      if (command === "leaseCliProxyCredential") {
        if (
          typeof args !== "object"
          || args == null
          || Array.isArray(args)
          || Object.keys(args).length !== 1
          || !("config" in args)
        ) {
          throw new Error("leaseCliProxyCredential needs exactly one config object");
        }
        const config = args.config;
        const configKeys = typeof config === "object" && config != null && !Array.isArray(config)
          ? Object.keys(config).sort()
          : [];
        const expectedKeys = ["allowRemoteHttps", "allowTailscaleHttp", "apiKey", "baseUrl", "model", "protocol"];
        if (
          configKeys.length !== expectedKeys.length
          || configKeys.some((key, index) => key !== expectedKeys[index])
          || config.baseUrl !== routerBaseUrl
          || config.model !== SMOKE_MODEL
          || config.protocol !== "chat-completions"
          || config.allowRemoteHttps !== false
          || config.allowTailscaleHttp !== false
          || config.apiKey !== secretCanary
        ) {
          throw new Error("leaseCliProxyCredential received an invalid 9Router turn config");
        }
        clearHarnessCliProxyLease();
        gatewayState.cliProxyLeaseInstalls += 1;
        const expiresAtMs = Date.now() + 30 * 60_000;
        const generation = gatewayState.cliProxyLeaseInstalls;
        cliProxyLease = {
          config: Object.freeze({ ...config }),
          expiresAtMs,
          generation,
        };
        cliProxyLeaseExpiryTimer = setTimeout(() => {
          if (cliProxyLease?.generation === generation) clearHarnessCliProxyLease();
        }, 30 * 60_000);
        cliProxyLeaseExpiryTimer.unref?.();
        gatewayState.cliProxyLeaseActive = true;
        audit.cliProxyLeaseValidated = true;
        audit.cliProxyLeaseInstall = gatewayState.cliProxyLeaseInstalls;
        writeJson(response, 200, { expiresAtMs });
        return;
      }
      if (command === "probeCliProxyModels") {
        if (typeof args !== "object" || args == null || Array.isArray(args) || Object.keys(args).length !== 0) {
          throw new Error("probeCliProxyModels must not receive config or credentials");
        }
        const lease = cliProxyLease;
        if (lease == null || lease.expiresAtMs <= Date.now()) {
          clearHarnessCliProxyLease();
          throw new Error("probeCliProxyModels requires an active credential lease");
        }
        if (gatewayState.holdNextCliProxyProbe) {
          gatewayState.holdNextCliProxyProbe = false;
          gatewayState.cliProxyProbeHeld = true;
          audit.cliProxyProbeHeld = true;
          await new Promise(resolve => {
            const safety = setTimeout(resolve, 30_000);
            safety.unref?.();
            gatewayState.releaseHeldCliProxyProbe = () => {
              clearTimeout(safety);
              resolve();
            };
          });
          gatewayState.cliProxyProbeHeld = false;
          gatewayState.releaseHeldCliProxyProbe = null;
          if (cliProxyLease?.generation !== lease.generation || lease.expiresAtMs <= Date.now()) {
            throw new Error("held 9Router model probe lease was superseded");
          }
        }
        const probeStartedAtMs = Date.now();
        const probeResponse = await fetch(`${lease.config.baseUrl}/models`, {
          method: "GET",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${lease.config.apiKey}`,
            connection: "close",
            "user-agent": "grok-bot-9router/1",
          },
          redirect: "error",
          signal: AbortSignal.timeout(5_000),
        });
        if (!probeResponse.ok) throw new Error("leased 9Router model probe was not authorized");
        const probeDocument = await probeResponse.json();
        const probeModels = Array.isArray(probeDocument?.data)
          ? probeDocument.data.map(item => item?.id).filter(id => typeof id === "string" && id.length > 0)
          : [];
        gatewayState.cliProxyModelProbes += 1;
        audit.credentialFreeCliProxyProbe = true;
        audit.cliProxyLeaseInstall = lease.generation;
        audit.authenticatedRouterProbe = probeModels.includes(SMOKE_MODEL);
        writeJson(response, 200, { outcome: probeModels.length > 0 ? "ok" : "empty", latencyMs: Math.max(0, Date.now() - probeStartedAtMs) });
        return;
      }
      audit.unsupported = true;
      writeJson(response, 404, { error: `unsupported Windows smoke gateway command: ${command}` });
      return;
    }

    audit.unsupported = true;
    writeJson(response, 404, { error: "unsupported Windows smoke gateway route" });
  };
  const gateway = createServer((request, response) => {
    void handleGatewayRequest(request, response).catch(error => {
      if (response.headersSent) response.destroy(error);
      else writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
  gateway.once("close", clearHarnessCliProxyLease);
  try { await listenLoopback(gateway, 1340); }
  catch (error) {
    try { await closeServer(router, "router harness after gateway bind failure"); }
    catch (cleanupError) {
      throw new Error(`Gateway harness bind failed: ${error instanceof Error ? error.message : String(error)}; router cleanup also failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`, { cause: new AggregateError([error, cleanupError]) });
    }
    throw error;
  }
  return {
    router,
    gateway,
    gatewayRequests,
    gatewayState,
    routerRequests,
    routerBaseUrl,
  };
}

async function buildStrictFakeDocker(temporary) {
  const project = path.join(import.meta.dirname, "fixtures", "windows-fake-docker", "FakeDocker.csproj");
  const output = path.join(temporary, "fake-docker");
  await mkdir(output, { recursive: true });
  try {
    await execFileAsync("dotnet", [
      "build", project,
      "--configuration", "Release",
      "--output", output,
      "--nologo",
      "--verbosity", "quiet",
      "--property:RestoreIgnoreFailedSources=true",
    ], { timeout: 120_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
  } catch (error) {
    const detail = error instanceof Error && "stderr" in error ? String(error.stderr || error.message) : String(error);
    throw new Error(`Could not build the strict fake Docker control plane: ${detail}`);
  }
  const executable = path.join(output, "docker.exe");
  if (!await pathExists(executable)) throw new Error(`Strict fake Docker build did not produce ${executable}`);
  return output;
}

async function assertFakeDockerContainerState(statePath, expectedRunning, label) {
  let state;
  try {
    state = JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    throw new Error(`${label}: fake Docker state was unavailable or malformed (${error instanceof Error ? error.message : String(error)})`);
  }
  if (state?.ContainerExists !== true || state.ContainerRunning !== expectedRunning) {
    throw new Error(`${label}: ${JSON.stringify({
      containerExists: state?.ContainerExists ?? null,
      containerRunning: state?.ContainerRunning ?? null,
    })}`);
  }
}

function parseFakeDockerTranscript(transcript) {
  return transcript.split(/\r?\n/).filter(line => line.trim().length > 0).map((line, index) => {
    let entry;
    try { entry = JSON.parse(line); }
    catch { throw new Error(`Strict Docker transcript line ${index + 1} is not JSON`); }
    if (!Array.isArray(entry?.args) || entry.args.some(argument => typeof argument !== "string")) {
      throw new Error(`Strict Docker transcript line ${index + 1} has invalid argv`);
    }
    return entry.args;
  });
}

function assertFakeDockerQuitRecoveryLifecycle(commands) {
  const lifecycle = [];
  for (const args of commands) {
    const nameIndex = args.indexOf("--name");
    if (args[0] === "run" && args.includes("--detach") && nameIndex >= 0 && args[nameIndex + 1] === SMOKE_CONTAINER) {
      lifecycle.push("create");
    } else if (args.length === 2 && args[1] === SMOKE_CONTAINER && ["start", "stop"].includes(args[0])) {
      lifecycle.push(args[0]);
    }
  }
  const expectedLifecycle = ["create", "stop", "start", "stop"];
  if (JSON.stringify(lifecycle) !== JSON.stringify(expectedLifecycle)) {
    throw new Error(`Strict Docker quit/recovery lifecycle was ${JSON.stringify(lifecycle)}, expected ${JSON.stringify(expectedLifecycle)}`);
  }
}

async function listFiles(root) {
  const result = [];
  async function walk(target) {
    let entries;
    try { entries = await readdir(target, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const child = path.join(target, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) result.push(child);
    }
  }
  await walk(root);
  return result;
}

async function fileContainsAny(target, needles) {
  const metadata = await stat(target).catch(() => null);
  if (metadata == null || !metadata.isFile() || metadata.size === 0) return false;
  const longest = Math.max(...needles.map(needle => needle.length));
  const handle = await open(target, "r");
  const chunk = Buffer.alloc(1024 * 1024);
  let carry = Buffer.alloc(0);
  let position = 0;
  try {
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) return false;
      const combined = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
      if (needles.some(needle => combined.includes(needle))) return true;
      carry = combined.subarray(Math.max(0, combined.length - longest + 1));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
}

async function assertCredentialPersistence(temporary, secretCanary, expectedBaseUrl) {
  const files = await listFiles(temporary);
  const secretFiles = [];
  const needles = [Buffer.from(secretCanary, "utf8"), Buffer.from(secretCanary, "utf16le")];
  for (const file of files) if (await fileContainsAny(file, needles)) secretFiles.push(path.relative(temporary, file));
  if (secretFiles.length > 0) throw new Error(`9Router API key was persisted in plaintext: ${secretFiles.join(", ")}`);

  const credentialFiles = files.filter(file => path.basename(file) === "cli-proxy-provider.json");
  if (credentialFiles.length !== 1) throw new Error(`Expected exactly one encrypted 9Router credential document, found ${credentialFiles.length}`);
  const document = JSON.parse(await readFile(credentialFiles[0], "utf8"));
  if (document?.schemaVersion !== 1 || typeof document.apiKeyCiphertext !== "string" || document.apiKeyCiphertext.length === 0) {
    throw new Error("Windows 9Router credential document does not contain an encrypted API key");
  }
  if (document.config?.baseUrl !== expectedBaseUrl || document.config?.model !== SMOKE_MODEL || document.config?.protocol !== "chat-completions") {
    throw new Error("Persisted 9Router public configuration does not match the completed UI flow");
  }
}

function redactSensitive(value, secretCanary) {
  return String(value)
    .split(secretCanary).join("[REDACTED-9ROUTER-KEY]")
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/("apiKey"\s*:\s*")[^"]+("?)/gi, "$1[REDACTED]$2");
}

async function writeFailureArtifacts({ cdp, error, harness, logs, secretCanary, transcriptPath, phase }) {
  const directory = path.resolve("reports", `windows-smoke-failure-${Date.now()}`);
  await mkdir(directory, { recursive: true });
  let renderer = null;
  try {
    renderer = await cdp?.evaluate(`(() => ({ title: document.title, text: (document.body?.innerText ?? '').slice(0, 20000), inputs: [...document.querySelectorAll('input')].map(input => ({ label: input.getAttribute('aria-label'), type: input.type, value: input.type === 'password' ? '[REDACTED]' : input.value })) }))()`);
  } catch {}
  try {
    await cdp?.request("Page.enable");
    const screenshot = await cdp?.request("Page.captureScreenshot", { format: "png" });
    if (typeof screenshot?.data === "string") await writeFile(path.join(directory, "renderer.png"), Buffer.from(screenshot.data, "base64"));
  } catch {}
  let transcript = "";
  try { transcript = await readFile(transcriptPath, "utf8"); } catch {}
  const harnessDiagnostic = harness == null ? null : {
    gatewayRequests: harness.gatewayRequests,
    routerRequests: harness.routerRequests,
    gatewayState: {
      healthChecks: harness.gatewayState.healthChecks,
      eventConnections: harness.gatewayState.eventConnections,
      cliProxyLeaseActive: harness.gatewayState.cliProxyLeaseActive,
      cliProxyLeaseInstalls: harness.gatewayState.cliProxyLeaseInstalls,
      cliProxyModelProbes: harness.gatewayState.cliProxyModelProbes,
      cliProxyProbeHeld: harness.gatewayState.cliProxyProbeHeld,
    },
  };
  const diagnostic = redactSensitive(JSON.stringify({
    phase,
    error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
    renderer,
    processOutput: logs.join("").slice(-64 * 1024),
    dockerTranscript: transcript.slice(-64 * 1024),
    harness: harnessDiagnostic,
  }, null, 2), secretCanary);
  if (diagnostic.includes(secretCanary)) throw new Error("Refusing to write an unredacted Windows smoke failure artifact");
  await writeFile(path.join(directory, "diagnostic.json"), diagnostic, "utf8");
  process.stderr.write(`Windows smoke failure artifacts: ${directory}\n`);
}

async function runBasicSmoke(verified, environment, userDataDir, logs) {
  let launched;
  let failure;
  try {
    launched = await launchPortable(verified, environment, userDataDir, logs, handle => { launched = handle; });
    await openRouterSettings(launched.cdp);
    await select9RouterProvider(launched.cdp);
    await waitForRendererState(
      launched.cdp,
      `(async () => { const input = document.querySelector('input[aria-label="9Router Base URL"]'); const state = await window.desktop.agent.getInferenceRouter(); return { provider: state?.provider ?? null, hasEditableBaseUrl: input instanceof HTMLInputElement && !input.disabled && !input.readOnly, baseUrl: input instanceof HTMLInputElement ? input.value : null, text: document.body?.innerText ?? "" }; })()`,
      value => value?.provider === "cli-proxy" && value.hasEditableBaseUrl === true && value.baseUrl === "http://127.0.0.1:20128/v1" && /9Router connection/i.test(value.text ?? ""),
      "Fresh isolated profile cannot select 9Router or edit its Base URL",
    );
    await stopPortableGracefully(launched, { label: "Basic packaged smoke could not exit through Electron's normal close path" });
    launched = undefined;
    console.log(`PASS Windows packaged launch smoke: ${verified.executable}`);
    console.log("Fresh isolated profile mounted the clean renderer and reached the 9Router settings surface.");
  } catch (error) {
    failure = error;
    if (logs.length > 0) process.stderr.write(`\n--- packaged process output ---\n${logs.join("").slice(-16_384)}\n`);
    throw error;
  } finally {
    const cleanupErrors = [];
    try { launched?.cdp?.close(); }
    catch (error) { cleanupErrors.push(error); }
    try { await stopProcess(launched?.child); }
    catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length > 0) {
      const cleanupFailure = new AggregateError(cleanupErrors, "Basic Windows smoke cleanup did not settle cleanly");
      if (failure != null) process.stderr.write(`Basic Windows smoke cleanup also failed: ${cleanupErrors.map(error => String(error)).join("; ")}\n`);
      else throw cleanupFailure;
    }
  }
}

async function runFullLoginFreeSmoke(verified, temporary, baseEnvironment, userDataDir, logs) {
  const secretCanary = `grok-smoke-${randomBytes(32).toString("hex")}`;
  const dockerStatePath = path.join(temporary, "fake-docker-state.json");
  const dockerTranscriptPath = path.join(temporary, "fake-docker-transcript.ndjson");
  let servers;
  let launched;
  let failure;
  let phase = "harness-start";
  try {
    const fakeDockerDirectory = await buildStrictFakeDocker(temporary);
    servers = await startHarnessServers(secretCanary);
    const environment = {
      ...baseEnvironment,
      PATH: `${fakeDockerDirectory}${path.delimiter}${baseEnvironment.PATH ?? ""}`,
      GROK_BOT_SMOKE_DOCKER_STATE: dockerStatePath,
      GROK_BOT_SMOKE_DOCKER_TRANSCRIPT: dockerTranscriptPath,
      GROK_BOT_SMOKE_FORBIDDEN_SHA256: createHash("sha256").update(secretCanary).digest("hex"),
      GROK_BOT_SMOKE_FORBIDDEN_LENGTH: String(secretCanary.length),
    };

    phase = "fresh-profile-launch";
    launched = await launchPortable(verified, environment, userDataDir, logs, handle => { launched = handle; });
    await assertSignedOutLanding(launched.cdp, "Fresh profile did not begin at the real signed-out landing");
    const initial = await launched.cdp.evaluate(`(async () => { const [credential, router, runtime] = await Promise.all([window.desktop.cliProxy.status(), window.desktop.agent.getInferenceRouter(), window.desktop.agent.getBoxRuntime()]); return { configured: credential?.configured === true, provider: router?.provider ?? null, mode: runtime?.mode ?? null }; })()`);
    if (initial?.configured || initial?.provider !== "cursor" || initial?.mode !== "remote") throw new Error(`Fresh profile inherited router state: ${JSON.stringify(initial)}`);

    phase = "provider-selection";
    await openRouterSettings(launched.cdp);
    await select9RouterProvider(launched.cdp);

    phase = "credential-save-with-blank-model";
    const inputResult = await launched.cdp.evaluate(setInputsExpression({
      "9Router Base URL": servers.routerBaseUrl,
      "9Router API key": secretCanary,
      "9Router model": "",
    }));
    if (!Object.values(inputResult ?? {}).every(Boolean)) throw new Error(`Could not fill fresh 9Router settings: ${JSON.stringify(inputResult)}`);
    await clickButton(launched.cdp, "Save 9Router", "Fresh profile could not save the 9Router credential");
    await waitForRendererState(
      launched.cdp,
      `(async () => { const status = await window.desktop.cliProxy.status(); const key = document.querySelector('input[aria-label="9Router API key"]'); return { configured: status?.configured === true, persistent: status?.isPersistent === true, model: status?.model ?? null, keyCleared: key instanceof HTMLInputElement && key.value === '', text: document.body?.innerText ?? '' }; })()`,
      value => value?.configured === true && value.persistent === true && value.model === "" && value.keyCleared === true && /encrypted by the operating system/i.test(value.text ?? ""),
      "Windows did not persist the blank-model credential with OS encryption",
    );

    phase = "models-probe";
    await clickButton(launched.cdp, "Test & load models", "Fresh profile could not test the saved 9Router credential");
    await waitForRendererState(
      launched.cdp,
      `(() => ({ options: [...document.querySelectorAll('#sand-9router-models option')].map(option => option.value), text: document.body?.innerText ?? '' }))()`,
      value => value?.options?.length === 2
        && value.options.includes(SMOKE_MODEL)
        && value.options.includes(SECOND_SMOKE_MODEL)
        && /Connected and loaded 2 models/i.test(value.text ?? ""),
      "Authenticated /v1/models probe did not populate the packaged model chooser",
    );
    const firstProbeRequests = servers.routerRequests.filter(request => request.url === "/v1/models");
    if (firstProbeRequests.length < 1 || firstProbeRequests.some(request => request.method !== "GET" || request.authorized !== true)) {
      throw new Error(`Initial model chooser probe was not authenticated: ${JSON.stringify(servers.routerRequests)}`);
    }

    phase = "blank-model-blocker";
    await closeSettings(launched.cdp);
    await assertSignedOutLanding(launched.cdp, "A key without a selected model incorrectly bypassed sign-in");
    await openRouterSettings(launched.cdp);

    phase = "model-save";
    const modelResult = await launched.cdp.evaluate(setInputsExpression({ "9Router model": SMOKE_MODEL }));
    if (modelResult?.["9Router model"] !== true) throw new Error("Could not select the probed 9Router model");
    await clickButton(launched.cdp, "Save 9Router", "Selected 9Router model could not be saved");
    await waitForRendererState(
      launched.cdp,
      `(async () => { const status = await window.desktop.cliProxy.status(); return { configured: status?.configured === true, persistent: status?.isPersistent === true, model: status?.model ?? null }; })()`,
      value => value?.configured === true && value.persistent === true && value.model === SMOKE_MODEL,
      "Selected 9Router model did not persist",
    );
    await closeSettings(launched.cdp);
    await assertSignedOutLanding(launched.cdp, "9Router without Local Docker incorrectly bypassed sign-in");
    await openRouterSettings(launched.cdp);

    phase = "strict-docker-control-plane";
    await waitForRendererState(
      launched.cdp,
      `(() => { const dialog = document.querySelector('[role="dialog"][aria-label="Grok Bot settings"]'); const switches = [...(dialog?.querySelectorAll('button[role="switch"]') ?? [])]; const matching = switches.filter(node => node instanceof HTMLButtonElement && node.getAttribute('aria-label') === 'Use local Docker VM' && node.isConnected && node.getClientRects().length > 0); const toggle = matching.length === 1 ? matching[0] : null; const ready = toggle instanceof HTMLButtonElement && !toggle.disabled && toggle.getAttribute('aria-checked') === 'false'; if (ready) toggle.click(); return { clicked: ready, matchCount: matching.length, checked: toggle?.getAttribute('aria-checked') ?? null, disabled: toggle?.disabled ?? null, switches: switches.map(node => ({ label: node.getAttribute('aria-label'), checked: node.getAttribute('aria-checked'), disabled: node.disabled, visible: node.isConnected && node.getClientRects().length > 0 })) }; })()`,
      value => value?.clicked === true,
      "Local Docker switch was not available from the fresh 9Router profile",
    );
    await waitForRendererState(
      launched.cdp,
      `(async () => { const runtime = await window.desktop.agent.getBoxRuntime(); const dialog = document.querySelector('[role="dialog"][aria-label="Grok Bot settings"]'); const switches = [...(dialog?.querySelectorAll('button[role="switch"]') ?? [])]; const matching = switches.filter(node => node instanceof HTMLButtonElement && node.getAttribute('aria-label') === 'Use local Docker VM' && node.isConnected && node.getClientRects().length > 0); const toggle = matching.length === 1 ? matching[0] : null; return { mode: runtime?.mode ?? null, ready: runtime?.status?.ready === true, detail: runtime?.status?.detail ?? null, matchCount: matching.length, checked: toggle?.getAttribute('aria-checked') ?? null, text: document.body?.innerText ?? '' }; })()`,
      value => value?.mode === "local-docker" && value.ready === true && value.matchCount === 1 && value.checked === "true" && /Local Docker VM is ready/i.test(value.text ?? value.detail ?? ""),
      "Strict Docker control plane did not reach ready state",
      60_000,
    );

    phase = "save-and-continue-without-sign-in";
    const continueBaseline = {
      eventConnections: servers.gatewayState.eventConnections,
      leaseInstalls: servers.gatewayState.cliProxyLeaseInstalls,
      modelProbes: servers.gatewayState.cliProxyModelProbes,
    };
    servers.gatewayState.holdNextCliProxyProbe = true;
    await clickButton(
      launched.cdp,
      "Save & continue without sign-in",
      "Ready local 9Router workspace did not expose its sign-in-free continuation",
    );
    await waitForHarnessState(
      () => servers.gatewayState.cliProxyProbeHeld === true,
      "Save & continue did not reach the leased production model probe",
      60_000,
    );
    const blockedContinue = await launched.cdp.evaluate(`(() => { const dialog = document.querySelector('[role="dialog"][aria-label="Grok Bot settings"]'); return { settingsOpen: dialog != null, preparing: /Preparing workspace/i.test(dialog?.textContent ?? '') }; })()`);
    if (blockedContinue?.settingsOpen !== true || blockedContinue.preparing !== true) {
      throw new Error(`Settings closed before the leased model probe and coordinator readiness completed: ${JSON.stringify(blockedContinue)}`);
    }
    servers.gatewayState.releaseHeldCliProxyProbe?.();
    await waitForRendererState(
      launched.cdp,
      `(() => { const connected = document.querySelector('[role="status"][aria-label="Connected"]'); return { settingsOpen: document.querySelector('[role="dialog"][aria-label="Grok Bot settings"]') != null, workspace: document.querySelector('.sand-shell')?.getAttribute('data-workspace') ?? null, connected: connected != null && connected.isConnected && connected.getClientRects().length > 0, text: document.body?.innerText ?? '' }; })()`,
      value => value?.settingsOpen === false && value.workspace === "local-9router" && value.connected === true,
      "Save & continue did not close settings into the local 9Router workspace",
      60_000,
    );
    const readContinueDelta = () => ({
      eventConnections: servers.gatewayState.eventConnections - continueBaseline.eventConnections,
      leaseInstalls: servers.gatewayState.cliProxyLeaseInstalls - continueBaseline.leaseInstalls,
      modelProbes: servers.gatewayState.cliProxyModelProbes - continueBaseline.modelProbes,
    });
    const continueDelta = readContinueDelta();
    if (continueDelta.eventConnections !== 1 || continueDelta.leaseInstalls !== 1 || continueDelta.modelProbes !== 1) {
      throw new Error(`Save & continue did not perform exactly one fresh coordinator activation: ${JSON.stringify(continueDelta)}`);
    }
    const activationStabilityDeadline = Date.now() + 2_000;
    while (Date.now() < activationStabilityDeadline) {
      const stableDelta = readContinueDelta();
      const stableRenderer = await launched.cdp.evaluate(`(() => { const connected = document.querySelector('[role="status"][aria-label="Connected"]'); return { settingsOpen: document.querySelector('[role="dialog"][aria-label="Grok Bot settings"]') != null, workspace: document.querySelector('.sand-shell')?.getAttribute('data-workspace') ?? null, connected: connected != null && connected.isConnected && connected.getClientRects().length > 0 }; })()`);
      if (stableDelta.eventConnections !== 1 || stableDelta.leaseInstalls !== 1 || stableDelta.modelProbes !== 1
        || stableRenderer?.settingsOpen !== false || stableRenderer.workspace !== "local-9router" || stableRenderer.connected !== true) {
        throw new Error(`Save & continue activation did not remain stable: ${JSON.stringify({ delta: stableDelta, renderer: stableRenderer })}`);
      }
      await delay(100);
    }

    phase = "login-free-gate";
    await assertLoginFreeWorkspace(launched.cdp, servers.routerBaseUrl);

    phase = "first-process-stop";
    const firstQuitRequestIndex = servers.gatewayRequests.length;
    await stopPortableGracefully(launched, {
      label: "First packaged process could not complete a clean lease-revoking quit",
      leaseRevoked: () => servers.gatewayRequests
        .slice(firstQuitRequestIndex)
        .some(request => request.url === "/api/setHostSettings" && request.clearedCliProxyLease === true),
    });
    launched = undefined;
    phase = "first-container-stopped";
    await assertFakeDockerContainerState(
      dockerStatePath,
      false,
      "First graceful quit did not stop the owned Local Docker VM",
    );
    await assertCredentialPersistence(temporary, secretCanary, servers.routerBaseUrl);

    phase = "persistent-profile-relaunch";
    launched = await launchPortable(verified, environment, userDataDir, logs, handle => { launched = handle; });
    await assertLoginFreeWorkspace(launched.cdp, servers.routerBaseUrl, { probe: true });
    phase = "persistent-container-recovered";
    await assertFakeDockerContainerState(
      dockerStatePath,
      true,
      "Persistent relaunch did not restart the stopped Local Docker VM",
    );
    const savedInputs = await launched.cdp.evaluate(`(() => { const configure = document.querySelector('button[aria-label="Configure 9Router"]'); return { configureVisible: configure != null && configure.getClientRects().length > 0 }; })()`);
    if (savedInputs?.configureVisible) throw new Error("Persisted local workspace returned to the central Configure 9Router landing");

    phase = "final-persistence-scan";
    const finalQuitRequestIndex = servers.gatewayRequests.length;
    await stopPortableGracefully(launched, {
      label: "Relaunched packaged process could not complete a clean lease-revoking quit",
      leaseRevoked: () => servers.gatewayRequests
        .slice(finalQuitRequestIndex)
        .some(request => request.url === "/api/setHostSettings" && request.clearedCliProxyLease === true),
    });
    launched = undefined;
    phase = "final-container-stopped";
    await assertFakeDockerContainerState(
      dockerStatePath,
      false,
      "Final graceful quit did not stop the recovered Local Docker VM",
    );
    await assertCredentialPersistence(temporary, secretCanary, servers.routerBaseUrl);

    const requests = servers.routerRequests.filter(request => request.url === "/v1/models");
    if (requests.length < 2 || requests.some(request => request.method !== "GET" || request.authorized !== true)) {
      throw new Error(`Expected authenticated model probes before and after relaunch: ${JSON.stringify(servers.routerRequests)}`);
    }
    if (servers.routerRequests.some(request => request.url.includes("/codex"))) throw new Error("Packaged smoke observed a forbidden /codex request");
    const gatewayTokenFiles = (await listFiles(temporary)).filter(file => path.basename(file) === "local-docker-vm.json");
    if (gatewayTokenFiles.length !== 1) throw new Error(`Expected exactly one local gateway credential document, found ${gatewayTokenFiles.length}`);
    const gatewayCredential = JSON.parse(await readFile(gatewayTokenFiles[0], "utf8"));
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(gatewayCredential?.token ?? "") || gatewayCredential.token !== servers.gatewayState.token || gatewayCredential.token === secretCanary) {
      throw new Error("Authenticated mock gateway did not use the persisted local VM credential");
    }
    const protectedGatewayRequests = servers.gatewayRequests.filter(request => request.url === "/events" || request.url.startsWith("/api/"));
    if (protectedGatewayRequests.length === 0 || protectedGatewayRequests.some(request => request.authorized !== true || request.unsupported === true)) {
      throw new Error(`Mock gateway observed an unauthorized or unsupported coordinator request: ${JSON.stringify(servers.gatewayRequests)}`);
    }
    if (JSON.stringify(servers.gatewayRequests).includes(secretCanary)) throw new Error("9Router API key reached the gateway audit log");
    if (servers.gatewayRequests.filter(request => request.url === "/events").length < 2) throw new Error("Coordinator did not reconnect its authenticated gateway event stream");
    for (const route of ["/api/getHostSettings", "/api/setHostSettings", "/api/setBoxSecrets", "/api/setWindowFocused", "/api/listAgents", "/api/leaseCliProxyCredential", "/api/probeCliProxyModels"]) {
      if (!servers.gatewayRequests.some(request => request.url === route)) throw new Error(`Coordinator resync did not reach ${route}`);
    }
    const leaseRequests = servers.gatewayRequests.filter(request => request.url === "/api/leaseCliProxyCredential");
    const containerProbeRequests = servers.gatewayRequests.filter(request => request.url === "/api/probeCliProxyModels");
    if (leaseRequests.length < 2 || leaseRequests.some(request => request.cliProxyLeaseValidated !== true)) {
      throw new Error("Fresh and recovered Local Docker sessions did not each receive a strictly validated memory-only 9Router credential lease");
    }
    if (containerProbeRequests.length < 2 || containerProbeRequests.some(request => request.credentialFreeCliProxyProbe !== true || request.authenticatedRouterProbe !== true || !(request.cliProxyLeaseInstall > 0))) {
      throw new Error("Fresh and recovered Local Docker sessions did not probe 9Router through the credential-free leased gateway contract");
    }
    if (servers.gatewayState.healthChecks < 1 || servers.gatewayState.hostSettings.inferenceProvider !== "cli-proxy") {
      throw new Error("Local Docker health or coordinator host-settings resync did not become authoritative");
    }
    if (!servers.gatewayRequests.some(request => request.url === "/api/setHostSettings" && request.clearedCliProxyLease === true)) {
      throw new Error("Final 9Router save did not revoke the prior host credential lease over the authenticated coordinator channel");
    }
    if (servers.gatewayState.cliProxyLeaseActive !== false) throw new Error("Final graceful quit left the mock host credential lease active");
    if (!servers.gatewayRequests.some(request => request.url === "/api/listAgents")) throw new Error("Login-free workspace never reached the coordinator roster path");
    const transcript = await readFile(dockerTranscriptPath, "utf8");
    const dockerCommands = parseFakeDockerTranscript(transcript);
    for (const command of ["info", "network", "volume", "run", "exec", "inspect"]) {
      if (!dockerCommands.some(args => args[0] === command)) throw new Error(`Strict Docker transcript missed ${command}`);
    }
    if (transcript.includes(secretCanary)) throw new Error("9Router API key reached the Docker transcript");
    assertFakeDockerQuitRecoveryLifecycle(dockerCommands);

    console.log(`PASS Windows packaged login-free 9Router smoke: ${verified.executable}`);
    console.log("Fresh profile saved an OS-encrypted credential, loaded models, enforced both readiness blockers, used Save & continue without sign-in, stopped its owned container on quit, restarted it on persistent relaunch, and stopped it again on final quit.");
    console.log("Docker and the bounded gateway control/roster protocol were simulated; live Docker Desktop, Tailscale, VNC, inference turns, and native tool execution remain separate environment tests.");
  } catch (error) {
    await writeFailureArtifacts({ cdp: launched?.cdp, error, harness: servers, logs, secretCanary, transcriptPath: dockerTranscriptPath, phase }).catch(artifactError => {
      process.stderr.write(`Could not write redacted Windows smoke diagnostics: ${redactSensitive(artifactError, secretCanary)}\n`);
    });
    if (logs.length > 0) process.stderr.write(`\n--- packaged process output (redacted) ---\n${redactSensitive(logs.join("").slice(-16_384), secretCanary)}\n`);
    const message = redactSensitive(error instanceof Error ? error.message : error, secretCanary);
    failure = new Error(`Windows login-free 9Router smoke failed during ${phase}: ${message}`);
    process.stderr.write(`${failure.message}\n`);
    throw failure;
  } finally {
    const cleanupErrors = [];
    const cleanup = async (label, operation) => {
      try { await operation(); }
      catch (error) { cleanupErrors.push(new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })); }
    };
    await cleanup("release held 9Router model probe", async () => servers?.gatewayState.releaseHeldCliProxyProbe?.());
    await cleanup("close renderer debugger", async () => launched?.cdp?.close());
    await cleanup("stop packaged process tree", async () => stopProcess(launched?.child));
    await cleanup("close gateway harness", async () => closeServer(servers?.gateway, "gateway harness"));
    await cleanup("close router harness", async () => closeServer(servers?.router, "router harness"));
    if (cleanupErrors.length > 0) {
      const cleanupFailure = new AggregateError(cleanupErrors, "Windows smoke cleanup did not settle cleanly");
      if (failure != null) process.stderr.write(`Windows smoke cleanup also failed: ${redactSensitive(cleanupErrors.map(error => error.message).join("; "), secretCanary)}\n`);
      else throw cleanupFailure;
    }
  }
}

const options = parseArguments(process.argv.slice(2));
const verified = await verifyWindowsPortable(options.root);
if (process.platform !== "win32") {
  console.log(`PASS Windows structural smoke (launch skipped on ${process.platform}): ${verified.outputRoot}`);
  process.exit(0);
}

const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-bot-reconstructed-win-smoke-"));
const userDataDir = path.join(temporary, "user-data");
const dataRoot = path.join(temporary, "sand-data");
const logs = [];
const environment = {
  ...process.env,
  APPDATA: path.join(temporary, "AppData", "Roaming"),
  LOCALAPPDATA: path.join(temporary, "AppData", "Local"),
  SAND_DATA_ROOT: dataRoot,
  SAND_USER_DATA_DIR: userDataDir,
  SAND_DISABLE_UPDATES: "1",
  SAND_DISABLE_SENTRY: "1",
  SAND_DISABLE_TELEMETRY: "1",
  SAND_DISABLE_PROTOCOL_REGISTRATION: "1",
};

let smokeFailure;
try {
  if (options.basic) await runBasicSmoke(verified, environment, userDataDir, logs);
  else await runFullLoginFreeSmoke(verified, temporary, environment, userDataDir, logs);
} catch (error) {
  smokeFailure = error;
  throw error;
} finally {
  try { await removeTemporaryDirectory(temporary); }
  catch (error) {
    const cleanupFailure = new Error(`Windows smoke temporary directory cleanup failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    if (smokeFailure != null) process.stderr.write(`${cleanupFailure.message}\n`);
    else throw cleanupFailure;
  }
}
