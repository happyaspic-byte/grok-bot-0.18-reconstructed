import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";

import {
  assertDistinctWindowsPathComponents,
  assertWindowsPathComponent,
  canonicalizeCycloneDx,
  createReproducibleZip,
  deterministicReleaseManifest,
} from "../scripts/lib/reproducible-release.mjs";
import { findSevenZipExecutable } from "../scripts/lib/windows-runtime.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const commit = "0123456789abcdef0123456789abcdef01234567";
const commitIso = "2026-08-20T14:12:10.000Z";
const epochSeconds = Date.parse(commitIso) / 1_000;
const artifactFile = "Grok-Bot-0.18.0-reconstructed.3-windows-x64-portable-unsigned.zip";
const artifactSha256 = "ab".repeat(32);
const sbomIdentity = Object.freeze({ commit, version: "0.18.0-reconstructed.3", commitIso, artifactFile, artifactSha256 });
const asarFixture = Buffer.alloc(8 * 1024 * 1024);
for (let index = 0; index < asarFixture.length; index += 1) asarFixture[index] = index % 251;

async function fixture(root, timestamp) {
  await mkdir(path.join(root, "empty"), { recursive: true });
  await mkdir(path.join(root, "resources"), { recursive: true });
  await writeFile(path.join(root, "resources", "app.asar"), asarFixture);
  await writeFile(path.join(root, "Grok Bot 0.18 Reconstructed.exe"), "deterministic executable\n", "utf8");
  await writeFile(path.join(root, "한글.txt"), "utf8 name\n", "utf8");
  const value = new Date(timestamp);
  await Promise.all([
    utimes(root, value, value),
    utimes(path.join(root, "empty"), value, value),
    utimes(path.join(root, "resources"), value, value),
    utimes(path.join(root, "resources", "app.asar"), value, value),
    utimes(path.join(root, "Grok Bot 0.18 Reconstructed.exe"), value, value),
    utimes(path.join(root, "한글.txt"), value, value),
  ]);
}

test("canonical ZIP bytes ignore source timestamps and preserve a safe round trip", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-release-repro-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const firstSource = path.join(temporary, "first");
  const secondSource = path.join(temporary, "second");
  await Promise.all([fixture(firstSource, "2020-01-02T03:04:05Z"), fixture(secondSource, "2025-06-07T08:09:10Z")]);
  const firstZip = path.join(temporary, "first.zip");
  const secondZip = path.join(temporary, "second.zip");
  const first = await createReproducibleZip({ sourceDirectory: firstSource, outputFile: firstZip, archiveRootName: "Portable", epochSeconds });
  const second = await createReproducibleZip({ sourceDirectory: secondSource, outputFile: secondZip, archiveRootName: "Portable", epochSeconds });
  assert.equal(first.entries, second.entries);
  assert.deepEqual(await readFile(firstZip), await readFile(secondZip));

  const sevenZip = await findSevenZipExecutable();
  const extracted = path.join(temporary, "extracted");
  await execFileAsync(sevenZip, ["x", firstZip, `-o${extracted}`, "-y", "-bd", "-bb0"]);
  assert.equal(await readFile(path.join(extracted, "Portable", "Grok Bot 0.18 Reconstructed.exe"), "utf8"), "deterministic executable\n");
  assert.deepEqual(await readFile(path.join(extracted, "Portable", "resources", "app.asar")), asarFixture);
  assert.equal(await readFile(path.join(extracted, "Portable", "한글.txt"), "utf8"), "utf8 name\n");
});

test("canonical ZIP settles a source error, removes its partial, and never overwrites", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-release-failure-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, "source");
  await fixture(source, "2024-01-02T03:04:05Z");
  const output = path.join(temporary, "partial.zip");
  let failed = false;
  const createSourceStream = (sourceHandle, entry) => {
    if (failed || !entry.absolute.endsWith("Grok Bot 0.18 Reconstructed.exe")) return sourceHandle.createReadStream({ autoClose: false });
    failed = true;
    let emitted = false;
    return new Readable({
      read() {
        if (emitted) return;
        emitted = true;
        this.push(Buffer.from("partial"));
        queueMicrotask(() => this.destroy(new Error("injected source read failure")));
      },
    });
  };
  await assert.rejects(
    createReproducibleZip({ sourceDirectory: source, outputFile: output, archiveRootName: "Portable", epochSeconds, createSourceStream }),
    /injected source read failure/,
  );
  await assert.rejects(access(output), { code: "ENOENT" });

  await writeFile(output, "keep-existing-bytes", "utf8");
  await assert.rejects(
    createReproducibleZip({ sourceDirectory: source, outputFile: output, archiveRootName: "Portable", epochSeconds }),
    (error) => error?.code === "EEXIST",
  );
  assert.equal(await readFile(output, "utf8"), "keep-existing-bytes");
});

