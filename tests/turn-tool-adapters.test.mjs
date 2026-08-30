import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "grok-turn-tool-adapters-"));
  options.onDirectoryCreated?.(directory);
  const output = path.join(directory, "turn-tool-adapters.mjs");
  try {
    await symlink(
      path.join(repoRoot, "node_modules"),
      path.join(directory, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await build({
      stdin: {
        contents: `
        export {
          createTurnBrowserToolFactory,
          createTurnComputerToolFactory,
          createTurnScreenshotToolFactory,
        } from "./source/host/runner/tools/turn-toolset.ts";
        export {
          parseDriverResponse,
          SandBrowserDriver,
        } from "./source/host/runner/tools/sand-browser-tools.ts";
        export { createContext } from "./source/packages/context/core.ts";
        export { loggerKey } from "./source/packages/context/logger.ts";
        export {
          executeToolResultOrError,
          renderToolResultOrError,
          toAgentTools,
        } from "./source/packages/agent/tools/core.ts";
        export { executeDeferredToolCall } from "./source/packages/agent/tool-stream-executor.ts";
        export { localAuditJsonlLine } from "./source/host/extensions/action-audit/action-audit-service.ts";
        export { toProtoAuditEventData } from "./source/host/extensions/action-audit/action-audit-backend.ts";
        export { SAND_BROWSER_DRIVER_SOURCE } from "./source/host/runner/tools/sand-browser-driver-source.ts";
        export { shellExecutorResource } from "./source/packages/agent-exec/shell.ts";
        export { smartModeClassifierExecutorResource } from "./source/packages/agent-exec/smart-mode-classifier.ts";
        export { smartModeClassifierWorkspacePathsKey } from "./source/packages/agent/utils/smart-mode-classifier-measurement.ts";
        export {
          SmartModeClassifierDecision,
          SmartModeClassifierResult,
          SmartModeClassifierSuccess,
        } from "./source/packages/proto/generated/agent/v1/smart_mode_classifier_exec_pb.ts";
        export { ToolCall } from "./source/packages/proto/generated/agent/v1/agent_pb.ts";
        export { createProviderPromptSession } from "./source/host/extensions/inference/provider-session.ts";
        export {
          clearCliProxyCredentialLease,
          installCliProxyCredentialLease,
        } from "./source/host/extensions/inference/cli-proxy-credential-lease.ts";
        ${options.sourceSuffix ?? ""}
      `,
        resolveDir: repoRoot,
        sourcefile: "turn-tool-adapters-entry.ts",
        loader: "ts",
      },
      outfile: output,
      bundle: true,
      packages: "external",
      format: "esm",
      logLevel: "silent",
      platform: "node",
      target: "node22",
    });
    const module = await import(`${pathToFileURL(output).href}?t=${Date.now()}`);
    return { directory, module };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

test("adapter bundle loader removes its OS temp directory when loading fails", async () => {
  let directory;
  await assert.rejects(
    loadModule({
      sourceSuffix: "export const intentionallyBroken = ;",
      onDirectoryCreated(value) {
        directory = value;
      },
    }),
  );
  assert.equal(typeof directory, "string");
  await assert.rejects(access(directory), { code: "ENOENT" });
});

async function* argumentStream(...chunks) {
  for (const chunk of chunks) yield chunk;
}

async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

function sse(events) {
  const text = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function createInteractionHandler(signal = new AbortController().signal) {
  const started = [];
  const completed = [];
  const errors = [];
  return {
    started,
    completed,
    errors,
    getAbortSignal: () => signal,
    async executeToolCall(context, toolCall, toolCallId, run, merge) {
      started.push({ context, toolCall, toolCallId });
      const result = await run(context);
      completed.push({ context, toolCall: merge(result), toolCallId });
      return result;
    },
    async emitToolCallError(context, toolCallId, toolCall) {
      errors.push({ context, toolCallId, toolCall });
    },
  };
}

function schemaOf(tool) {
  const parameters = tool.parameters;
  assert.equal(typeof parameters, "object");
  assert.ok(parameters !== null);
  const schema = Object.prototype.hasOwnProperty.call(parameters, "jsonSchema")
    ? parameters.jsonSchema
    : parameters;
  assert.equal(typeof schema, "object");
  assert.ok(schema !== null);
  assert.deepEqual(JSON.parse(JSON.stringify(schema)), schema);
  return schema;
}

function browserDependencies(overrides = {}) {
  return {
    resourceAccessor: { get: () => undefined },
    getWindowIndex: async () => 0,
    getBoxId: () => "box-1",
    getDefaultViewId: () => "view-1",
    uploadFile: async () => {},
    downloadFile: async () => new Uint8Array(),
    removeFile: async () => {},
    executeShellWithInput: async (_context, _input, stdin) => ({
      case: "success",
      stdout: encryptedBrowserResult(stdin, { ok: true, summary: "Done" }),
      exitCode: 0,
    }),
    ...overrides,
  };
}

function decodeBrowserStdin(stdin) {
  return JSON.parse(Buffer.from(stdin.trim(), "base64").toString("utf8"));
}

function encryptedBrowserResult(stdin, result) {
  const envelope = decodeBrowserStdin(stdin);
  assert.match(envelope.responseKey, /^[a-f0-9]{64}$/);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(envelope.responseKey, "hex"), iv);
  cipher.setAAD(Buffer.from("sand-browser-result-v1", "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(result), "utf8"),
    cipher.final(),
  ]);
  const packet = Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ciphertext]);
  return `__SAND_BROWSER_STDIN_READY__\n__SAND_BROWSER_ENCRYPTED_RESULT__${packet.toString("base64")}\n`;
}

test("Computer, Screenshot, and all 15 Browser factory tools expose plain JSON schemas", async () => {
  const loaded = await loadModule();
  try {
    const computerDependencies = {
      resourceAccessor: { get: () => undefined },
      execute: async () => ({ result: { case: "success", value: {} } }),
      getPersistImage: () => undefined,
    };
    const computer = loaded.module.createTurnComputerToolFactory({ dependencies: computerDependencies })();
    const screenshot = loaded.module.createTurnScreenshotToolFactory({ dependencies: computerDependencies })();
    const browser = loaded.module.createTurnBrowserToolFactory({ dependencies: browserDependencies() })();
    const providerDefinitions = loaded.module.toAgentTools([computer, screenshot, ...browser]);

    assert.equal(browser.length, 15);
    assert.equal(providerDefinitions.length, 17);
    assert.deepEqual(
      providerDefinitions.map((definition) => definition.name),
      [computer.name, screenshot.name, ...browser.map((tool) => tool.name)],
    );
    assert.ok(providerDefinitions.every((definition) => schemaOf(definition).type === "object"));
    assert.equal(schemaOf(computer).type, "object");
    assert.deepEqual(schemaOf(computer).required, ["action"]);
    assert.match(providerDefinitions[0].description, /Display is 1280×800/);
    assert.match(schemaOf(computer).properties.action.description, /fresh screenshot/);
    assert.equal(schemaOf(screenshot).type, "object");
    assert.match(providerDefinitions[1].description, /read-only/);
    assert.equal(
      schemaOf(screenshot).description,
      "No arguments. Captures the current box desktop screen.",
    );
    assert.ok(browser.every((tool) => typeof tool.toolIdentifier === "string"));

    const expectedRequired = new Map([
      ["browser_navigate", ["url"]],
      ["browser_snapshot", []],
      ["browser_click", ["ref"]],
      ["browser_mouse_click_xy", ["x", "y"]],
      ["browser_type", ["ref", "text"]],
      ["browser_fill", ["ref", "value"]],
      ["browser_select_option", ["ref", "values"]],
      ["browser_press_key", ["key"]],
      ["browser_scroll", []],
      ["browser_drag", ["sourceRef"]],
      ["browser_get_bounding_box", ["ref"]],
      ["browser_highlight", ["ref"]],
      ["browser_cdp", ["method"]],
      ["browser_tabs", ["action"]],
      ["browser_take_screenshot", []],
    ]);
    assert.deepEqual(browser.map((tool) => tool.name), [...expectedRequired.keys()]);
    for (const tool of browser) {
      const schema = schemaOf(tool);
      assert.equal(schema.type, "object", tool.name);
      assert.equal(typeof schema.properties, "object", tool.name);
      assert.deepEqual(schema.required ?? [], expectedRequired.get(tool.name), tool.name);
    }
    assert.deepEqual(
      schemaOf(browser.find((tool) => tool.name === "browser_tabs")).properties.action.enum,
      ["list", "new", "close", "select"],
    );
    assert.equal(
      schemaOf(browser.find((tool) => tool.name === "browser_tabs")).properties.viewId,
      undefined,
    );
    assert.equal(
      schemaOf(browser.find((tool) => tool.name === "browser_mouse_click_xy")).properties.element.type,
      "string",
    );
    assert.equal(
      schemaOf(browser.find((tool) => tool.name === "browser_drag")).properties.element.type,
      "string",
    );
    assert.deepEqual(
      schemaOf(browser.find((tool) => tool.name === "browser_click")).properties.modifiers.items.enum,
      ["Control", "Shift", "Alt", "Meta", "ControlOrMeta"],
    );
    assert.match(
      schemaOf(browser.find((tool) => tool.name === "browser_click")).properties.element.description,
      /Required when Auto-review is active/,
    );
    assert.match(
      schemaOf(browser.find((tool) => tool.name === "browser_take_screenshot")).properties.viewId.description,
      /dedicated tab/,
    );
  } finally {
    await rm(loaded.directory, { recursive: true, force: true });
  }
});

test("generated Browser driver resolves NODE_PATH-only Playwright and authenticates its encrypted result", async () => {
  const loaded = await loadModule();
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "grok-browser-driver-runtime-"));
  const dependencyRoot = path.join(runtimeRoot, "node-path-deps");
  const packageRoot = path.join(dependencyRoot, "playwright-core");
  const driverDirectory = path.join(runtimeRoot, "private-driver");
  const driverPath = path.join(driverDirectory, "driver.mjs");
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/json/list") response.end("[]");
    else if (request.url === "/json/version") response.end("{}");
    else {
      response.statusCode = 404;
      response.end("{}");
    }
  });
  let child;
  try {
    await mkdir(packageRoot, { recursive: true });
    await mkdir(driverDirectory, { recursive: true });
    await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
      name: "playwright-core",
      version: "0.0.0-test",
      main: "index.cjs",
    }), "utf8");
    await writeFile(
      path.join(packageRoot, "index.cjs"),
      'module.exports = { chromium: { connectOverCDP: async () => { throw new Error("NODE_PATH_PLAYWRIGHT_CORE_RESOLVED"); } } };\n',
      "utf8",
    );
    await writeFile(driverPath, loaded.module.SAND_BROWSER_DRIVER_SOURCE, "utf8");
    await assert.rejects(access(path.join(runtimeRoot, "node_modules")), { code: "ENOENT" });

    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    assert.equal(typeof address, "object");
    assert.ok(address !== null);

    child = spawn(process.execPath, [driverPath, "--request-stdin"], {
      cwd: runtimeRoot,
      env: {
        ...process.env,
        NODE_PATH: dependencyRoot,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const responseKey = randomBytes(32);
    child.stdin.end(`${Buffer.from(JSON.stringify({
      request: {
        cdpPort: address.port,
        display: 1,
        op: "snapshot",
      },
      responseKey: responseKey.toString("hex"),
    })).toString("base64")}\n`);
    const exit = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("generated Browser driver runtime test timed out"));
      }, 10_000);
      child.once("error", error => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timeout);
        resolve({ code, signal });
      });
    });
    child = undefined;

    assert.deepEqual(exit, { code: 0, signal: null }, stderr);
    assert.match(stdout, /__SAND_BROWSER_STDIN_READY__/);
    const marker = "__SAND_BROWSER_ENCRYPTED_RESULT__";
    const encodedPacket = stdout.slice(stdout.lastIndexOf(marker) + marker.length).trim().split(/\r?\n/u, 1)[0];
    assert.match(encodedPacket, /^[A-Za-z0-9+/]+={0,2}$/);
    const packet = Buffer.from(encodedPacket, "base64");
    assert.equal(packet[0], 1);
    const decipher = createDecipheriv("aes-256-gcm", responseKey, packet.subarray(1, 13));
    decipher.setAAD(Buffer.from("sand-browser-result-v1", "utf8"));
    decipher.setAuthTag(packet.subarray(13, 29));
    const result = JSON.parse(Buffer.concat([
      decipher.update(packet.subarray(29)),
      decipher.final(),
    ]).toString("utf8"));
    assert.deepEqual(result, {
      ok: false,
      error: "NODE_PATH_PLAYWRIGHT_CORE_RESOLVED",
    });
    assert.equal(stdout.includes(result.error), false);
    assert.doesNotMatch(loaded.module.SAND_BROWSER_DRIVER_SOURCE, /await import\(["']playwright-core["']\)/);
    assert.equal(
      loaded.module.SAND_BROWSER_DRIVER_SOURCE.match(/cipher\.setAAD\(RESULT_AAD\)/g)?.length,
      1,
    );
  } finally {
    child?.kill("SIGKILL");
    await new Promise(resolve => server.close(() => resolve()));
    await rm(runtimeRoot, { recursive: true, force: true });
    await rm(loaded.directory, { recursive: true, force: true });
  }
});

