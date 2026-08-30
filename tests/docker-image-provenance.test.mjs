import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  EXPECTED_BLOB_REDIRECT_HOST,
  EXPECTED_ENTRYPOINT,
  EXPECTED_REPOSITORY,
  parsePinnedImageReference,
  readPinnedImageReference,
  verifyPinnedLocalDockerImage,
} from "../scripts/verify-local-docker-image.mjs";

const MANIFEST_MEDIA_TYPE = "application/vnd.docker.distribution.manifest.v2+json";
const CONFIG_MEDIA_TYPE = "application/vnd.docker.container.image.v1+json";
const TOKEN = "mock-ecr-token-that-must-never-be-reported";
const repoRoot = path.resolve(import.meta.dirname, "..");

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function fixture({ osName = "linux", architecture = "amd64", entrypoint = EXPECTED_ENTRYPOINT } = {}) {
  const configBytes = Buffer.from(JSON.stringify({
    architecture,
    os: osName,
    created: "2026-08-30T06:37:30Z",
    config: { Entrypoint: entrypoint },
  }));
  const configDigest = digest(configBytes);
  const manifestBytes = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    mediaType: MANIFEST_MEDIA_TYPE,
    config: { mediaType: CONFIG_MEDIA_TYPE, size: configBytes.length, digest: configDigest },
    layers: [],
  }));
  const manifestDigest = digest(manifestBytes);
  const image = `public.ecr.aws/${EXPECTED_REPOSITORY}@${manifestDigest}`;
  return { configBytes, configDigest, manifestBytes, manifestDigest, image };
}