test("canonical ZIP rejects every reviewed Win32-ambiguous component and collision", async (t) => {
  for (const invalid of [
    "C:", "CON", "NUL.txt", "COM1.log", "LPT².bin", "trailing.", "trailing ",
    "has:colon", "has<angle", "has>angle", 'has"quote', "has/slash", "has\\slash",
    "has|pipe", "has?question", "has*star", "control\u001f", "e\u0301",
  ]) {
    assert.throws(() => assertWindowsPathComponent(invalid), /ordinary|NFC|reserved|trailing|device/i, invalid);
  }
  assert.equal(assertWindowsPathComponent("Grok Bot 0.18 Reconstructed-win32-x64"), "Grok Bot 0.18 Reconstructed-win32-x64");
  assert.throws(
    () => assertDistinctWindowsPathComponents(["Readme.txt", "README.TXT"]),
    /Win32-colliding names/,
  );
  assert.throws(
    () => assertDistinctWindowsPathComponents(["Straße.txt", "STRASSE.TXT"]),
    /Win32-colliding names/,
  );

  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-release-win32-name-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, "source");
  await fixture(source, "2024-01-02T03:04:05Z");
  const output = path.join(temporary, "invalid-root.zip");
  await assert.rejects(
    createReproducibleZip({ sourceDirectory: source, outputFile: output, archiveRootName: "C:", epochSeconds }),
    /Win32-reserved character/,
  );
  await assert.rejects(access(output), { code: "ENOENT" });
});

test("canonical ZIP rejects same-size file and parent-directory swaps and removes partials", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-release-swap-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));

  await t.test("file replaced by same-size symlink after collection", async () => {
    const source = path.join(temporary, "file-source");
    await fixture(source, "2024-01-02T03:04:05Z");
    const target = path.join(source, "Grok Bot 0.18 Reconstructed.exe");
    const malicious = path.join(temporary, "same-size-malicious.exe");
    const original = await readFile(target);
    await writeFile(malicious, Buffer.alloc(original.length, 0x58));
    const output = path.join(temporary, "file-swap.zip");
    let swapped = false;
    const openSourceFile = async (candidate, flags) => {
      if (!swapped && candidate === target) {
        swapped = true;
        await rm(candidate);
        await symlink(malicious, candidate, "file");
      }
      return open(candidate, flags);
    };
    await assert.rejects(
      createReproducibleZip({ sourceDirectory: source, outputFile: output, archiveRootName: "Portable", epochSeconds, openSourceFile }),
      /ELOOP|symbolic|source (?:type|identity) changed/i,
    );
    assert.equal(swapped, true);
    await assert.rejects(access(output), { code: "ENOENT" });
  });

  await t.test("parent directory replaced by a same-size tree symlink after collection", async () => {
    const source = path.join(temporary, "directory-source");
    await fixture(source, "2024-01-02T03:04:05Z");
    const resources = path.join(source, "resources");
    const collectedTarget = path.join(resources, "app.asar");
    const savedResources = path.join(source, "resources-collected");
    const maliciousResources = path.join(temporary, "malicious-resources");
    await mkdir(maliciousResources);
    await writeFile(path.join(maliciousResources, "app.asar"), Buffer.alloc(asarFixture.length, 0x59));
    const output = path.join(temporary, "directory-swap.zip");
    let swapped = false;
    const openSourceFile = async (candidate, flags) => {
      if (!swapped && candidate === collectedTarget) {
        swapped = true;
        await rename(resources, savedResources);
        await symlink(maliciousResources, resources, "dir");
      }
      return open(candidate, flags);
    };
    await assert.rejects(
      createReproducibleZip({ sourceDirectory: source, outputFile: output, archiveRootName: "Portable", epochSeconds, openSourceFile }),
      /symbolic|source (?:type|identity) changed/i,
    );
    assert.equal(swapped, true);
    await assert.rejects(access(output), { code: "ENOENT" });
  });
});