test("generated Browser driver migrates legacy URL state to fingerprints and re-adopts a discarded tab", async () => {
  const loaded = await loadModule();
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "grok-browser-state-runtime-"));
  const dependencyRoot = path.join(runtimeRoot, "node-path-deps");
  const packageRoot = path.join(dependencyRoot, "playwright-core");
  const driverPath = path.join(runtimeRoot, "driver.mjs");
  const display = 20_000 + randomBytes(2).readUInt16BE(0);
  // A leading slash is drive-relative on Windows. Resolve it from the child
  // cwd so parent and child address the same C:/tmp-style driver state even
  // when the checkout and runner temp directory are on different drives.
  const statePath = path.resolve(runtimeRoot, `/tmp/.sand-browser/views-${display}.json`);
  const lockPath = `${statePath}.lock`;
  const token = "LEGACY-QUERY-TOKEN-c39211";
  const pageUrl = `https://example.test/private/report?access_token=${token}&mode=full`;
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/json/list") response.end("[]");
    else if (request.url === "/json/version") response.end("{}");
    else {
      response.statusCode = 404;
      response.end("{}");
    }
  });
  let child;
  try {
    await mkdir(packageRoot, { recursive: true });
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
      name: "playwright-core",
      version: "0.0.0-state-test",
      main: "index.cjs",
    }), "utf8");
    await writeFile(path.join(packageRoot, "index.cjs"), `
const pageUrl = ${JSON.stringify(pageUrl)};
const page = {
  isClosed: () => false,
  url: () => pageUrl,
  title: async () => "Private report",
  setDefaultTimeout() {},
};
const context = {
  pages: () => [page],
  newPage: async () => { throw new Error("unexpected new page"); },
  newCDPSession: async () => ({
    send: async (method) => {
      if (method === "Target.getTargetInfo") {
        return { targetInfo: { targetId: "revived-target" } };
      }
      throw new Error("unexpected CDP method " + method);
    },
    detach: async () => {},
  }),
};
module.exports = {
  chromium: {
    connectOverCDP: async () => ({
      contexts: () => [context],
      newContext: async () => context,
      close: async () => {},
    }),
  },
};
`, "utf8");
    await writeFile(driverPath, loaded.module.SAND_BROWSER_DRIVER_SOURCE, "utf8");
    await writeFile(statePath, JSON.stringify({
      views: { "view-private": "discarded-target" },
      urls: { "view-private": pageUrl },
      lastViewId: "view-private",
    }), { mode: 0o600 });

    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    assert.equal(typeof address, "object");
    assert.ok(address !== null);

    child = spawn(process.execPath, [driverPath, "--request-stdin"], {
      cwd: runtimeRoot,
      env: { ...process.env, NODE_PATH: dependencyRoot },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const responseKey = randomBytes(32);
    child.stdin.end(`${Buffer.from(JSON.stringify({
      request: {
        cdpPort: address.port,
        display,
        op: "screenshot",
        viewId: "view-private",
      },
      responseKey: responseKey.toString("hex"),
    })).toString("base64")}\n`);
    const exit = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("generated Browser state migration test timed out"));
      }, 15_000);
      child.once("error", error => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timeout);
        resolve({ code, signal });
      });
    });
    child = undefined;

    assert.deepEqual(exit, { code: 0, signal: null }, stderr);
    assert.match(stdout, /__SAND_BROWSER_ENCRYPTED_RESULT__/);
    assert.equal(stdout.includes(token), false);
    assert.equal(stdout.includes(pageUrl), false);
    const rawState = await readFile(statePath, "utf8");
    const state = JSON.parse(rawState);
    assert.equal(rawState.includes(token), false);
    assert.equal(rawState.includes(pageUrl), false);
    assert.equal(Object.hasOwn(state, "urls"), false);
    assert.deepEqual(state, {
      views: { "view-private": "revived-target" },
      urlFingerprints: {
        "view-private": createHash("sha256").update(pageUrl, "utf8").digest("hex"),
      },
      lastViewId: "view-private",
    });
    await assert.rejects(access(lockPath), { code: "ENOENT" });
    assert.deepEqual(
      (await readdir(path.dirname(statePath)))
        .filter(name => name.startsWith(`views-${display}.json`)),
      [`views-${display}.json`],
    );
  } finally {
    child?.kill("SIGKILL");
    await new Promise(resolve => server.close(() => resolve()));
    await rm(statePath, { force: true });
    await rm(lockPath, { force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
    await rm(loaded.directory, { recursive: true, force: true });
  }
});

