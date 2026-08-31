import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import yaml from "js-yaml";

const repoRoot = path.resolve(import.meta.dirname, "..");
const workflowPath = path.join(repoRoot, ".github", "workflows", "windows-draft-release.yml");
const workflow = yaml.load(await readFile(workflowPath, "utf8"));
const releaseStep = workflow.jobs["build-and-smoke"].steps.find(
  (step) => step.name === "Create or safely resume the workflow-enforced append-only exact-resume unpublished draft",
);

assert.equal(typeof releaseStep?.run, "string", "push-access-visible draft release Bash step is missing");

const releaseVersion = workflow.env.RELEASE_VERSION;
const releaseTag = `v${releaseVersion}`;
const releaseTitle = releaseStep.env.RELEASE_TITLE;
const githubSha = "0123456789abcdef0123456789abcdef01234567";
const githubRepo = "happyaspic-byte/grok-bot-0.18-reconstructed";
const assetNames = [
  `Grok-Bot-${releaseVersion}-windows-x64-portable-unsigned.zip`,
  "SHA256SUMS.txt",
  "release-manifest.json",
  "sbom.cdx.json",
];

const requiredCommands = ["bash", "jq", "node"];
const missingCommands = requiredCommands.filter(
  (command) => spawnSync(command, ["--version"], { stdio: "ignore" }).status !== 0,
);
const skipReason = process.platform !== "linux"
  ? "requires Linux Bash release-runner semantics"
  : missingCommands.length > 0
    ? `requires executable ${missingCommands.join(", ")}`
    : false;

const fakeGhSource = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const statePath = process.env.FAKE_GH_STATE;
if (!statePath) {
  process.stderr.write("FAKE_GH_STATE is required\n");
  process.exit(97);
}

const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));

function save() {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function digest(bytes) {
  return "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex");
}

function publicRelease(release) {
  if (release == null) return null;
  return {
    id: release.id,
    tag_name: release.tag_name,
    name: release.name,
    draft: release.draft,
    prerelease: release.prerelease,
    target_commitish: release.target_commitish,
    body: release.body,
    assets: release.assets.map((asset) => ({
      id: asset.id,
      name: asset.name,
      state: asset.state,
      size: asset.size,
      digest: asset.digest,
    })),
  };
}

function addAsset(name, file) {
  const bytes = fs.readFileSync(file);
  const asset = {
    id: state.nextAssetId++,
    name,
    state: "uploaded",
    size: bytes.length,
    digest: digest(bytes),
    contentBase64: bytes.toString("base64"),
  };
  state.release.assets.push(asset);
  state.operations.push("asset:upload:" + name);
  return asset;
}

function fail(message, code = 1) {
  process.stderr.write(message + "\n");
  process.exit(code);
}

if (args[0] === "release" && args[1] === "create") {
  const tag = args[2];
  const assets = [];
  let index = 3;
  while (index < args.length && !args[index].startsWith("--")) {
    assets.push(args[index++]);
  }
  const options = new Map();
  while (index < args.length) {
    const option = args[index++];
    if (["--draft", "--prerelease"].includes(option)) {
      options.set(option, true);
    } else if (option.includes("=")) {
      const separator = option.indexOf("=");
      options.set(option.slice(0, separator), option.slice(separator + 1));
    } else {
      options.set(option, args[index++]);
    }
  }
  if (state.release != null) fail("release already exists");
  state.release = {
    id: 42,
    tag_name: tag,
    name: options.get("--title"),
    draft: options.get("--draft") === true,
    prerelease: options.get("--prerelease") === true,
    target_commitish: options.get("--target"),
    body: fs.readFileSync(options.get("--notes-file"), "utf8"),
    assets: [],
  };
  state.ref = { object: { type: "commit", sha: options.get("--target") } };
  state.operations.push("release:create:" + tag);
  for (const asset of assets) addAsset(path.basename(asset), asset);
  save();
  process.stdout.write("created\n");
  process.exit(0);
}

if (args[0] !== "api") fail("unsupported fake gh command: " + args.join(" "), 98);