test("CycloneDX random serials normalize deterministically while generation timestamps are omitted", () => {
  const base = {
    $schema: "http://cyclonedx.org/schema/bom-1.5.schema.json",
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: { timestamp: "2020-01-01T00:00:00.000Z", component: { name: "grok-bot", description: "stale macOS package description" } },
    components: [{ version: "1.0.0", name: "example", type: "library" }],
  };
  const first = canonicalizeCycloneDx({ ...base, serialNumber: "urn:uuid:11111111-1111-4111-8111-111111111111" }, sbomIdentity);
  const second = canonicalizeCycloneDx({ ...base, metadata: { ...base.metadata, timestamp: "2030-01-01T00:00:00.000Z" }, serialNumber: "urn:uuid:22222222-2222-4222-8222-222222222222" }, sbomIdentity);
  assert.equal(first, second);
  const parsed = JSON.parse(first);
  assert.equal(Object.hasOwn(parsed.metadata, "timestamp"), false);
  assert.equal(Object.hasOwn(parsed, "serialNumber"), false);
  assert.deepEqual(parsed.metadata.component, {
    name: "Grok Bot 0.18 Reconstructed",
    type: "application",
    version: "0.18.0-reconstructed.3",
  });
  assert.deepEqual(parsed.metadata.properties, [
    {
      name: "grok-bot:sbom:scope",
      value: "windows-portable-production-dependencies-and-electron-framework",
    },
    {
      name: "grok-bot:sbom:artifact-coverage",
      value: "not-a-complete-inventory-of-packaged-native-or-recovered-upstream-bytes",
    },
    {
      name: "grok-bot:distribution:identity",
      value: "unsigned-windows-x64-portable",
    },
    {
      name: "grok-bot:distribution:filename",
      value: artifactFile,
    },
    {
      name: "grok-bot:distribution:sha256",
      value: artifactSha256,
    },
  ]);
  assert.deepEqual(parsed.components.find((component) => component.name === "Electron"), {
    "bom-ref": "pkg:npm/electron@42.1.0",
    name: "Electron",
    purl: "pkg:npm/electron@42.1.0",
    type: "framework",
    version: "42.1.0",
  });
  const changedCommit = JSON.parse(canonicalizeCycloneDx(base, {
    ...sbomIdentity,
    commit: "1123456789abcdef0123456789abcdef01234567",
  }));
  const changedVersion = JSON.parse(canonicalizeCycloneDx(base, {
    ...sbomIdentity,
    version: "0.18.0-reconstructed.4",
    artifactFile: "Grok-Bot-0.18.0-reconstructed.4-windows-x64-portable-unsigned.zip",
  }));
  assert.deepEqual(changedCommit, parsed, "source commit identity belongs in the release manifest, not the dependency/build SBOM");
  assert.notDeepEqual(changedVersion, parsed);
});

test("CycloneDX canonicalization rejects malformed producer envelopes and identities", () => {
  const valid = {
    $schema: "http://cyclonedx.org/schema/bom-1.5.schema.json",
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: { timestamp: "2020-01-01T00:00:00.000Z", component: { name: "grok-bot" } },
    components: [],
  };
  const invoke = (raw = valid, options = {}) => canonicalizeCycloneDx(raw, { ...sbomIdentity, ...options });
  for (const metadata of [null, [], new Date("2020-01-01T00:00:00.000Z")]) {
    assert.throws(() => invoke({ ...valid, metadata }), /metadata|envelope/i);
  }
  for (const specVersion of ["1.4", "1.6", "garbage", ""]) {
    assert.throws(() => invoke({ ...valid, specVersion }), /unsupported CycloneDX/i);
  }
  for (const schema of [
    "http://cyclonedx.org/schema/bom-1.4.schema.json",
    "https://cyclonedx.org/schema/bom-1.5.schema.json",
    "https://example.invalid/schema.json",
    15,
    null,
  ]) {
    assert.throws(() => invoke({ ...valid, $schema: schema }), /inconsistent schema/i);
  }
  for (const timestamp of [undefined, 123, "2020-01-01", "2020-01-01T00:00:00Z", "2020-01-01T01:00:00.000+01:00", "2020-13-01T00:00:00.000Z", "2020-01-01T00:00:00.000Zjunk"]) {
    assert.throws(() => invoke({ ...valid, metadata: { ...valid.metadata, timestamp } }), /metadata timestamp/i);
  }
  for (const invalidCommitIso of ["2026-08-20", "2026-08-20T14:12:10Z", "2026-08-20T15:12:10.000+01:00", "2026-13-20T14:12:10.000Z", `${commitIso}junk`]) {
    assert.throws(
      () => invoke(valid, { commitIso: invalidCommitIso }),
      /identity/i,
    );
  }
  for (const version of ["", "   ", " padded "]) {
    assert.throws(() => invoke(valid, { version }), /identity/i);
  }
  assert.throws(() => invoke({ ...valid, version: 0 }), /BOM version/i);
  assert.throws(() => invoke({ ...valid, metadata: { timestamp: valid.metadata.timestamp } }), /root component/i);
  assert.throws(() => invoke(valid, { artifactFile: "nested/release.zip" }), /identity/i);
  assert.throws(() => invoke(valid, { artifactFile: "Grok-Bot-0.18.0-reconstructed.4-windows-x64-portable-unsigned.zip" }), /identity/i);
  assert.throws(() => invoke(valid, { artifactSha256: "not-a-sha256" }), /identity/i);
});

