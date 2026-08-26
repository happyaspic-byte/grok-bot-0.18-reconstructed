import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPackageWithOptions } from "@electron/asar";

import { canonicalAsarPath, extractAsarFile, nativeAsarPath } from "../scripts/lib/asar-paths.mjs";
import { withWindowsMsvcNodeGypSettings } from "../scripts/lib/node-gyp-environment.mjs";
import { getRuntimePlatformSpec, resolveRuntimeLayout } from "../scripts/lib/platform-runtime.mjs";
import { assertPeX64, sha256File, validateWindowsRuntime, windowsInstalledRuntimeCandidates } from "../scripts/lib/windows-runtime.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

function fakePeX64(machine = 0x8664) {
  const bytes = Buffer.alloc(128);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(64, 0x3c);
  bytes.write("PE\0\0", 64, "ascii");
  bytes.writeUInt16LE(machine, 68);
  return bytes;
}

async function writeFixtureFile(root, relative, value) {
  const target = path.join(root, ...relative.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, value);
  return target;
}

test("Windows x64 runtime manifest pins the NSIS carrier, ASAR, and extractor", async () => {
  const spec = await getRuntimePlatformSpec("win32", "x64");
  assert.equal(spec.carrier, "nsis");
  assert.equal(spec.archiveBytes, 125825552);
  assert.equal(spec.archiveSha256, "464079a15ef5fa8b61ccea8fffcc78f63cfcf6df65fb0ad5e725d8b95f7e437e");
  assert.equal(spec.appAsarSha256, "38e85c0e5042c0257db7925e1e55709d6d155d90d92fe26ad654127d509766e0");
  assert.deepEqual(spec.extractor, {
    package: "7zip-bin",
    version: "5.2.0",
    win32X64ExecutableSha256: "b0cfdeaf429f5cc53f85123dd8f5a5feb92c19d31aa34df257edf9a26be05f95",
  });
  const layout = resolveRuntimeLayout("C:\\Pinned Runtime", spec);
  assert.equal(path.basename(layout.executablePath), "Grok Bot.exe");
  assert.equal(path.basename(layout.appAsarPath), "app.asar");

  const [bootstrap, packaging, extractor, verifier, nodeNativeBuild, electronNativeBuild] = await Promise.all([
    readFile(path.join(repoRoot, "scripts/bootstrap-windows-runtime.mjs"), "utf8"),
    readFile(path.join(repoRoot, "scripts/package-windows.mjs"), "utf8"),
    readFile(path.join(repoRoot, "scripts/lib/windows-runtime.mjs"), "utf8"),
    readFile(path.join(repoRoot, "scripts/lib/windows-package.mjs"), "utf8"),
    readFile(path.join(repoRoot, "scripts/build-tree-sitter-node.mjs"), "utf8"),
    readFile(path.join(repoRoot, "scripts/build-tree-sitter-electron.mjs"), "utf8"),
  ]);
  assert.match(bootstrap, /extractPinnedWindowsInstaller/);
  assert.match(bootstrap, /never executed/);
  assert.match(packaging, /buildReconstructedAsar/);
  assert.doesNotMatch(packaging, /Fidelity/);
  assert.match(extractor, /sevenZipBinarySha256/);
  assert.match(extractor, /actualSha256 !== expectedSha256[\s\S]*chmod\(executable, 0o500\)/);
  assert.doesNotMatch(extractor, /path\.join\(root, "7-Zip"|return "7z\.exe"/);
  assert.match(verifier, /Electron main does not activate the 9Router security boundary/);
  assert.match(verifier, /SAND_9ROUTER_ENABLE_UNREVIEWED_MCP_TOOLS/);
  assert.match(verifier, /Primary preload does not expose the bounded 9Router settings bridge/);
  for (const nativeBuild of [nodeNativeBuild, electronNativeBuild]) {
    assert.match(nativeBuild, /spawn\(process\.execPath|run\(process\.execPath/);
    assert.match(nativeBuild, /node-gyp", "bin", "node-gyp\.js"/);
    assert.match(nativeBuild, /withWindowsMsvcNodeGypSettings\(/);
    assert.doesNotMatch(nativeBuild, /node-gyp\.cmd/);
  }
});

test("ASAR lookups canonicalize both Windows and POSIX archive separators", async () => {
  assert.equal(canonicalAsarPath("\\dist\\deps\\runtime-deps-manifest.json"), "dist/deps/runtime-deps-manifest.json");
  assert.equal(canonicalAsarPath("/dist/deps/runtime-deps-manifest.json"), "dist/deps/runtime-deps-manifest.json");
  assert.equal(nativeAsarPath("dist/deps/runtime-deps-manifest.json"), path.join("dist", "deps", "runtime-deps-manifest.json"));

  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-asar-path-fixture-"));
  const source = path.join(temporary, "source");
  const asar = path.join(temporary, "app.asar");
  try {
    await writeFixtureFile(source, "dist/deps/runtime-deps-manifest.json", "fixture\n");
    await createPackageWithOptions(source, asar, {});
    assert.equal(Buffer.from(extractAsarFile(asar, "dist/deps/runtime-deps-manifest.json")).toString("utf8"), "fixture\n");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("Windows node-gyp builds disable inherited Clang LTO settings under MSVC", () => {
  const inherited = {
    npm_config_enable_lto: "true",
    npm_config_enable_thin_lto: "true",
    npm_package_config_node_gyp_enable_lto: "true",
    npm_package_config_node_gyp_enable_thin_lto: "true",
    NPM_CONFIG_ENABLE_THIN_LTO: "true",
    Npm_Package_Config_Node_Gyp_Enable_Lto: "true",
    UNRELATED: "preserved",
  };
  const windows = withWindowsMsvcNodeGypSettings(inherited, "win32");
  assert.deepEqual(windows, {
    npm_config_enable_lto: "false",
    npm_config_enable_thin_lto: "false",
    npm_package_config_node_gyp_enable_lto: "false",
    npm_package_config_node_gyp_enable_thin_lto: "false",
    UNRELATED: "preserved",
  });
  assert.equal(windows.NPM_CONFIG_ENABLE_THIN_LTO, undefined);
  assert.equal(windows.Npm_Package_Config_Node_Gyp_Enable_Lto, undefined);
  assert.equal(inherited.npm_config_enable_thin_lto, "true");
  assert.deepEqual(withWindowsMsvcNodeGypSettings(inherited, "linux"), inherited);
});

test("Windows runtime validation proves PE x64 and unpacked native provenance", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-win-runtime-fixture-"));
  const source = path.join(temporary, "source");
  const runtime = path.join(temporary, "Grok Bot");
  const resources = path.join(runtime, "resources");
  const asar = path.join(resources, "app.asar");
  try {
    await writeFixtureFile(source, "package.json", `${JSON.stringify({ name: "grok-bot", productName: "Grok Bot", version: "0.18.0", main: "dist/electron-main/main.cjs" })}\n`);
    await writeFixtureFile(source, "dist/electron-main/main.cjs", "module.exports = {};\n");
    await writeFixtureFile(source, "dist/host/host-main.cjs", "module.exports = {};\n");
    await writeFixtureFile(source, "dist/renderer/index.html", "<main>fixture</main>\n");
    await writeFixtureFile(source, "dist/deps/runtime-deps-manifest.json", `${JSON.stringify({ platform: "win32", arch: "x64", nodeFiles: ["native.node"] })}\n`);
    await writeFixtureFile(source, "dist/deps/native.node", fakePeX64());
    await writeFixtureFile(source, "dist/native/sand-webauthn-signer.exe", fakePeX64());
    await mkdir(resources, { recursive: true });
    await writeFile(path.join(runtime, "Grok Bot.exe"), fakePeX64());
    await createPackageWithOptions(source, asar, { unpackDir: "dist/{deps,native}" });
    const expectedAsarSha256 = await sha256File(asar);
    const validated = await validateWindowsRuntime(runtime, { origin: "unit-fixture", expectedAsarSha256 });
    assert.equal(validated.platform, "win32");
    assert.equal(validated.arch, "x64");
    assert.deepEqual(validated.nativeRuntime.nodeFiles, ["native.node"]);
    await assertPeX64(path.join(runtime, "Grok Bot.exe"));
    await writeFile(path.join(asar + ".unpacked", "dist", "deps", "native.node"), fakePeX64(0x14c));
    await assert.rejects(() => validateWindowsRuntime(runtime, { expectedAsarSha256 }), /not PE32\+ x86-64/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("installed Windows candidates preserve spaces and resolve explicit roots", () => {
  const candidates = windowsInstalledRuntimeCandidates({
    LOCALAPPDATA: "C:\\Users\\Example User\\AppData\\Local",
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
  });
  assert.equal(candidates.length, 4);
  assert.ok(candidates.every(candidate => path.isAbsolute(candidate)));
  assert.ok(candidates.some(candidate => candidate.includes("Example User")));
});
