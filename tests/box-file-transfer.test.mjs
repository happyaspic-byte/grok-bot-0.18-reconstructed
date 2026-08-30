import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, chown, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(import.meta.dirname, "..");

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-box-transfer-module-"));
  const output = path.join(temporary, "box-transfer.mjs");
  await symlink(
    path.join(repoRoot, "node_modules"),
    path.join(temporary, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await build({
    stdin: {
      contents: `
        import { createBoxRemoteResourceAccessor } from "./source/host/box/box-remote-accessor.ts";
        import { productionBoxGeneratedPorts } from "./source/host/box/generated-production.ts";
        export { startBoxExecDaemon, BOX_EXEC_DAEMON_INTERNAL_TRANSFER_ROOT } from "./source/box-exec-daemon/server.ts";
        export { uploadFileViaExecDaemon } from "./source/host/box/box-file-transfer.ts";
        export { createHostBrowserDriverDependencies, createHostShellExecutor } from "./source/host/runner/host-computer-tool-dependencies.ts";
        export { createContext } from "./source/packages/context/core.ts";
        export { shellExecutorResource } from "./source/packages/agent-exec/shell.ts";
        export { writeExecutorResource } from "./source/packages/agent-exec/write.ts";
        export const createAccessor = (endpoint) => createBoxRemoteResourceAccessor(endpoint, productionBoxGeneratedPorts);
      `,
      resolveDir: repoRoot,
      sourcefile: "box-transfer-entry.ts",
      loader: "ts",
    },
    outfile: output,
    bundle: true,
    packages: "external",
    format: "esm",
    platform: "node",
    target: "node22",
  });
  return {
    module: await import(`${pathToFileURL(output).href}?${Date.now()}`),
    dispose: () => rm(temporary, { recursive: true, force: true }),
  };
}

function success() {
  return { result: { case: "success", value: { exitCode: 0, stdout: "", stderr: "" } } };
}

test("atomic box upload removes its randomized part when rename fails", async () => {
  const loaded = await loadModule();
  try {
    const shellCalls = [];
    let written;
    const shellExecutor = {
      async execute(_context, args) {
        shellCalls.push(args);
        if (args.command.includes("mv -f --")) {
          return {
            result: {
              case: "failure",
              value: { exitCode: 1, signal: "", stderr: "rename failed", aborted: false },
            },
          };
        }
        return success();
      },
    };
    const writeExecutor = {
      async execute(_context, args) {
        written = { path: args.path, bytes: Buffer.from(args.fileBytes) };
        return { result: { case: "success", value: {} } };
      },
    };
    const accessor = {
      get(resource) {
        if (resource === loaded.module.shellExecutorResource) return shellExecutor;
        if (resource === loaded.module.writeExecutorResource) return writeExecutor;
        throw new Error("unexpected resource");
      },
    };

    await assert.rejects(
      () => loaded.module.uploadFileViaExecDaemon(
        loaded.module.createContext(),
        accessor,
        "/workspace/result.bin",
        Buffer.from("secret bytes"),
      ),
      /rename failed/,
    );
    assert.match(written.path, /^\/workspace\/result\.bin\.sand-[a-f0-9]{16}\.part$/);
    assert.equal(written.bytes.toString("utf8"), "secret bytes");
    assert.equal(shellCalls.length, 2);
    assert.equal(shellCalls.every((call) => call.workingDirectory === "/workspace"), true);
    assert.match(shellCalls[0].command, /mv -f --/);
    assert.equal(shellCalls[0].command.includes(written.path), true);
    assert.match(shellCalls[1].command, /rm -f --/);
    assert.equal(shellCalls[1].command.includes(written.path), true);
  } finally {
    await loaded.dispose();
  }
});

test("atomic box upload cleans its part without masking a lost rename acknowledgement", async () => {
  const loaded = await loadModule();
  try {
    const target = "/workspace/result-after-ack-loss.bin";
    const files = new Map();
    let partPath;
    const acknowledgementError = new Error("rename acknowledgement lost");
    const shellExecutor = {
      async execute(_context, args) {
        if (args.command.includes("mv -f --")) {
          files.set(target, files.get(partPath));
          files.delete(partPath);
          throw acknowledgementError;
        }
        if (args.command.includes("rm -f --") && partPath != null) files.delete(partPath);
        return success();
      },
    };
    const writeExecutor = {
      async execute(_context, args) {
        partPath = args.path;
        files.set(partPath, Buffer.from(args.fileBytes));
        return { result: { case: "success", value: {} } };
      },
    };
    const accessor = {
      get(resource) {
        if (resource === loaded.module.shellExecutorResource) return shellExecutor;
        if (resource === loaded.module.writeExecutorResource) return writeExecutor;
        throw new Error("unexpected resource");
      },
    };

    await assert.rejects(
      () => loaded.module.uploadFileViaExecDaemon(
        loaded.module.createContext(),
        accessor,
        target,
        Buffer.from("materialized"),
      ),
      (error) => error === acknowledgementError,
    );
    assert.equal(files.has(partPath), false);
    assert.equal(files.get(target).toString("utf8"), "materialized");
  } finally {
    await loaded.dispose();
  }
});

test("standalone exec daemon round-trips workspace and private Browser uploads", {
  skip: process.platform === "win32" ? "standalone daemon requires the Linux box shell" : false,
}, async () => {
  const loaded = await loadModule();
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-box-transfer-e2e-"));
  let daemon;
  try {
    const workspace = path.join(root, "workspace");
    const terminals = path.join(root, "terminals");
    const transfer = path.join(root, "private-transfer");
    await Promise.all([mkdir(workspace), mkdir(terminals), mkdir(transfer)]);
    daemon = await loaded.module.startBoxExecDaemon({
      host: "127.0.0.1",
      port: 0,
      authToken: "test-token",
      workspaceRoot: workspace,
      terminalsDirectory: terminals,
      internalTransferRoot: transfer,
    });
    const accessor = loaded.module.createAccessor({
      host: daemon.host,
      port: daemon.port,
      authToken: "test-token",
    });
    const context = loaded.module.createContext();

    const workspaceBytes = Buffer.from([0, 1, 2, 255]);
    const workspaceTarget = path.join(workspace, "nested", "payload.bin");
    await loaded.module.uploadFileViaExecDaemon(
      context,
      accessor,
      workspaceTarget,
      workspaceBytes,
    );
    assert.deepEqual(await readFile(workspaceTarget), workspaceBytes);

    const requestPath = path.join(daemon.internalTransferRoot, `request-${"a".repeat(32)}.json`);
    const requestBytes = Buffer.from('{"password":"not-in-command"}');
    await loaded.module.uploadFileViaExecDaemon(context, accessor, requestPath, requestBytes);
    assert.deepEqual(await readFile(requestPath), requestBytes);

    const outside = path.join(root, "outside", "blocked.bin");
    await assert.rejects(
      () => loaded.module.uploadFileViaExecDaemon(context, accessor, outside, Buffer.from("blocked")),
      /Path escapes configured workspace root/,
    );
    await assert.rejects(access(outside), { code: "ENOENT" });
    await assert.rejects(access(path.dirname(outside)), { code: "ENOENT" });

    const escapedDirectory = path.join(root, "escaped");
    await mkdir(escapedDirectory);
    await symlink(escapedDirectory, path.join(workspace, "escape"), "dir");
    await assert.rejects(
      () => loaded.module.uploadFileViaExecDaemon(
        context,
        accessor,
        path.join(workspace, "escape", "blocked.bin"),
        Buffer.from("blocked"),
      ),
      /Symbolic-link write parents are not permitted|Resolved path escapes configured roots/,
    );
    await assert.rejects(access(path.join(escapedDirectory, "blocked.bin")), { code: "ENOENT" });
    await assert.rejects(
      () => loaded.module.uploadFileViaExecDaemon(
        context,
        accessor,
        path.join(workspace, "escape", "new", "nested", "blocked.bin"),
        Buffer.from("blocked"),
      ),
      /Symbolic-link write parents are not permitted|Resolved path escapes configured roots/,
    );
    await assert.rejects(access(path.join(escapedDirectory, "new")), { code: "ENOENT" });

    const fileParent = path.join(workspace, "not-a-directory");
    await writeFile(fileParent, "unchanged");
    await assert.rejects(
      () => loaded.module.uploadFileViaExecDaemon(
        context,
        accessor,
        path.join(fileParent, "child.bin"),
        Buffer.from("blocked"),
      ),
      /Write parent is not a directory|ENOTDIR/,
    );
    assert.equal(await readFile(fileParent, "utf8"), "unchanged");
    assert.equal(
      loaded.module.BOX_EXEC_DAEMON_INTERNAL_TRANSFER_ROOT,
      path.join(os.tmpdir(), ".sand-browser"),
    );
  } finally {
    await daemon?.stop();
    await rm(root, { recursive: true, force: true });
    await loaded.dispose();
  }
});

test("standalone exec daemon assigns transfer roots, parents, and files to its shell identity", {
  skip: process.platform === "win32" || process.getuid?.() == null
    ? "requires a POSIX test process to exercise uid/gid ownership"
    : false,
}, async () => {
  const loaded = await loadModule();
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-box-transfer-owner-"));
  let daemon;
  try {
    // This sandbox may map only its current uid/gid. The assertions still
    // exercise every explicit shellIdentity ownership handoff; privileged CI
    // can substitute a distinct identity in an integration smoke.
    const uid = process.getuid();
    const gid = process.getgid();
    const workspace = path.join(root, "workspace");
    const terminals = path.join(root, "terminals");
    const transfer = path.join(root, "private-transfer");
    await chown(root, uid, gid);
    await mkdir(workspace);
    await chown(workspace, uid, gid);
    daemon = await loaded.module.startBoxExecDaemon({
      host: "127.0.0.1",
      port: 0,
      authToken: "test-token",
      workspaceRoot: workspace,
      terminalsDirectory: terminals,
      internalTransferRoot: transfer,
      shellIdentity: { username: "test-shell", uid, gid, home: "/tmp" },
    });
    const accessor = loaded.module.createAccessor({
      host: daemon.host,
      port: daemon.port,
      authToken: "test-token",
    });
    const target = path.join(workspace, "nested", "owned.bin");
    await loaded.module.uploadFileViaExecDaemon(
      loaded.module.createContext(),
      accessor,
      target,
      Buffer.from("owned"),
    );

    for (const ownedPath of [terminals, transfer, path.dirname(target), target]) {
      const info = await stat(ownedPath);
      assert.equal(info.uid, uid, ownedPath);
      assert.equal(info.gid, gid, ownedPath);
    }
    assert.equal(await readFile(target, "utf8"), "owned");
  } finally {
    await daemon?.stop();
    await rm(root, { recursive: true, force: true });
    await loaded.dispose();
  }
});

test("standalone daemon Browser stdin transport keeps request secrets out of files and cleans after caller abort", {
  skip: process.platform === "win32" ? "standalone daemon requires the Linux box shell" : false,
}, async () => {
  const loaded = await loadModule();
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-browser-stdin-e2e-"));
  const screenshotPath = `/tmp/.sand-browser/shot-production-cleanup-${process.pid}-${Date.now()}.png`;
  let daemon;
  try {
    const workspace = path.join(root, "workspace");
    const terminals = path.join(root, "terminals");
    const transfer = path.join(root, "private-transfer");
    await Promise.all([mkdir(workspace), mkdir(terminals), mkdir(transfer)]);
    const scriptPath = path.join(workspace, "stdin-driver.mjs");
    const secret = "PRIVATE-STDIN-SECRET-41f3";
    const expectedSecretHash = createHash("sha256").update(secret).digest("hex");
    await writeFile(scriptPath, `
import { createHash } from "node:crypto";
process.stdin.setEncoding("utf8");
process.stdout.write("__SAND_BROWSER_STDIN_READY__\\n");
let buffered = "";
process.stdin.on("data", chunk => {
  buffered += String(chunk);
  const newline = buffered.indexOf("\\n");
  if (newline < 0) return;
  process.stdin.removeAllListeners("data");
  const envelope = JSON.parse(Buffer.from(buffered.slice(0, newline).trim(), "base64").toString("utf8"));
  const receivedHash = createHash("sha256").update(String(envelope.request?.secret)).digest("hex");
  const ok = receivedHash === "${expectedSecretHash}";
  setTimeout(() => {
    const packet = Buffer.from(ok ? "opaque-result" : "bad-request").toString("base64");
    process.stdout.write("__SAND_BROWSER_ENCRYPTED_RESULT__" + packet + "\\n");
    process.exit(ok ? 0 : 1);
  }, 1500);
});
`);
    daemon = await loaded.module.startBoxExecDaemon({
      host: "127.0.0.1",
      port: 0,
      authToken: "test-token",
      workspaceRoot: workspace,
      terminalsDirectory: terminals,
      internalTransferRoot: transfer,
    });
    const accessor = loaded.module.createAccessor({
      host: daemon.host,
      port: daemon.port,
      authToken: "test-token",
    });
    const audited = [];
    const shell = loaded.module.createHostShellExecutor({
      resourceAccessor: accessor,
      assertNoPendingApproval() {},
      auditShellCommand(command) { audited.push(command); },
    });
    const box = {
      async ensureReady() { return { terminalsFolder: terminals }; },
      getAgentWindowIndex() { return 0; },
      async uploadFile() {},
      async downloadFile(_context, _boxId, filePath) { return await readFile(filePath); },
    };
    const dependencies = loaded.module.createHostBrowserDriverDependencies({
      resourceAccessor: accessor,
      box,
      getBoxId: () => "box-1",
      getDefaultViewId: () => "view-1",
      executeShell: shell,
    });
    const stdin = `${Buffer.from(JSON.stringify({
      request: { secret },
      responseKey: "a".repeat(64),
    }), "utf8").toString("base64")}\n`;
    const [context, cancel] = loaded.module.createContext().withCancel();
    setTimeout(() => cancel(new Error("test caller abort")), 500);
    await assert.rejects(
      () => dependencies.executeShellWithInput(context, {
        command: `node ${scriptPath}`,
        name: "node",
        workingDirectory: workspace,
        toolCallId: "browser-stdin-e2e",
      }, stdin),
      /test caller abort|AbortError/,
    );

    const terminalPath = path.join(terminals, "1.txt");
    await assert.rejects(access(terminalPath), { code: "ENOENT" });
    // Cleanup is part of operation settlement, not abandoned detached work.
    // Give any queued daemon append a chance to expose a recreate-after-unlink
    // race before the fixture tears its directory down.
    await delay(100);
    await assert.rejects(access(terminalPath), { code: "ENOENT" });
    await mkdir(path.dirname(screenshotPath), { recursive: true });
    await writeFile(screenshotPath, "temporary-browser-pixels");
    // The originating context is already aborted. Production cleanup must
    // detach from it, remain bounded, and remove the exact private PNG.
    await dependencies.removeFile(context, "box-1", screenshotPath);
    await assert.rejects(access(screenshotPath), { code: "ENOENT" });
    assert.equal(
      audited.some(command => command === `rm -f -- '${screenshotPath}'`),
      true,
    );
    await assert.rejects(
      () => dependencies.removeFile(context, "box-1", "/tmp/not-a-browser-shot.png"),
      /outside the private screenshot area/,
    );
    assert.equal(audited.some((command) => command.includes(secret)), false);
    assert.equal(audited.some((command) => command.includes(Buffer.from(secret).toString("base64"))), false);
    const scriptText = await readFile(scriptPath, "utf8");
    assert.equal(scriptText.includes(secret), false);
    assert.equal(scriptText.includes(stdin.trim()), false);
    // Daemon shutdown owns child termination and the complete terminal write
    // queue. Once it resolves, neither a close footer nor a late stream chunk
    // may recreate the transcript the Browser operation removed.
    await daemon.stop();
    daemon = undefined;
    await delay(100);
    await assert.rejects(access(terminalPath), { code: "ENOENT" });
  } finally {
    await daemon?.stop();
    await rm(screenshotPath, { force: true });
    await rm(root, { recursive: true, force: true });
    await loaded.dispose();
  }
});