test("Computer adapter consumes streamed JSON, forwards execution identity, and renders its screenshot inline", async () => {
  const loaded = await loadModule();
  try {
    const calls = [];
    const screenshot = Buffer.from("computer-image").toString("base64");
    const tool = loaded.module.createTurnComputerToolFactory({
      dependencies: {
        resourceAccessor: { get: () => undefined },
        async execute(context, args) {
          calls.push({ context, args });
          return {
            result: {
              case: "success",
              value: { screenshot, cursorPosition: { x: 14, y: 22 } },
            },
          };
        },
        getPersistImage: () => undefined,
      },
    })();
    const context = loaded.module.createContext().withName("computer-test");
    const interaction = createInteractionHandler();
    const execution = await loaded.module.executeToolResultOrError(
      tool,
      context,
      interaction,
      argumentStream('{"action":"cl', 'ick","x":14,"y":22}'),
      { toolCallId: "computer-call", stateHandler: { id: "state" }, workspacePaths: ["C:/work"] },
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].context, interaction.started[0].context);
    assert.equal(calls[0].args.toolCallId, "computer-call");
    assert.deepEqual(calls[0].args.actions.map((action) => action.action.case), ["click", "screenshot"]);
    assert.equal(interaction.started[0].toolCallId, "computer-call");
    assert.deepEqual(
      interaction.started[0].toolCall.tool.value.args.actions.map((action) => action.action.case),
      ["click", "screenshot"],
    );
    assert.equal(interaction.completed[0].toolCall.tool.case, "computerUseToolCall");
    assert.equal(typeof execution.result.toJson, "function");

    const rendered = await loaded.module.renderToolResultOrError(context, tool, execution, {});
    assert.equal(rendered.isError, false);
    assert.deepEqual(rendered.content.at(-1), {
      type: "image",
      data: screenshot,
      mimeType: "image/webp",
    });
    assert.match(rendered.content[0].text, /Cursor is at \(14, 22\)/);
  } finally {
    await rm(loaded.directory, { recursive: true, force: true });
  }
});

