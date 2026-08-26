import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveRuntimeAssetSource, validateBootstrapEvidence } from "../scripts/renderer-production-build.mjs";

const sha256 = value => createHash("sha256").update(value).digest("hex");

async function writeFixture(root, relative, value) {
  const target = path.join(root, ...relative.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, value);
}

function fixtureCatalog(artifact, bytes, html) {
  const anchors = {
    mount: "mount-anchor",
    desktop: "desktop-anchor",
    coordinator: "coordinator-anchor",
    provider: "provider-anchor",
  };
  return {
    schemaVersion: 1,
    artifact: "src/app/dist/renderer/assets/macos.js",
    artifactVariants: [
      { platform: "darwin-arm64", path: "src/app/dist/renderer/assets/macos.js", sha256: "0".repeat(64), htmlBytes: 0, htmlSha256: "0".repeat(64) },
      { platform: "win32-x64", path: artifact, sha256: sha256(bytes), htmlBytes: Buffer.byteLength(html), htmlSha256: sha256(html) },
    ],
    mount: { anchors: [{ needle: anchors.mount, byteOffset: bytes.indexOf(anchors.mount) }] },
    runtimeAcquisition: {
      desktop: { needle: anchors.desktop, byteOffset: bytes.indexOf(anchors.desktop) },
      coordinatorPort: { needle: anchors.coordinator, byteOffset: bytes.indexOf(anchors.coordinator) },
    },
    providerOrder: [{ anchor: anchors.provider, byteOffset: bytes.indexOf(anchors.provider) }],
  };
}