test("release manifest canonicalization is independent of object insertion order", () => {
  const first = deterministicReleaseManifest({ tree: "b", commit, sourceCommitAtUtc: commitIso, artifact: { sha256: "a", bytes: 1 } });
  const second = deterministicReleaseManifest({ artifact: { bytes: 1, sha256: "a" }, sourceCommitAtUtc: commitIso, commit, tree: "b" });
  assert.equal(first, second);
  assert.doesNotMatch(first, /createdAtUtc|ImageVersion|ImageOS/);
});

test("two-attempt comparison is streaming and staging is invocation-owned", async () => {
  const bundleSource = await readFile(path.join(repoRoot, "scripts", "create-windows-release-bundle.mjs"), "utf8");
  const start = bundleSource.indexOf("async function assertAttemptsEqual");
  const end = bundleSource.indexOf("\n}\n\nconst options", start);
  assert.ok(start >= 0 && end > start, "two-attempt comparator is missing");
  const comparator = bundleSource.slice(start, end + 2);
  assert.match(comparator, /sha256File/);
  assert.match(comparator, /stat\(/);
  assert.doesNotMatch(comparator, /readFile\(/);
  assert.match(bundleSource, /mkdtemp\(path\.join\(releaseParent, `\.\$\{releaseBase\}\.reproducible-`\)\)/);
  assert.match(bundleSource, /path\.join\(stagingRoot, "attempt-a"\)/);
  assert.match(bundleSource, /path\.join\(stagingRoot, "attempt-b"\)/);
  assert.match(bundleSource, /if \(await exists\(releaseDirectory\)\)[\s\S]*await rename\(first, releaseDirectory\)/);
  assert.doesNotMatch(bundleSource, /reproducible-attempt-[ab]/);
});

test("concurrent Windows bundle CLIs publish exactly once without crossing staging ownership", { skip: process.platform !== "win32" }, async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-release-cli-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const portable = path.join(temporary, "Grok Bot 0.18 Reconstructed-win32-x64");
  await fixture(portable, "2023-01-02T03:04:05Z");
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  await writeFile(path.join(portable, "RECONSTRUCTED-PORTABLE.json"), `${JSON.stringify({
    schemaVersion: 1,
    reconstructedVersion: packageJson.version,
    trust: { distributionSigned: false, publicReleaseEligible: false },
  })}\n`, "utf8");
  const { stdout: commitOutput } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  const expectedCommit = commitOutput.trim();
  const releaseDirectory = path.join(temporary, "release", "windows-x64");
  const arguments_ = [
    path.join(repoRoot, "scripts", "create-windows-release-bundle.mjs"),
    "--app", portable,
    "--release-dir", releaseDirectory,
    "--expected-commit", expectedCommit,
  ];
  const invocationOptions = { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 };
  const concurrent = await Promise.allSettled([
    execFileAsync(process.execPath, arguments_, invocationOptions),
    execFileAsync(process.execPath, arguments_, invocationOptions),
  ]);
  assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(concurrent.filter((result) => result.status === "rejected").length, 1);
  assert.match(
    String(concurrent.find((result) => result.status === "rejected")?.reason),
    /publication lock|Refusing to overwrite or merge an existing release bundle directory/,
  );

  const assetName = `Grok-Bot-${packageJson.version}-windows-x64-portable-unsigned.zip`;
  assert.deepEqual((await readdir(releaseDirectory)).sort(), ["SHA256SUMS.txt", assetName, "release-manifest.json", "sbom.cdx.json"].sort());
  const originalManifest = await readFile(path.join(releaseDirectory, "release-manifest.json"));
  const originalAssets = new Map(await Promise.all(
    (await readdir(releaseDirectory)).map(async (name) => [name, await readFile(path.join(releaseDirectory, name))]),
  ));
  const manifest = JSON.parse(originalManifest);
  assert.equal(manifest.commit, expectedCommit);
  assert.equal(manifest.validation.reproducibleReleaseBundle, "passed-twice");

  await assert.rejects(
    execFileAsync(process.execPath, arguments_, invocationOptions),
    /Refusing to overwrite or merge an existing release bundle directory/,
  );
  assert.deepEqual(await readFile(path.join(releaseDirectory, "release-manifest.json")), originalManifest);
  for (const [name, bytes] of originalAssets) assert.deepEqual(await readFile(path.join(releaseDirectory, name)), bytes, name);
  assert.deepEqual(
    (await readdir(path.dirname(releaseDirectory))).filter((name) => name.startsWith(".windows-x64.")),
    [],
  );
});