test("Screenshot adapter accepts an empty streamed object and renders WebP inline", async () => {
  const loaded = await loadModule();
  try {
    const calls = [];
    const screenshot = Buffer.from("desktop-image").toString("base64");
    const tool = loaded.module.createTurnScreenshotToolFactory({
      dependencies: {
        resourceAccessor: { get: () => undefined },
        async execute(context, args) {
          calls.push({ context, args });
          return { result: { case: "success", value: { screenshot } } };
        },
        getPersistImage: () => undefined,
      },
    })();
    const context = loaded.module.createContext();
    const interaction = createInteractionHandler();
    const execution = await loaded.module.executeToolResultOrError(
      tool,
      context,
      interaction,
      argumentStream("{", "}"),
      { toolCallId: "screenshot-call" },
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].args.toolCallId, "screenshot-call");
    assert.deepEqual(calls[0].args.actions.map((action) => action.action.case), ["screenshot"]);
    assert.deepEqual(
      interaction.started[0].toolCall.tool.value.args.actions.map((action) => action.action.case),
      ["screenshot"],
    );
    const rendered = await loaded.module.renderToolResultOrError(context, tool, execution, {});
    assert.equal(rendered.isError, false);
    assert.deepEqual(rendered.content.at(-1), {
      type: "image",
      data: screenshot,
      mimeType: "image/webp",
    });
  } finally {
    await rm(loaded.directory, { recursive: true, force: true });
  }
});

test("Browser adapter executes the raw driver with streamed args and preserves PNG output inline", async () => {
  const loaded = await loadModule();
  try {
    const shellCalls = [];
    const uploads = [];
    const screenshotLifecycle = [];
    const imageBytes = Buffer.from("browser-image");
    const tools = loaded.module.createTurnBrowserToolFactory({
      dependencies: browserDependencies({
        async uploadFile(context, boxId, filePath, bytes) {
          uploads.push({ context, boxId, filePath, bytes: Buffer.from(bytes) });
        },
        async downloadFile(_context, _boxId, filePath) {
          screenshotLifecycle.push(["download-start", filePath]);
          await Promise.resolve();
          screenshotLifecycle.push(["download-end", filePath]);
          return imageBytes;
        },
        async removeFile(_context, _boxId, filePath) {
          screenshotLifecycle.push(["remove", filePath]);
        },
        async executeShellWithInput(context, input, stdin) {
          shellCalls.push({ context, input, stdin });
          return {
            case: "success",
            stdout: encryptedBrowserResult(stdin, {
              ok: true,
              summary: "Took a screenshot",
              screenshot: true,
            }),
            exitCode: 0,
          };
        },
      }),
    })();
    const tool = tools.find((candidate) => candidate.name === "browser_take_screenshot");
    const context = loaded.module.createContext().withName("browser-test");
    const interaction = createInteractionHandler();
    const execution = await loaded.module.executeToolResultOrError(
      tool,
      context,
      interaction,
      argumentStream('{"full', 'Page":true}'),
      { toolCallId: "browser-call", stateHandler: { id: "state" }, workspacePaths: ["C:/work"] },
    );

    assert.equal(shellCalls.length, 1);
    assert.equal(shellCalls[0].context, interaction.started[0].context);
    assert.equal(shellCalls[0].input.toolCallId, "sand-browser-screenshot-browser-call");
    assert.equal(shellCalls[0].input.name, "node");
    assert.equal(shellCalls[0].input.command, "node /tmp/.sand-browser/driver-v5.mjs --request-stdin");
    const syntax = spawnSync("sh", ["-n", "-c", shellCalls[0].input.command], { encoding: "utf8" });
    assert.equal(syntax.status, 0, syntax.stderr);
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].filePath, "/tmp/.sand-browser/driver-v5.mjs");
    assert.equal(uploads.some((entry) => entry.filePath.includes("request-")), false);
    const request = decodeBrowserStdin(shellCalls[0].stdin).request;
    assert.equal(request.op, "screenshot");
    assert.equal(request.fullPage, true);
    assert.equal(request.viewId, "view-1");
    assert.deepEqual(screenshotLifecycle, [
      ["download-start", "/tmp/.sand-browser/shot-browser-call.png"],
      ["download-end", "/tmp/.sand-browser/shot-browser-call.png"],
      ["remove", "/tmp/.sand-browser/shot-browser-call.png"],
    ]);
    assert.equal(interaction.started[0].toolCall.tool.case, "communicateUpdateToolCall");
    assert.match(
      interaction.started[0].toolCall.tool.value.args.currentStep,
      /"tool":"browser_take_screenshot"/,
    );
    assert.equal(interaction.completed[0].toolCall.tool.case, "communicateUpdateToolCall");
    assert.equal(typeof execution.result.toJson, "function");

    const rendered = await loaded.module.renderToolResultOrError(context, tool, execution, {});
    assert.equal(rendered.isError, false);
    assert.deepEqual(rendered.content.at(-1), {
      type: "image",
      data: imageBytes.toString("base64"),
      mimeType: "image/png",
    });
    assert.match(rendered.content[0].text, /Took a screenshot/);
  } finally {
    await rm(loaded.directory, { recursive: true, force: true });
  }
});

