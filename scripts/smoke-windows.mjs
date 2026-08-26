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
    `(() => { const candidates = [...document.querySelectorAll('button,a,[role="button"],[role="menuitem"]')]; const settings = candidates.find(node => /settings/i.test([node.textContent, node.getAttribute('aria-label'), node.getAttribute('title')].filter(Boolean).join(' '))); settings?.click(); return settings != null; })()`,
    value => value === true,
    "Fresh isolated profile did not expose a Settings control",
  );
  await waitForRendererState(
    cdp,
    `(() => { const candidates = [...document.querySelectorAll('button,a,[role="tab"],[role="menuitem"]')]; const router = candidates.find(node => /^router$/i.test((node.textContent ?? '').trim()) || /router/i.test(node.getAttribute('aria-label') ?? '')); router?.click(); return router != null; })()`,
    value => value === true,
    "Fresh isolated profile did not expose the Router settings section",
  );
  await waitForRendererState(
    cdp,
    `(() => ({ text: document.body?.innerText ?? "", hasRouterMarker: document.querySelector('[data-router-provider], [data-settings-section="router"], [data-nine-router]') != null }))()`,
    value => value?.hasRouterMarker === true || /9Router|OpenAI-compatible/i.test(value?.text ?? ""),
    "Fresh isolated profile cannot reach the 9Router settings surface",
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
