import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import WebSocket from "ws";

import { outputWindowsPortable } from "./lib/config.mjs";
import { pathExists } from "./lib/windows-runtime.mjs";
import { verifyWindowsPortable } from "./lib/windows-package.mjs";
import { spawn } from "node:child_process";

const execFileAsync = promisify(execFile);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitForDebugEndpoint(userDataDir, child, timeoutMs = 30_000) {
  const activePort = path.join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`Portable process exited before renderer startup (${child.exitCode})`);
    if (await pathExists(activePort)) {
      const [line] = (await readFile(activePort, "utf8")).trim().split(/\r?\n/);
      const port = Number(line);
      if (Number.isInteger(port) && port > 0 && port <= 65535) {
        try {
          const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
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
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out connecting to renderer debugger")), 10_000);
    socket.once("open", () => { clearTimeout(timeout); resolve(); });
    socket.once("error", error => { clearTimeout(timeout); reject(error); });
  });
  let id = 0;
  const evaluate = expression => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timeout = setTimeout(() => reject(new Error("Timed out evaluating packaged renderer state")), 10_000);
    const listener = data => {
      const message = JSON.parse(data.toString());
      if (message.id !== requestId) return;
      clearTimeout(timeout); socket.off("message", listener);
      if (message.error != null || message.result?.exceptionDetails != null) reject(new Error(`Renderer evaluation failed: ${JSON.stringify(message.error ?? message.result.exceptionDetails)}`));
      else resolve(message.result?.result?.value);
    };
    socket.on("message", listener);
    socket.send(JSON.stringify({ id: requestId, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  return { evaluate, close: () => socket.close() };
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

async function stopProcess(child) {
  if (child.exitCode != null || child.pid == null) return;
  try { await execFileAsync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { timeout: 10_000, windowsHide: true }); }
  catch { child.kill(); }
}

const index = process.argv.indexOf("--app");
const root = index === -1 ? outputWindowsPortable : path.resolve(process.argv[index + 1] ?? "");
if (index !== -1 && (index !== process.argv.length - 2 || !process.argv[index + 1])) throw new Error("Usage: node scripts/smoke-windows.mjs [--app portable-directory]");
const verified = await verifyWindowsPortable(root);
if (process.platform !== "win32") {
  console.log(`PASS Windows structural smoke (launch skipped on ${process.platform}): ${verified.outputRoot}`);
  process.exit(0);
}

const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-bot-reconstructed-win-smoke-"));
const userDataDir = path.join(temporary, "user-data");
const dataRoot = path.join(temporary, "sand-data");
const logs = [];
const child = spawn(verified.executable, [
  `--user-data-dir=${userDataDir}`,
  "--remote-debugging-address=127.0.0.1",
  "--remote-debugging-port=0",
  "--disable-gpu",
  "--no-first-run",
], {
  cwd: verified.outputRoot,
  env: {
    ...process.env,
    APPDATA: path.join(temporary, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(temporary, "AppData", "Local"),
    SAND_DATA_ROOT: dataRoot,
    SAND_USER_DATA_DIR: userDataDir,
    SAND_DISABLE_UPDATES: "1",
    SAND_DISABLE_SENTRY: "1",
    SAND_DISABLE_TELEMETRY: "1",
    SAND_DISABLE_PROTOCOL_REGISTRATION: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
for (const stream of [child.stdout, child.stderr]) stream?.on("data", chunk => { if (logs.join("").length < 1024 * 1024) logs.push(chunk.toString()); });

let cdp;
try {
  cdp = await connectCdp(await waitForDebugEndpoint(userDataDir, child));
  await waitForRendererState(
    cdp,
    `(() => ({ readyState: document.readyState, title: document.title, text: document.body?.innerText ?? "", rootChildren: document.getElementById("root")?.childElementCount ?? 0 }))()`,
    value => value?.readyState === "complete" && value.rootChildren > 0,
    "Packaged clean renderer did not mount",
  );
  await waitForRendererState(
    cdp,
    `(() => { const visible = node => node.isConnected && node.getClientRects().length > 0 && !node.disabled; const candidates = [...document.querySelectorAll('button,[role="button"]')]; const configure = candidates.find(node => visible(node) && (/^configure 9router$/i.test((node.textContent ?? '').trim()) || /^configure 9router$/i.test(node.getAttribute('aria-label') ?? ''))); configure?.click(); return { clicked: configure != null, controls: candidates.filter(visible).map(node => [node.textContent?.trim(), node.getAttribute('aria-label')].filter(Boolean).join(' | ')).filter(Boolean).slice(0, 60) }; })()`,
    value => value?.clicked === true,
    "Fresh isolated profile did not expose the credential-independent 9Router setup",
  );
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
    value => value?.provider === "cli-proxy" && value.hasEditableBaseUrl === true && value.baseUrl === "http://127.0.0.1:20128/v1" && /9Router connection/i.test(value.text ?? ""),
    "Fresh isolated profile cannot select 9Router or edit its Base URL",
  );
  console.log(`PASS Windows packaged launch smoke: ${verified.executable}`);
  console.log("Fresh isolated profile mounted the clean renderer and reached the 9Router settings surface.");
} catch (error) {
  if (logs.length > 0) process.stderr.write(`\n--- packaged process output ---\n${logs.join("").slice(-16_384)}\n`);
  throw error;
} finally {
  cdp?.close();
  await stopProcess(child);
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
