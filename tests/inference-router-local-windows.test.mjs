import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(import.meta.dirname, "..");

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-router-local-win-module-"));
  const output = path.join(temporary, "router-local.mjs");
  await build({ entryPoints: [path.join(repoRoot, "source/shared/node/inference-router-local.ts")], outfile: output, bundle: true, format: "esm", platform: "node", target: "node22" });
  return { module: await import(`${pathToFileURL(output).href}?${Date.now()}`), dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("Windows CLI discovery supports PATHEXT, quoted PATH entries, and APPDATA npm shims", async () => {
  const loaded = await loadModule(), temporary = await mkdtemp(path.join(os.tmpdir(), "grok win cli "));
  try {
    const appData = path.join(temporary, "App Data"), npm = path.join(appData, "npm"), pathBin = path.join(temporary, "Program Files", "bin");
    await mkdir(npm, { recursive: true });
    await mkdir(pathBin, { recursive: true });
    const claude = path.join(npm, "claude.cmd"), codex = path.join(pathBin, "codex.exe");
    await writeFile(claude, "@echo off\r\n");
    await writeFile(codex, "MZ");
    const env = { APPDATA: appData, PATH: `"${pathBin}"`, PATHEXT: ".EXE;.CMD" };
    assert.equal(loaded.module.resolveClaudeCodeCliPath({ platform: "win32", homeDir: temporary, env }), claude);
    assert.equal(loaded.module.resolveCodexCliPath({ platform: "win32", homeDir: temporary, env }), codex);
  } finally { await loaded.dispose(); await rm(temporary, { recursive: true, force: true }); }
});

test("Windows CLI discovery rejects directories, unsupported extensions, and links", async () => {
  const loaded = await loadModule(), temporary = await mkdtemp(path.join(os.tmpdir(), "grok-win-cli-reject-"));
  try {
    const directory = path.join(temporary, "codex.exe"), target = path.join(temporary, "real-claude.cmd"), link = path.join(temporary, "claude.cmd"), text = path.join(temporary, "codex.txt");
    await mkdir(directory);
    await writeFile(target, "@echo off\r\n");
    await writeFile(text, "not executable");
    await symlink(target, link);
    const env = { CODEX_PATH: text, CLAUDE_CODE_PATH: link, PATH: temporary, PATHEXT: ".EXE;.CMD" };
    assert.equal(loaded.module.resolveCodexCliPath({ platform: "win32", homeDir: temporary, env }), null);
    assert.equal(loaded.module.resolveClaudeCodeCliPath({ platform: "win32", homeDir: temporary, env }), null);
  } finally { await loaded.dispose(); await rm(temporary, { recursive: true, force: true }); }
});

test("POSIX CLI discovery still requires execute permission", async () => {
  const loaded = await loadModule(), temporary = await mkdtemp(path.join(os.tmpdir(), "grok-cli-posix-"));
  try {
    const codex = path.join(temporary, "codex");
    await writeFile(codex, "#!/bin/sh\n");
    await chmod(codex, 0o600);
    assert.equal(loaded.module.resolveCodexCliPath({ platform: "linux", homeDir: temporary, env: { PATH: temporary } }), null);
    await chmod(codex, 0o700);
    assert.equal(loaded.module.resolveCodexCliPath({ platform: "linux", homeDir: temporary, env: { PATH: temporary } }), codex);
  } finally { await loaded.dispose(); await rm(temporary, { recursive: true, force: true }); }
});