test("Browser secrets travel only through non-echoed stdin, never files, terminal output, or audited commands", async () => {
  const loaded = await loadModule();
  try {
    const uploads = [];
    const shellCalls = [];
    const removals = [];
    const dependencies = browserDependencies({
      async uploadFile(context, boxId, filePath, bytes) {
        uploads.push({ context, boxId, filePath, bytes: Buffer.from(bytes) });
      },
      async executeShellWithInput(context, input, stdin) {
        const stdout = encryptedBrowserResult(stdin, { ok: true, summary: "Done" });
        shellCalls.push({ context, input, stdin, stdout });
        return {
          case: "success",
          stdout,
          exitCode: 0,
        };
      },
      async removeFile(_context, _boxId, filePath) {
        removals.push(filePath);
      },
    });
    const tools = loaded.module.createTurnBrowserToolFactory({ dependencies })();
    const secretCases = [
      ["browser_type", { ref: "field-1", text: "TYPE-SECRET-71c05d" }],
      ["browser_fill", { ref: "field-2", value: "FILL-SECRET-92e84a" }],
      ["browser_cdp", { method: "Runtime.evaluate", params: { expression: "CDP-SECRET-36ab19" } }],
    ];
    const secrets = ["TYPE-SECRET-71c05d", "FILL-SECRET-92e84a", "CDP-SECRET-36ab19"];
    const context = loaded.module.createContext().withName("browser-secret-audit");
    const interactions = [];
    for (const [name, args] of secretCases) {
      const interaction = createInteractionHandler();
      interactions.push(interaction);
      const tool = tools.find((candidate) => candidate.name === name);
      const execution = await loaded.module.executeToolResultOrError(
        tool,
        context,
        interaction,
        argumentStream(JSON.stringify(args)),
        { toolCallId: `${name}-secret-call` },
      );
      const rendered = await loaded.module.renderToolResultOrError(context, tool, execution, {});
      assert.equal(rendered.isError, false);
    }

    assert.equal(uploads.filter((entry) => entry.filePath.includes("request-")).length, 0);
    assert.equal(uploads.filter((entry) => entry.filePath.endsWith("driver-v5.mjs")).length, 1);
    assert.equal(shellCalls.length, secretCases.length);
    assert.deepEqual(removals, secretCases.map(([name]) =>
      `/tmp/.sand-browser/shot-${name}-secret-call.png`));

    for (const [auditIndex, call] of shellCalls.entries()) {
      const command = call.input.command;
      const action = { kind: "shellCommand", command, shellKind: "foreground", target: "box" };
      const record = { occurredAtMs: 1, agentId: "agent-1", turnId: "turn-1", boxId: "box-1", action };
      const localAudit = loaded.module.localAuditJsonlLine(record, `event-${auditIndex}`);
      const remoteAudit = JSON.stringify(loaded.module.toProtoAuditEventData({ ...record, eventId: `event-${auditIndex}` }).toJson());
      for (const secret of secrets) {
        const encoded = Buffer.from(secret).toString("base64");
        assert.equal(command.includes(secret), false);
        assert.equal(command.includes(encoded), false);
        assert.equal(localAudit.includes(secret), false);
        assert.equal(localAudit.includes(encoded), false);
        assert.equal(remoteAudit.includes(secret), false);
        assert.equal(remoteAudit.includes(encoded), false);
        assert.equal(call.stdin.includes(secret), false);
        assert.equal(call.stdout.includes(secret), false);
        assert.equal(call.stdout.includes(encoded), false);
        assert.equal(call.input.command.includes(secret), false);
        assert.equal(call.input.command.includes(encoded), false);
      }
      const decoded = decodeBrowserStdin(call.stdin);
      assert.deepEqual(decoded.request, {
        ...secretCases[auditIndex][1],
        op: secretCases[auditIndex][0].replace("browser_", "").replace("take_screenshot", "screenshot"),
        display: 0,
        cdpPort: 9222,
        viewId: "view-1",
        screenshotPath: `/tmp/.sand-browser/shot-${secretCases[auditIndex][0]}-secret-call.png`,
      });
      for (const secret of secrets) assert.equal(call.input.command.includes(secret), false);
      for (const secret of secrets) assert.equal(call.input.command.includes(Buffer.from(secret).toString("base64")), false);
    }

    for (const call of shellCalls) {
      const command = call.input.command;
      assert.equal(spawnSync("sh", ["-n", "-c", command]).status, 0);
      assert.equal(command, "node /tmp/.sand-browser/driver-v5.mjs --request-stdin");
      for (const secret of secrets) {
        assert.equal(call.input.command.includes(secret), false);
        assert.equal(call.input.command.includes(Buffer.from(secret).toString("base64")), false);
      }
    }
    const carrier = JSON.stringify(interactions.flatMap((interaction) => [interaction.started, interaction.completed]));
    for (const secret of secrets) assert.equal(carrier.includes(secret), false);
    assert.match(loaded.module.SAND_BROWSER_DRIVER_SOURCE, /setRawMode\(true\)/);
    assert.match(loaded.module.SAND_BROWSER_DRIVER_SOURCE, /STDIN_READY_MARKER/);
    assert.match(loaded.module.SAND_BROWSER_DRIVER_SOURCE, /process\.stdin\.on\("data"/);
    assert.match(loaded.module.SAND_BROWSER_DRIVER_SOURCE, /createCipheriv\("aes-256-gcm"/);
    assert.match(loaded.module.SAND_BROWSER_DRIVER_SOURCE, /await res\.body\?\.cancel\(\)/);
    assert.match(loaded.module.SAND_BROWSER_DRIVER_SOURCE, /process\.exitCode = 0/);
    const driverPath = path.join(loaded.directory, "driver-v5.mjs");
    await writeFile(driverPath, loaded.module.SAND_BROWSER_DRIVER_SOURCE);
    const driverSyntax = spawnSync(process.execPath, ["--check", driverPath], { encoding: "utf8" });
    assert.equal(driverSyntax.status, 0, driverSyntax.stderr);
  } finally {
    await rm(loaded.directory, { recursive: true, force: true });
  }
});

test("Browser accepts only generic pre-key plaintext failures and never renders raw terminal detail", async () => {
  const loaded = await loadModule();
  try {
    assert.deepEqual(
      loaded.module.parseDriverResponse(
        '__SAND_BROWSER_RESULT__{"ok":false,"error":"Browser driver request channel failed"}\n',
      ),
      { ok: false, error: "Browser driver request channel failed" },
    );
    const secret = "RAW-TERMINAL-PAGE-TOKEN-77a921";
    assert.equal(
      loaded.module.parseDriverResponse(
        `__SAND_BROWSER_RESULT__${JSON.stringify({ ok: false, error: secret })}\n`,
      ),
      undefined,
    );

    const removals = [];
    const tools = loaded.module.createTurnBrowserToolFactory({
      dependencies: browserDependencies({
        async executeShellWithInput() {
          return {
            case: "success",
            stdout: `driver noise ${secret}\n__SAND_BROWSER_RESULT__${JSON.stringify({ ok: false, error: secret })}\n`,
            stderr: `runtime detail ${secret}`,
            exitCode: 1,
          };
        },
        async removeFile(_context, _boxId, filePath) {
          removals.push(filePath);
        },
      }),
    })();
    const tool = tools.find((candidate) => candidate.name === "browser_snapshot");
    const context = loaded.module.createContext();
    const execution = await loaded.module.executeToolResultOrError(
      tool,
      context,
      createInteractionHandler(),
      argumentStream("{}"),
      { toolCallId: "browser-raw-terminal" },
    );
    const rendered = await loaded.module.renderToolResultOrError(context, tool, execution, {});
    assert.equal(rendered.isError, true);
    assert.match(rendered.content[0].text, /no authenticated result/);
    assert.equal(rendered.content[0].text.includes(secret), false);
    assert.deepEqual(removals, ["/tmp/.sand-browser/shot-browser-raw-terminal.png"]);
  } finally {
    await rm(loaded.directory, { recursive: true, force: true });
  }
});

test("Browser transport failure leaves no request file or secret in the command", async () => {
  const loaded = await loadModule();
  try {
    const uploads = [];
    const shellCalls = [];
    const removals = [];
    const secret = "FAILURE-SECRET-f6d1a0";
    const tools = loaded.module.createTurnBrowserToolFactory({
      dependencies: browserDependencies({
        async uploadFile(_context, _boxId, filePath, bytes) {
          uploads.push({ filePath, bytes: Buffer.from(bytes) });
        },
        async executeShellWithInput(_context, input, stdin) {
          shellCalls.push({ input, stdin });
          throw new Error("executor unavailable before spawn");
        },
        async removeFile(context, boxId, filePath) {
          removals.push({ context, boxId, filePath });
        },
      }),
    })();
    const tool = tools.find((candidate) => candidate.name === "browser_type");
    const context = loaded.module.createContext();
    const interaction = createInteractionHandler();
    const execution = await loaded.module.executeToolResultOrError(
      tool,
      context,
      interaction,
      argumentStream(JSON.stringify({ ref: "field", text: secret })),
      { toolCallId: "browser-failure-secret" },
    );
    const rendered = await loaded.module.renderToolResultOrError(context, tool, execution, {});
    assert.equal(rendered.isError, true);
    assert.match(rendered.content[0].text, /executor unavailable before spawn/);
    assert.equal(uploads.some((entry) => entry.filePath.includes("request-")), false);
    assert.equal(shellCalls.length, 1);
    assert.equal(shellCalls[0].input.command.includes(secret), false);
    assert.equal(shellCalls[0].input.command.includes(Buffer.from(secret).toString("base64")), false);
    assert.equal(shellCalls[0].stdin.includes(secret), false);
    assert.equal(shellCalls[0].stdin.includes(Buffer.from(secret).toString("base64")), false);
    assert.equal(decodeBrowserStdin(shellCalls[0].stdin).request.text, secret);
    assert.equal(removals.length, 1);
    assert.equal(removals[0].boxId, "box-1");
    assert.equal(removals[0].filePath, "/tmp/.sand-browser/shot-browser-failure-secret.png");
  } finally {
    await rm(loaded.directory, { recursive: true, force: true });
  }
});

test("Browser caller abort after stdin transport leaves no request carrier at rest", async () => {
  const loaded = await loadModule();
  try {
    const shellCalls = [];
    const uploads = [];
    const removals = [];
    const secret = "UPLOAD-ACK-SECRET-2fc091";
    const tools = loaded.module.createTurnBrowserToolFactory({
      dependencies: browserDependencies({
        async uploadFile(_context, _boxId, filePath, bytes) {
          uploads.push({ filePath, bytes: Buffer.from(bytes) });
        },
        async executeShellWithInput(_context, input, stdin) {
          shellCalls.push({ input, stdin });
          cancel(new Error("caller canceled"));
          throw new Error("stdin acknowledgement lost");
        },
        async removeFile(context, boxId, filePath) {
          removals.push({ context, boxId, filePath, aborted: context.signal.aborted });
        },
      }),
    })();
    const tool = tools.find((candidate) => candidate.name === "browser_fill");
    const [context, cancel] = loaded.module.createContext().withCancel();
    const execution = await loaded.module.executeToolResultOrError(
      tool,
      context,
      createInteractionHandler(),
      argumentStream(JSON.stringify({ ref: "field", value: secret })),
      { toolCallId: "browser-stdin-ack-loss" },
    );
    const rendered = await loaded.module.renderToolResultOrError(
      context,
      tool,
      execution,
      {},
    );

    assert.equal(rendered.isError, true);
    assert.match(rendered.content[0].text, /stdin acknowledgement lost/);
    assert.equal(context.signal.aborted, true);
    assert.equal(uploads.some((entry) => entry.filePath.includes("request-")), false);
    assert.equal(shellCalls.length, 1);
    for (const call of shellCalls) {
      assert.equal(call.input.command.includes(secret), false);
      assert.equal(call.input.command.includes(Buffer.from(secret).toString("base64")), false);
      assert.equal(decodeBrowserStdin(call.stdin).request.value, secret);
    }
    assert.deepEqual(removals.map(({ boxId, filePath, aborted }) => ({ boxId, filePath, aborted })), [{
      boxId: "box-1",
      filePath: "/tmp/.sand-browser/shot-browser-stdin-ack-loss.png",
      aborted: true,
    }]);
  } finally {
    await rm(loaded.directory, { recursive: true, force: true });
  }
});

test("native 9Router model step executes a real Browser tool and continues to a final response", async () => {
  const priorFetch = globalThis.fetch;
  const priorDataRoot = process.env.SAND_DATA_ROOT;
  const loaded = await loadModule();
  process.env.SAND_DATA_ROOT = loaded.directory;
  try {
    loaded.module.installCliProxyCredentialLease({
      baseUrl: "http://127.0.0.1:20128/v1",
      model: "provider/native-tool-model",
      protocol: "chat-completions",
      allowRemoteHttps: false,
      allowTailscaleHttp: false,
      apiKey: "integration-secret",
    });
    const requests = [];
    let modelStep = 0;
    globalThis.fetch = async (_url, init) => {
      requests.push(JSON.parse(init.body));
      modelStep += 1;
      return modelStep === 1
        ? sse([
          {
            id: "router-tool-step",
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: "browser-tool-call",
                  function: {
                    name: "browser_take_screenshot",
                    arguments: '{"fullPage":true}',
                  },
                }],
              },
            }],
          },
          { id: "router-tool-step", choices: [], usage: { prompt_tokens: 10, completion_tokens: 3 } },
        ])
        : sse([
          { id: "router-final-step", choices: [{ delta: { content: "Screenshot checked." } }] },
          { id: "router-final-step", choices: [], usage: { prompt_tokens: 14, completion_tokens: 2 } },
        ]);
    };

    const imageBytes = Buffer.from("native-loop-browser-image");
    const browserTools = loaded.module.createTurnBrowserToolFactory({
      dependencies: browserDependencies({
        downloadFile: async () => imageBytes,
        executeShellWithInput: async (_context, _input, stdin) => ({
          case: "success",
          stdout: encryptedBrowserResult(stdin, {
            ok: true,
            summary: "Captured native-loop screenshot",
            screenshot: true,
          }),
          exitCode: 0,
        }),
      }),
    })();
    const browserTool = browserTools.find((candidate) => candidate.name === "browser_take_screenshot");
    const definitions = loaded.module.toAgentTools([browserTool]);
    const session = loaded.module.createProviderPromptSession("cli-proxy");
    const executor = session.getExecutor();
    executor.appendMessages([{ role: "user", content: "Check the browser." }]);
    const logEntries = [];
    const context = loaded.module.createContext().with(loaded.module.loggerKey, {
      log(_context, entry) {
        logEntries.push(entry);
      },
    });

    const first = executor.stream(context, "native-loop-1", definitions);
    const firstEvents = await collect(first.fullStream);
    const toolCall = firstEvents.find((event) => event.type === "tool-call");
    assert.deepEqual(toolCall, {
      type: "tool-call",
      toolCallId: "browser-tool-call",
      toolName: "browser_take_screenshot",
      args: { fullPage: true },
    });
    const firstResponse = await first.response;
    executor.appendMessages(firstResponse.messages);

    const interaction = createInteractionHandler();
    const toolResultMessage = await loaded.module.executeDeferredToolCall(
      context,
      {
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        args: toolCall.args,
      },
      { [toolCall.toolName]: browserTool },
      interaction,
      {},
      undefined,
      {},
      undefined,
      undefined,
      new Set(),
    );
    const imageB64 = imageBytes.toString("base64");
    const toolResultPart = toolResultMessage.content[0];
    assert.equal(toolResultPart.result, "Captured native-loop screenshot");
    assert.deepEqual(toolResultPart.experimental_content, [{
      type: "text",
      text: "Captured native-loop screenshot",
    }, {
      type: "image",
      data: imageB64,
      mimeType: "image/png",
    }]);
    assert.equal(toolResultPart.result.includes(imageB64), false);
    assert.equal(
      JSON.stringify(interaction.completed[0].toolCall.toJson()).includes(imageB64),
      false,
    );
    assert.equal(
      JSON.stringify(toolResultMessage.providerOptions.cursor.highLevelToolCallResult).includes(imageB64),
      false,
    );
    assert.equal(JSON.stringify(logEntries).includes(imageB64), false);
    assert.equal(JSON.stringify(toolResultPart.experimental_content).includes(imageB64), true);
    executor.appendMessages([toolResultMessage]);

    const second = executor.stream(context, "native-loop-2", definitions);
    assert.deepEqual(await collect(second.fullStream), [{
      type: "text-delta",
      textDelta: "Screenshot checked.",
    }]);
    assert.equal((await second.response).messages[0].content[0].text, "Screenshot checked.");
    assert.equal(requests.length, 2);
    assert.equal(requests[0].tools[0].function.name, "browser_take_screenshot");
    assert.equal(requests[0].tools[0].function.parameters.type, "object");
    assert.equal(Object.hasOwn(requests[0].tools[0].function.parameters, "jsonSchema"), false);
    assert.deepEqual(requests[1].messages.slice(-3), [
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "browser-tool-call",
          type: "function",
          function: { name: "browser_take_screenshot", arguments: '{"fullPage":true}' },
        }],
      },
      { role: "tool", tool_call_id: "browser-tool-call", content: "Captured native-loop screenshot" },
      {
        role: "user",
        content: [{
          type: "text",
          text: "Visual output returned by the preceding Grok Bot tool call.",
        }, {
          type: "image_url",
          image_url: { url: `data:image/png;base64,${imageB64}` },
        }],
      },
    ]);
    assert.equal(JSON.stringify(requests[1].messages.at(-2)).includes(imageB64), false);
    assert.equal(JSON.stringify(requests[1].messages.at(-1)).includes(imageB64), true);
    assert.equal(JSON.stringify(requests).includes("integration-secret"), false);
  } finally {
    loaded.module.clearCliProxyCredentialLease();
    globalThis.fetch = priorFetch;
    if (priorDataRoot === undefined) delete process.env.SAND_DATA_ROOT;
    else process.env.SAND_DATA_ROOT = priorDataRoot;
    await rm(loaded.directory, { recursive: true, force: true });
  }
});