let method = "GET";
let input = null;
let endpoint = null;
for (let index = 1; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === "--paginate") continue;
  if (argument === "--method") {
    method = args[++index];
    continue;
  }
  if (argument === "--input") {
    input = args[++index];
    continue;
  }
  if (argument === "-H" || argument === "--jq") {
    index += 1;
    continue;
  }
  if (argument.startsWith("-")) fail("unsupported fake gh option: " + argument, 98);
  if (endpoint == null) endpoint = argument;
}

if (endpoint == null) fail("fake gh api endpoint is missing", 98);

if (method === "GET" && /\/releases\?per_page=100$/.test(endpoint)) {
  if (state.release != null) process.stdout.write(JSON.stringify(publicRelease(state.release)) + "\n");
  process.exit(0);
}

if (method === "GET" && endpoint.includes("/git/ref/tags/")) {
  if (state.ref == null) {
    process.stderr.write("HTTP request failed (HTTP 404)\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(state.ref));
  process.exit(0);
}

const assetMatch = endpoint.match(/\/releases\/assets\/(\d+)$/);
if (assetMatch != null) {
  const assetId = Number(assetMatch[1]);
  const assetIndex = state.release?.assets.findIndex((asset) => asset.id === assetId) ?? -1;
  if (assetIndex < 0) fail("release asset not found", 1);
  if (method === "DELETE") {
    const [asset] = state.release.assets.splice(assetIndex, 1);
    state.operations.push("asset:delete:" + asset.name);
    save();
    process.exit(0);
  }
  if (method === "GET") {
    process.stdout.write(Buffer.from(state.release.assets[assetIndex].contentBase64, "base64"));
    process.exit(0);
  }
}

if (method === "POST" && endpoint.startsWith("https://uploads.github.com/")) {
  const upload = new URL(endpoint);
  const releaseIdMatch = upload.pathname.match(/\/releases\/(\d+)\/assets$/);
  if (releaseIdMatch == null || Number(releaseIdMatch[1]) !== state.release?.id) {
    fail("upload release id does not match", 1);
  }
  if (input == null) fail("upload input is missing", 1);
  const name = upload.searchParams.get("name");
  if (name == null) fail("upload asset name is missing", 1);
  addAsset(name, input);
  save();
  process.stdout.write("{}");
  process.exit(0);
}

fail("unsupported fake gh api request: " + method + " " + endpoint, 98);
`;

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function createHarness(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-bot-release-step-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const releaseAssets = path.join(root, ".release", "windows-x64");
  const fakeBin = path.join(root, "bin");
  await Promise.all([mkdir(releaseAssets, { recursive: true }), mkdir(fakeBin)]);

  const assetBytes = new Map([
    [assetNames[0], Buffer.from("portable zip payload\n", "utf8")],
    [assetNames[1], Buffer.from("0123456789abcdef *portable.zip\n", "ascii")],
    [assetNames[2], Buffer.from('{"schemaVersion":1,"visibility":"push-access-visible-draft"}\n', "utf8")],
    [assetNames[3], Buffer.from('{"bomFormat":"CycloneDX","specVersion":"1.6"}\n', "utf8")],
  ]);
  for (const [name, bytes] of assetBytes) {
    await writeFile(path.join(releaseAssets, name), bytes);
  }
  const notes = "Reviewed push-access-visible draft notes.\nSecond line.\n";
  await writeFile(path.join(releaseAssets, "RELEASE_NOTES.md"), notes, "utf8");

  const fakeGh = path.join(fakeBin, "gh");
  await writeFile(fakeGh, fakeGhSource, "utf8");
  await chmod(fakeGh, 0o755);

  const statePath = path.join(root, "gh-state.json");
  const state = {
    release: null,
    ref: null,
    nextAssetId: 100,
    operations: [],
  };
  await writeFile(statePath, JSON.stringify(state, null, 2));

  return { root, fakeBin, releaseAssets, statePath, assetBytes, notes };
}

function makeAsset(harness, name, options = {}) {
  const bytes = options.bytes ?? harness.assetBytes.get(name);
  const state = options.state ?? "uploaded";
  const size = options.size ?? bytes.length;
  return {
    id: options.id,
    name,
    state,
    size,
    digest: options.digest === false ? null : sha256(bytes),
    contentBase64: bytes.toString("base64"),
  };
}

async function seedRelease(harness, options = {}) {
  const assets = (options.assets ?? []).map((asset, index) => ({
    ...asset,
    id: asset.id ?? 100 + index,
  }));
  const state = {
    release: {
      id: 42,
      tag_name: options.tag ?? releaseTag,
      name: options.title ?? releaseTitle,
      draft: options.draft ?? true,
      prerelease: options.prerelease ?? true,
      target_commitish: options.commit ?? githubSha,
      body: options.body ?? harness.notes,
      assets,
    },
    ref: options.ref === undefined
      ? { object: { type: "commit", sha: githubSha } }
      : options.ref,
    nextAssetId: Math.max(100, ...assets.map((asset) => asset.id + 1)),
    operations: [],
  };
  await writeFile(harness.statePath, JSON.stringify(state, null, 2));
}

async function readState(harness) {
  return JSON.parse(await readFile(harness.statePath, "utf8"));
}

async function runReleaseStep(harness) {
  const child = spawn("bash", ["-c", releaseStep.run], {
    cwd: harness.root,
    env: {
      ...process.env,
      PATH: `${harness.fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
      FAKE_GH_STATE: harness.statePath,
      GH_TOKEN: "test-token",
      GH_REPO: githubRepo,
      RELEASE_VERSION: releaseVersion,
      RELEASE_TAG: releaseTag,
      RELEASE_TITLE: releaseTitle,
      GITHUB_SHA: githubSha,
      LC_ALL: "C",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  // The complete suite runs several build- and archive-heavy tests in
  // parallel. Keep a real deadlock guard without making ordinary CI load look
  // like a release-script failure.
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  return {
    ...result,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

async function assertCompleteExactRelease(harness) {
  const state = await readState(harness);
  assert.equal(state.release.tag_name, releaseTag);
  assert.equal(state.release.name, releaseTitle);
  assert.equal(state.release.target_commitish, githubSha);
  assert.equal(state.release.draft, true);
  assert.equal(state.release.prerelease, true);
  assert.equal(state.release.body, harness.notes);
  assert.deepEqual(
    state.release.assets.map((asset) => asset.name).sort(),
    [...assetNames].sort(),
  );
  for (const asset of state.release.assets) {
    const expected = harness.assetBytes.get(asset.name);
    assert.deepEqual(Buffer.from(asset.contentBase64, "base64"), expected, asset.name);
    assert.equal(asset.state, "uploaded", asset.name);
    assert.equal(asset.size, expected.length, asset.name);
    assert.equal(asset.digest, sha256(expected), asset.name);
  }
  return state;
}

test("push-access-visible draft Bash step creates a new workflow-enforced exact draft", { skip: skipReason }, async (t) => {
  const harness = await createHarness(t);
  const result = await runReleaseStep(harness);
  assert.equal(result.code, 0, result.stderr);
  const state = await assertCompleteExactRelease(harness);
  assert.deepEqual(state.operations, [
    `release:create:${releaseTag}`,
    ...assetNames.map((name) => `asset:upload:${name}`),
  ]);
  assert.deepEqual(state.ref, { object: { type: "commit", sha: githubSha } });
});

test("push-access-visible draft Bash step resumes a matching partial draft without replacing bytes", { skip: skipReason }, async (t) => {
  const harness = await createHarness(t);
  await seedRelease(harness, {
    assets: assetNames.slice(0, 2).map((name) => makeAsset(harness, name)),
  });

  const result = await runReleaseStep(harness);
  assert.equal(result.code, 0, result.stderr);
  const state = await assertCompleteExactRelease(harness);
  assert.deepEqual(
    state.operations,
    assetNames.slice(2).map((name) => `asset:upload:${name}`),
  );
});

test("push-access-visible draft Bash step replaces a zero-byte starter only after full preflight", { skip: skipReason }, async (t) => {
  const harness = await createHarness(t);
  const starterName = assetNames[0];
  await seedRelease(harness, {
    assets: assetNames.map((name) => name === starterName
      ? makeAsset(harness, name, { bytes: Buffer.alloc(0), state: "starter", size: 0, digest: false })
      : makeAsset(harness, name)),
  });

  const result = await runReleaseStep(harness);
  assert.equal(result.code, 0, result.stderr);
  const state = await assertCompleteExactRelease(harness);
  assert.deepEqual(state.operations, [
    `asset:delete:${starterName}`,
    `asset:upload:${starterName}`,
  ]);
});

test("push-access-visible draft Bash step refuses mismatched existing asset bytes", { skip: skipReason }, async (t) => {
  const harness = await createHarness(t);
  const mismatchedName = assetNames[0];
  await seedRelease(harness, {
    assets: assetNames.map((name) => name === mismatchedName
      ? makeAsset(harness, name, { bytes: Buffer.from("different reviewed bytes\n", "utf8") })
      : makeAsset(harness, name)),
  });

  const result = await runReleaseStep(harness);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Refusing to overwrite a different existing release asset/);
  const state = await readState(harness);
  assert.deepEqual(state.operations, []);
  assert.notDeepEqual(
    Buffer.from(state.release.assets[0].contentBase64, "base64"),
    harness.assetBytes.get(mismatchedName),
  );
});

test("push-access-visible draft Bash step preflights every existing byte before uploading an earlier missing asset", { skip: skipReason }, async (t) => {
  const harness = await createHarness(t);
  const missingName = assetNames[0];
  const laterMismatch = assetNames[2];
  await seedRelease(harness, {
    assets: assetNames.slice(1).map((name) => name === laterMismatch
      ? makeAsset(harness, name, { bytes: Buffer.from("different later bytes\n", "utf8") })
      : makeAsset(harness, name)),
  });

  const result = await runReleaseStep(harness);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Refusing to overwrite a different existing release asset/);
  const state = await readState(harness);
  assert.deepEqual(state.operations, []);
  assert.equal(state.release.assets.some((asset) => asset.name === missingName), false);
});

test("push-access-visible draft Bash step does not retire a zero-byte starter before a later byte mismatch", { skip: skipReason }, async (t) => {
  const harness = await createHarness(t);
  const starterName = assetNames[0];
  const laterMismatch = assetNames[2];
  await seedRelease(harness, {
    assets: assetNames.map((name) => name === starterName
      ? makeAsset(harness, name, { bytes: Buffer.alloc(0), state: "starter", size: 0, digest: false })
      : name === laterMismatch
        ? makeAsset(harness, name, { bytes: Buffer.from("different later bytes\n", "utf8") })
        : makeAsset(harness, name)),
  });

  const result = await runReleaseStep(harness);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Refusing to overwrite a different existing release asset/);
  const state = await readState(harness);
  assert.deepEqual(state.operations, []);
  assert.equal(state.release.assets.find((asset) => asset.name === starterName)?.state, "starter");
});

test("push-access-visible draft Bash step refuses an unexpected fifth asset before mutation", { skip: skipReason }, async (t) => {
  const harness = await createHarness(t);
  const unexpectedName = "stale-unreviewed-build.zip";
  const unexpectedBytes = Buffer.from("stale bytes\n", "utf8");
  await seedRelease(harness, {
    assets: [
      ...assetNames.map((name) => makeAsset(harness, name)),
      makeAsset(harness, unexpectedName, { bytes: unexpectedBytes }),
    ],
  });

  const result = await runReleaseStep(harness);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /draft contains unexpected assets/);
  const state = await readState(harness);
  assert.deepEqual(state.operations, []);
  assert.ok(state.release.assets.some((asset) => asset.name === unexpectedName));
});

test("push-access-visible draft Bash step refuses wrong release identity, tag ref, and notes", { skip: skipReason }, async (t) => {
  const cases = [
    {
      name: "identity",
      seed: { title: `${releaseTitle} tampered` },
      error: /tag, title, state, or target commit differs/,
    },
    {
      name: "tag ref",
      seed: { ref: { object: { type: "commit", sha: "ffffffffffffffffffffffffffffffffffffffff" } } },
      error: /tag that does not point directly at the exact workflow commit/,
    },
    {
      name: "notes",
      seed: { body: "unreviewed replacement notes\n" },
      error: /notes differ from the reviewed bundle/,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async (subtest) => {
      const harness = await createHarness(subtest);
      await seedRelease(harness, scenario.seed);
      const result = await runReleaseStep(harness);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, scenario.error);
      assert.deepEqual((await readState(harness)).operations, []);
    });
  }
});