async function withSource(image, run) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-ecr-provenance-"));
  const sourcePath = path.join(temporary, "local-docker-host-connector.ts");
  await writeFile(sourcePath, `export const LOCAL_DOCKER_BOX_IMAGE = ${JSON.stringify(image)};\n`, "utf8");
  try {
    return await run(sourcePath);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function ecrFetch(current, requests, overrides = {}) {
  return async (url, init) => {
    requests.push({ url: String(url), init });
    if (requests.length === 1) {
      return new Response(JSON.stringify({ token: TOKEN }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (requests.length === 2) {
      assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
      if (overrides.manifestError) throw new Error(`unsafe client error: ${init.headers.Authorization}`);
      const bytes = overrides.manifestBytes ?? current.manifestBytes;
      return new Response(bytes, {
        status: 200,
        headers: {
          "content-type": MANIFEST_MEDIA_TYPE,
          "docker-content-digest": current.manifestDigest,
        },
      });
    }
    if (requests.length === 3) {
      assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
      if (overrides.configRedirect) {
        return new Response(null, {
          status: 302,
          headers: { location: overrides.configRedirect },
        });
      }
    } else {
      assert.equal(requests.length, 4);
      assert.equal(init.headers.Authorization, undefined);
      assert.equal(init.credentials, "omit");
      if (overrides.redirectError) throw new Error(`unsafe redirect error: ${url} ${TOKEN}`);
      if (overrides.redirectNever) return new Promise(() => {});
    }
    const bytes = overrides.configBytes ?? current.configBytes;
    return new Response(bytes, {
      status: 200,
      headers: {
        "content-type": CONFIG_MEDIA_TYPE,
        "docker-content-digest": current.configDigest,
      },
    });
  };
}

test("pinned public ECR image verifies exact nested paths, bytes, platform, and entrypoint", async () => {
  const current = fixture();
  await withSource(current.image, async (sourcePath) => {
    const requests = [];
    const result = await verifyPinnedLocalDockerImage({
      sourcePath,
      fetchImpl: ecrFetch(current, requests),
      timeoutMs: 500,
    });

    assert.deepEqual(result, {
      image: current.image,
      manifestDigest: current.manifestDigest,
      configDigest: current.configDigest,
      platform: "linux/amd64",
      entrypoint: ["/usr/local/bin/start-sand-box"],
      created: "2026-08-30T06:37:30Z",
    });
    assert.equal(Object.values(result).join(" ").includes(TOKEN), false);
    assert.equal(requests[0].url, "https://public.ecr.aws/token/?service=public.ecr.aws&scope=aws");
    assert.equal(requests[0].init.headers.Authorization, undefined);
    assert.equal(
      requests[1].url,
      `https://public.ecr.aws/v2/k0i0n2g5/cursorenvironments/universal/manifests/${current.manifestDigest}`,
    );
    assert.equal(
      requests[2].url,
      `https://public.ecr.aws/v2/k0i0n2g5/cursorenvironments/universal/blobs/${current.configDigest}`,
    );
    for (const request of requests.slice(0, 2)) {
      assert.equal(request.init.cache, "no-store");
      assert.equal(request.init.redirect, "error");
      assert.ok(request.init.signal instanceof AbortSignal);
    }
    assert.equal(requests[2].init.cache, "no-store");
    assert.equal(requests[2].init.redirect, "manual");
    assert.ok(requests[2].init.signal instanceof AbortSignal);
  });
});

test("Public ECR config redirect is fetched only from the approved CloudFront host without credentials", async () => {
  const current = fixture();
  const redirect = `https://${EXPECTED_BLOB_REDIRECT_HOST}/opaque/config?Expires=123&Signature=redirect-secret`;
  await withSource(current.image, async (sourcePath) => {
    const requests = [];
    const result = await verifyPinnedLocalDockerImage({
      sourcePath,
      fetchImpl: ecrFetch(current, requests, { configRedirect: redirect }),
      timeoutMs: 500,
    });
    assert.equal(result.configDigest, current.configDigest);
    assert.equal(requests.length, 4);
    assert.equal(requests[3].url, redirect);
    assert.equal(requests[2].init.redirect, "manual");
    assert.deepEqual(requests[3].init.headers, { Accept: "application/octet-stream" });
    assert.equal(JSON.stringify(requests[3].init.headers).includes(TOKEN), false);
    assert.equal(requests[3].init.redirect, "error");
    assert.ok(requests[3].init.signal instanceof AbortSignal);
  });
});

test("config redirects outside the exact credential-free HTTPS CloudFront origin fail closed", async (t) => {
  const current = fixture();
  for (const [name, redirect] of [
    ["non-HTTPS", `http://${EXPECTED_BLOB_REDIRECT_HOST}/config`],
    ["different host", "https://example.invalid/config"],
    ["lookalike host", `https://${EXPECTED_BLOB_REDIRECT_HOST}.example.invalid/config`],
    ["embedded credentials", `https://user:password@${EXPECTED_BLOB_REDIRECT_HOST}/config`],
    ["explicit port", `https://${EXPECTED_BLOB_REDIRECT_HOST}:444/config`],
    ["explicit default port", `https://${EXPECTED_BLOB_REDIRECT_HOST}:443/config`],
    ["fragment", `https://${EXPECTED_BLOB_REDIRECT_HOST}/config#ignored`],
    ["relative URL", "/config"],
  ]) {
    await t.test(name, async () => {
      await withSource(current.image, async (sourcePath) => {
        const requests = [];
        await assert.rejects(
          verifyPinnedLocalDockerImage({
            sourcePath,
            fetchImpl: ecrFetch(current, requests, { configRedirect: redirect }),
            timeoutMs: 500,
          }),
          /config redirect is (?:outside|not an absolute)/,
        );
        assert.equal(requests.length, 3, "an unapproved redirect must never be requested");
      });
    });
  }
});

test("CloudFront redirect failures are bounded and sanitized", async (t) => {
  const current = fixture();
  const redirect = `https://${EXPECTED_BLOB_REDIRECT_HOST}/opaque/config?Signature=redirect-secret`;

  await t.test("client errors do not disclose bearer or signed redirect values", async () => {
    await withSource(current.image, async (sourcePath) => {
      await assert.rejects(
        verifyPinnedLocalDockerImage({
          sourcePath,
          fetchImpl: ecrFetch(current, [], { configRedirect: redirect, redirectError: true }),
          timeoutMs: 500,
        }),
        error => {
          assert.match(error.message, /failed before provenance could be verified/);
          assert.equal(error.stack.includes(TOKEN), false);
          assert.equal(error.stack.includes("redirect-secret"), false);
          return true;
        },
      );
    });
  });

  await t.test("redirect body fetch has its own hard timeout", async () => {
    await withSource(current.image, async (sourcePath) => {
      const requests = [];
      const started = Date.now();
      await assert.rejects(
        verifyPinnedLocalDockerImage({
          sourcePath,
          fetchImpl: ecrFetch(current, requests, { configRedirect: redirect, redirectNever: true }),
          timeoutMs: 20,
        }),
        /Pinned image config redirect timed out after 20 ms/,
      );
      assert.equal(requests.length, 4);
      assert.ok(Date.now() - started < 500, "redirect timeout must not depend on the fetch client settling");
    });
  });
});

test("source parser accepts one immutable reviewed repository reference only", async () => {
  const current = fixture();
  assert.equal(parsePinnedImageReference(current.image).manifestDigest, current.manifestDigest);
  for (const invalid of [
    current.image.replace("public.ecr.aws", "example.invalid"),
    current.image.replace(EXPECTED_REPOSITORY, "someone/else"),
    `public.ecr.aws/${EXPECTED_REPOSITORY}:latest`,
    current.image.toUpperCase(),
  ]) assert.throws(() => parsePinnedImageReference(invalid), /must pin public\.ecr\.aws/);

  await withSource(current.image, async (sourcePath) => {
    assert.equal((await readPinnedImageReference(sourcePath)).reference, current.image);
    await writeFile(
      sourcePath,
      `export const LOCAL_DOCKER_BOX_IMAGE = ${JSON.stringify(current.image)};\nexport const LOCAL_DOCKER_BOX_IMAGE = ${JSON.stringify(current.image)};\n`,
      "utf8",
    );
    await assert.rejects(readPinnedImageReference(sourcePath), /exactly one exported/);
  });
});

test("manifest and config blob digest mismatches fail closed", async (t) => {
  await t.test("manifest bytes", async () => {
    const current = fixture();
    await withSource(current.image, async (sourcePath) => {
      const requests = [];
      await assert.rejects(
        verifyPinnedLocalDockerImage({
          sourcePath,
          fetchImpl: ecrFetch(current, requests, { manifestBytes: Buffer.concat([current.manifestBytes, Buffer.from(" ")]) }),
          timeoutMs: 500,
        }),
        /manifest bytes do not match/,
      );
      assert.equal(requests.length, 2);
    });
  });

  await t.test("config blob bytes", async () => {
    const current = fixture();
    await withSource(current.image, async (sourcePath) => {
      const corrupt = Buffer.from(current.configBytes);
      corrupt[0] ^= 1;
      await assert.rejects(
        verifyPinnedLocalDockerImage({
          sourcePath,
          fetchImpl: ecrFetch(current, [], { configBytes: corrupt }),
          timeoutMs: 500,
        }),
        /config blob bytes do not match/,
      );
    });
  });
});

test("unexpected platform or entrypoint fails closed", async (t) => {
  for (const [name, options, expected] of [
    ["operating system", { osName: "windows" }, /platform must be linux\/amd64/],
    ["architecture", { architecture: "arm64" }, /platform must be linux\/amd64/],
    ["entrypoint", { entrypoint: ["/bin/sh"] }, /entrypoint must be \/usr\/local\/bin\/start-sand-box/],
  ]) {
    await t.test(name, async () => {
      const current = fixture(options);
      await withSource(current.image, async (sourcePath) => {
        await assert.rejects(
          verifyPinnedLocalDockerImage({ sourcePath, fetchImpl: ecrFetch(current, []), timeoutMs: 500 }),
          expected,
        );
      });
    });
  }
});

test("network failures are bounded and never disclose the bearer token", async (t) => {
  const current = fixture();
  await t.test("fetch implementation errors are sanitized", async () => {
    await withSource(current.image, async (sourcePath) => {
      const requests = [];
      await assert.rejects(
        verifyPinnedLocalDockerImage({
          sourcePath,
          fetchImpl: ecrFetch(current, requests, { manifestError: true }),
          timeoutMs: 500,
        }),
        error => {
          assert.match(error.message, /failed before provenance could be verified/);
          assert.equal(error.message.includes(TOKEN), false);
          assert.equal(error.stack.includes(TOKEN), false);
          return true;
        },
      );
    });
  });

  await t.test("each request has a hard timeout", async () => {
    await withSource(current.image, async (sourcePath) => {
      const started = Date.now();
      await assert.rejects(
        verifyPinnedLocalDockerImage({ sourcePath, fetchImpl: () => new Promise(() => {}), timeoutMs: 20 }),
        /timed out after 20 ms/,
      );
      assert.ok(Date.now() - started < 500, "timeout must not depend on the fetch client settling");
    });
  });
});

test("release and scheduled provenance workflows run the bounded verifier without adding PR network flakiness", async () => {
  const [packageJson, releaseWorkflow, checkWorkflow, releaseBundle] = await Promise.all([
    readFile(path.join(repoRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(repoRoot, ".github/workflows/windows-draft-release.yml"), "utf8"),
    readFile(path.join(repoRoot, ".github/workflows/check.yml"), "utf8"),
    readFile(path.join(repoRoot, "scripts/create-windows-release-bundle.mjs"), "utf8"),
  ]);
  assert.equal(packageJson.scripts["docker:image:verify"], "node scripts/verify-local-docker-image.mjs");

  const checksAt = releaseWorkflow.indexOf("npm run publication:check");
  const provenanceAt = releaseWorkflow.indexOf("npm run docker:image:verify");
  const packageAt = releaseWorkflow.indexOf("npm run package:windows");
  assert.ok(checksAt !== -1 && checksAt < provenanceAt && provenanceAt < packageAt);
  assert.match(releaseBundle, /pinnedDockerImageProvenance: "passed"/);

  const regularChecks = checkWorkflow.slice(checkWorkflow.indexOf("  check:"), checkWorkflow.indexOf("  windows-x64-portable:"));
  const scheduledChecks = checkWorkflow.slice(checkWorkflow.indexOf("  full-original-provenance:"));
  assert.doesNotMatch(regularChecks, /docker:image:verify/);
  assert.match(scheduledChecks, /npm run docker:image:verify/);
});