test("Browser adapter serializes Zod argument errors into a generated ToolCall and renders an error", async () => {
  const loaded = await loadModule();
  try {
    let shellCalls = 0;
    const tools = loaded.module.createTurnBrowserToolFactory({
      dependencies: browserDependencies({
        executeShellWithInput: async () => {
          shellCalls += 1;
          return { case: "success", stdout: "", exitCode: 0 };
        },
      }),
    })();
    const tool = tools.find((candidate) => candidate.name === "browser_navigate");
    const context = loaded.module.createContext();
    const interaction = createInteractionHandler();
    const execution = await loaded.module.executeToolResultOrError(
      tool,
      context,
      interaction,
      argumentStream('{"url":', "42}"),
      { toolCallId: "invalid-browser-call" },
    );

    assert.equal(shellCalls, 0);
    assert.equal(execution.errorClassification, "invalid_args");
    assert.equal(interaction.errors.length, 1);
    assert.ok(interaction.errors[0].toolCall instanceof loaded.module.ToolCall);
    assert.equal(interaction.errors[0].toolCall.tool.case, "communicateUpdateToolCall");
    assert.equal(typeof execution.result.toJson, "function");

    const rendered = await loaded.module.renderToolResultOrError(context, tool, execution, {});
    assert.equal(rendered.isError, true);
    assert.match(rendered.content[0].text, /Invalid arguments/);
    assert.match(rendered.content[0].text, /url/);
  } finally {
    await rm(loaded.directory, { recursive: true, force: true });
  }
});