test("renderer bootstrap selects the one present checksum-pinned platform artifact", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-renderer-bootstrap-"));
  const artifact = "src/app/dist/renderer/assets/windows.js";
  const bytes = Buffer.from("mount-anchor|desktop-anchor|coordinator-anchor|provider-anchor");
  const html = '<script crossorigin src="./assets/windows.js" type="module"></script>';
  try {
    await writeFixture(root, "frontend/manifests/renderer-bootstrap.json", `${JSON.stringify(fixtureCatalog(artifact, bytes, html))}\n`);
    await writeFixture(root, artifact, bytes);
    await writeFixture(root, "src/app/dist/renderer/index.html", html);
    const result = await validateBootstrapEvidence({ root });
    assert.deepEqual(result.validatedArtifact, {
      platform: "win32-x64",
      path: artifact,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
      indexHtml: {
        path: "src/app/dist/renderer/index.html",
        bytes: Buffer.byteLength(html),
        sha256: sha256(html),
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("renderer bootstrap rejects drift and ambiguous platform artifacts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-renderer-bootstrap-"));
  const artifact = "src/app/dist/renderer/assets/windows.js";
  const bytes = Buffer.from("mount-anchor|desktop-anchor|coordinator-anchor|provider-anchor");
  const html = '<script type="module" src="./assets/windows.js"></script>';
  try {
    const catalog = fixtureCatalog(artifact, bytes, html);
    await writeFixture(root, "frontend/manifests/renderer-bootstrap.json", `${JSON.stringify(catalog)}\n`);
    await writeFixture(root, artifact, Buffer.from("tampered"));
    await writeFixture(root, "src/app/dist/renderer/index.html", html);
    await assert.rejects(() => validateBootstrapEvidence({ root }), /artifact hash drifted/);

    await writeFixture(root, artifact, bytes);
    await writeFixture(root, "src/app/dist/renderer/index.html", `${html}<!-- drift -->`);
    await assert.rejects(() => validateBootstrapEvidence({ root }), /HTML hash drifted/);
    await writeFixture(root, "src/app/dist/renderer/index.html", html);

    const macBytes = Buffer.from("mac");
    catalog.artifactVariants[0].sha256 = sha256(macBytes);
    await writeFixture(root, "frontend/manifests/renderer-bootstrap.json", `${JSON.stringify(catalog)}\n`);
    await writeFixture(root, catalog.artifactVariants[0].path, macBytes);
    await assert.rejects(() => validateBootstrapEvidence({ root }), /exactly one checksum-pinned.*found 2/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("renderer bootstrap rejects a checksum-pinned artifact that is not the HTML entry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-renderer-bootstrap-"));
  const artifact = "src/app/dist/renderer/assets/windows.js";
  const bytes = Buffer.from("mount-anchor|desktop-anchor|coordinator-anchor|provider-anchor");
  const html = '<script type="module" src="./assets/different.js"></script>';
  try {
    await writeFixture(root, "frontend/manifests/renderer-bootstrap.json", `${JSON.stringify(fixtureCatalog(artifact, bytes, html))}\n`);
    await writeFixture(root, artifact, bytes);
    await writeFixture(root, "src/app/dist/renderer/index.html", html);
    await assert.rejects(() => validateBootstrapEvidence({ root }), /not the HTML module entry/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("renderer bootstrap ignores data attributes when binding the HTML entry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-renderer-bootstrap-"));
  const artifact = "src/app/dist/renderer/assets/windows.js";
  const bytes = Buffer.from("mount-anchor|desktop-anchor|coordinator-anchor|provider-anchor");
  const html = '<script data-type="module" src="./assets/windows.js"></script><script type="module" data-src="./assets/windows.js" src="./assets/evil.js"></script>';
  try {
    await writeFixture(root, "frontend/manifests/renderer-bootstrap.json", `${JSON.stringify(fixtureCatalog(artifact, bytes, html))}\n`);
    await writeFixture(root, artifact, bytes);
    await writeFixture(
      root,
      "src/app/dist/renderer/index.html",
      html,
    );
    await assert.rejects(() => validateBootstrapEvidence({ root }), /not the HTML module entry/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("renderer bootstrap ignores custom tags and attribute contents that resemble an entry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-renderer-bootstrap-"));
  const artifact = "src/app/dist/renderer/assets/windows.js";
  const bytes = Buffer.from("mount-anchor|desktop-anchor|coordinator-anchor|provider-anchor");
  const html = '<script-x type="module" src="./assets/windows.js"></script-x><script type="module" data-note=" src=\'./assets/windows.js\'"></script>';
  try {
    await writeFixture(root, "frontend/manifests/renderer-bootstrap.json", `${JSON.stringify(fixtureCatalog(artifact, bytes, html))}\n`);
    await writeFixture(root, artifact, bytes);
    await writeFixture(
      root,
      "src/app/dist/renderer/index.html",
      html,
    );
    await assert.rejects(() => validateBootstrapEvidence({ root }), /module entry script/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function runtimeAssetFixture() {
  const canonical = Buffer.from("<svg>\n  <path />\n</svg>\n");
  const windows = Buffer.from("<svg>\r\n  <path />\r\n</svg>\r\n");
  return {
    canonical,
    windows,
    asset: {
      file: "logo-canonical.svg",
      bytes: canonical.byteLength,
      sha256: sha256(canonical),
      sources: [{
        platform: "win32-x64",
        file: "logo-windows.svg",
        bytes: windows.byteLength,
        sha256: sha256(windows),
        transform: "crlf-to-lf",
      }],
    },
  };
}

test("renderer runtime assets select and normalize a pinned Windows source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-renderer-assets-"));
  const { asset, canonical, windows } = runtimeAssetFixture();
  try {
    await writeFixture(root, "evidence/assets/logo-windows.svg", windows);
    const result = await resolveRuntimeAssetSource(asset, { root, artifactRoot: "evidence/assets" });
    assert.deepEqual(result.bytes, canonical);
    assert.deepEqual(result.record.source, {
      platform: "win32-x64",
      file: "logo-windows.svg",
      bytes: windows.byteLength,
      sha256: sha256(windows),
      transform: "crlf-to-lf",
    });
    assert.equal(result.record.file, asset.file);
    assert.equal(result.record.sha256, asset.sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("renderer runtime assets reject source drift, ambiguity, and duplicate declarations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-renderer-assets-"));
  const { asset, canonical, windows } = runtimeAssetFixture();
  try {
    await writeFixture(root, "evidence/assets/logo-windows.svg", Buffer.from("tampered"));
    await assert.rejects(
      () => resolveRuntimeAssetSource(asset, { root, artifactRoot: "evidence/assets" }),
      /asset hash drifted/,
    );

    await writeFixture(root, "evidence/assets/logo-windows.svg", windows);
    await writeFixture(root, "evidence/assets/logo-canonical.svg", canonical);
    await assert.rejects(
      () => resolveRuntimeAssetSource(asset, { root, artifactRoot: "evidence/assets" }),
      /exactly one checksum-pinned source.*found 2/,
    );

    const duplicate = { ...asset, sources: [...asset.sources, { ...asset.sources[0] }] };
    await assert.rejects(
      () => resolveRuntimeAssetSource(duplicate, { root, artifactRoot: "evidence/assets" }),
      /duplicate source/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