test("Computer adapter forwards signal, state handler, and workspace paths through auto-review", async () => {
  const loaded = await loadModule();
  try {
    const stateHandler = { id: "state-handler" };
    const workspacePaths = ["C:/repo", "D:/second"];
    const overrideController = new AbortController();
    let observedStateHandler;
    let observedWorkspacePaths;
    let observedApprovalSignal;
    let observedToolCallId;
    let computerExecutions = 0;
    const shellExecutor = {
      execute: async () => ({
        result: { case: "success", value: { exitCode: 0, stdout: "[]" } },
      }),
    };
    const classifierExecutor = {
      async execute(context, args) {
        observedWorkspacePaths = context.get(loaded.module.smartModeClassifierWorkspacePathsKey);
        observedToolCallId = args.toolCallId;
        return new loaded.module.SmartModeClassifierResult({
          result: {
            case: "success",
            value: new loaded.module.SmartModeClassifierSuccess({
              decision: loaded.module.SmartModeClassifierDecision.BLOCK,
              blockReason: "manual review",
            }),
          },
        });
      },
    };
    const tool = loaded.module.createTurnComputerToolFactory({
      dependencies: {
        resourceAccessor: {
          get(resource) {
            if (resource === loaded.module.shellExecutorResource) return shellExecutor;
            if (resource === loaded.module.smartModeClassifierExecutorResource) return classifierExecutor;
            throw new Error("unexpected resource");
          },
        },
        execute: async () => {
          computerExecutions += 1;
          return { result: { case: "success", value: {} } };
        },
        getPersistImage: () => undefined,
        autoReview: {
          mode: "enforce",
          agentId: "agent-1",
          boxIdentity: { boxId: "box-1", windowGeneration: "generation-1" },
          resolveDisplayNumber: async () => 1,
          extractConversationContext: async (_context, value) => {
            observedStateHandler = value;
            return [];
          },
          autoReviewController: {
            reportDisplayRecheckFailed: () => {},
            async requestApproval(request) {
              observedApprovalSignal = request.signal;
              return { approved: false, reason: "denied" };
            },
          },
        },
      },
    })();
    const context = loaded.module.createContext();
    const interaction = createInteractionHandler(overrideController.signal);
    const execution = await loaded.module.executeToolResultOrError(
      tool,
      context,
      interaction,
      argumentStream('{"action":"type","text":"hello"}'),
      { toolCallId: "review-call", stateHandler, workspacePaths },
    );

    assert.equal(computerExecutions, 0);
    assert.equal(observedStateHandler, stateHandler);
    assert.deepEqual(observedWorkspacePaths, workspacePaths);
    assert.equal(observedApprovalSignal, overrideController.signal);
    assert.equal(observedToolCallId, "review-call");
    assert.equal(execution.errorClassification, "error");
    const rendered = await loaded.module.renderToolResultOrError(context, tool, execution, {});
    assert.equal(rendered.isError, true);
    assert.match(rendered.content[0].text, /denied/);
  } finally {
    await rm(loaded.directory, { recursive: true, force: true });
  }
});

test("Browser adapter forwards signal, state handler, and workspace paths through auto-review", async () => {
  const loaded = await loadModule();
  try {
    const stateHandler = { id: "browser-state-handler" };
    const workspacePaths = ["C:/browser-repo"];
    const overrideController = new AbortController();
    let observedStateHandler;
    let observedWorkspacePaths;
    let observedApprovalSignal;
    let observedToolCallId;
    let driverExecutions = 0;
    const shellExecutor = {
      execute: async () => ({
        result: { case: "success", value: { exitCode: 0, stdout: "[]" } },
      }),
    };
    const classifierExecutor = {
      async execute(context, args) {
        observedWorkspacePaths = context.get(loaded.module.smartModeClassifierWorkspacePathsKey);
        observedToolCallId = args.toolCallId;
        return new loaded.module.SmartModeClassifierResult({
          result: {
            case: "success",
            value: new loaded.module.SmartModeClassifierSuccess({
              decision: loaded.module.SmartModeClassifierDecision.BLOCK,
              blockReason: "manual browser review",
            }),
          },
        });
      },
    };
    const tools = loaded.module.createTurnBrowserToolFactory({
      dependencies: browserDependencies({
        resourceAccessor: {
          get(resource) {
            if (resource === loaded.module.shellExecutorResource) return shellExecutor;
            if (resource === loaded.module.smartModeClassifierExecutorResource) return classifierExecutor;
            throw new Error("unexpected resource");
          },
        },
        executeShellWithInput: async () => {
          driverExecutions += 1;
          return { case: "success", stdout: "", exitCode: 0 };
        },
        autoReview: {
          mode: "enforce",
          agentId: "agent-1",
          boxIdentity: { boxId: "box-1", windowGeneration: "generation-1" },
          resolveDisplayNumber: async () => 1,
          extractConversationContext: async (_context, value) => {
            observedStateHandler = value;
            return [];
          },
          autoReviewController: {
            reportDisplayRecheckFailed: () => {},
            async requestApproval(request) {
              observedApprovalSignal = request.signal;
              return { approved: false, reason: "browser denied" };
            },
          },
        },
      }),
    })();
    const tool = tools.find((candidate) => candidate.name === "browser_type");
    const context = loaded.module.createContext();
    const interaction = createInteractionHandler(overrideController.signal);
    const execution = await loaded.module.executeToolResultOrError(
      tool,
      context,
      interaction,
      argumentStream('{"ref":"e1","text":"hello"}'),
      { toolCallId: "browser-review-call", stateHandler, workspacePaths },
    );

    assert.equal(driverExecutions, 0);
    assert.equal(observedStateHandler, stateHandler);
    assert.deepEqual(observedWorkspacePaths, workspacePaths);
    assert.equal(observedApprovalSignal, overrideController.signal);
    assert.equal(observedToolCallId, "browser-review-call");
    assert.equal(execution.error, undefined);
    const rendered = await loaded.module.renderToolResultOrError(context, tool, execution, {});
    assert.equal(rendered.isError, true);
    assert.match(rendered.content[0].text, /browser denied/);
  } finally {
    await rm(loaded.directory, { recursive: true, force: true });
  }
});
