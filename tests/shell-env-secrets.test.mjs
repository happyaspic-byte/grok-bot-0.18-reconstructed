import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(import.meta.dirname, "..");

async function loadEnvFilter() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-shell-env-filter-"));
  const output = path.join(temporary, "env-filter.mjs");
  await build({
    stdin: {
      contents: [
        'export * from "./source/packages/shell-exec/env-filter.ts";',
        'export { buildSandboxChildEnvironment } from "./source/packages/shell-exec/sandbox/helper-protocol.ts";',
        'export * from "./source/box-exec-daemon/shell-security.ts";',
      ].join("\n"),
      resolveDir: repoRoot,
      sourcefile: "shell-env-test.ts",
    },
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  return {
    module: await import(`${pathToFileURL(output).href}?${Date.now()}`),
    dispose: () => rm(temporary, { recursive: true, force: true }),
  };
}

test("model-invoked child environments omit host control credentials", async () => {
  const loaded = await loadEnvFilter();
  try {
    const input = Object.fromEntries([
      ...loaded.module.HOST_CONTROL_ENV_VARS_TO_SCRUB.map((key) => [key, `secret:${key}`]),
      ["ELECTRON_RUN_AS_NODE", "1"],
      ["PATH", "/usr/bin"],
      ["SAFE_VISIBLE_VALUE", "visible"],
    ]);
    const filtered = loaded.module.filterElectronEnv(input);
    for (const key of loaded.module.HOST_CONTROL_ENV_VARS_TO_SCRUB) {
      assert.equal(filtered[key], undefined, `${key} must not reach an agent shell`);
    }
    assert.equal(filtered.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(filtered.PATH, "/usr/bin");
    assert.equal(filtered.SAFE_VISIBLE_VALUE, "visible");
  } finally {
    await loaded.dispose();
  }
});

test("every shell spawn passes through the shared child-environment filter", async () => {
  const sandbox = await readFile(path.join(repoRoot, "source/packages/shell-exec/sandbox/sandbox.ts"), "utf8");
  const core = await readFile(path.join(repoRoot, "source/packages/shell-exec/core.ts"), "utf8");
  assert.match(sandbox, /options\.env = filterElectronEnv\(options\.env\)/);
  assert.match(core, /const child = spawnInSandbox\(/);
});

test("sandbox-helper environment merging cannot reintroduce parent or option credentials", async () => {
  const loaded = await loadEnvFilter();
  const previous = process.env.SAND_GATEWAY_TOKEN;
  try {
    process.env.SAND_GATEWAY_TOKEN = "parent-gateway-secret";
    const environment = loaded.module.buildSandboxChildEnvironment({
      SAND_BOX_EXEC_DAEMON_AUTH_TOKEN: "option-daemon-secret",
      SAFE_OPTION: "visible",
    });
    assert.equal(environment.SAND_GATEWAY_TOKEN, undefined);
    assert.equal(environment.SAND_BOX_EXEC_DAEMON_AUTH_TOKEN, undefined);
    assert.equal(environment.SAFE_OPTION, "visible");
  } finally {
    if (previous === undefined) delete process.env.SAND_GATEWAY_TOKEN;
    else process.env.SAND_GATEWAY_TOKEN = previous;
    await loaded.dispose();
  }
});

test("box-exec daemon scrubs parent, update, and child environments and drops shell identity", async () => {
  const loaded = await loadEnvFilter();
  try {
    const identity = loaded.module.resolveBoxExecShellIdentity({ SAND_BOX_EXEC_SHELL_USER: "box" }, {
      platform: "linux",
      passwd: "root:x:0:0:root:/root:/bin/sh\nbox:x:1001:1002:Box:/home/box:/bin/sh\n",
      currentUid: 0,
      currentGid: 0,
    });
    assert.deepEqual(identity, { username: "box", uid: 1001, gid: 1002, home: "/home/box" });
    assert.throws(() => loaded.module.resolveBoxExecShellIdentity({ SAND_BOX_EXEC_SHELL_USER: "root" }, {
      platform: "linux",
      passwd: "root:x:0:0:root:/root:/bin/sh\n",
      currentUid: 0,
      currentGid: 0,
    }), /not a non-root account/);
    assert.throws(() => loaded.module.resolveBoxExecShellIdentity({ SAND_BOX_EXEC_SHELL_USER: "box" }, {
      platform: "linux",
      passwd: "box:x:1001:1002:Box:/home/box:/bin/sh\n",
      currentUid: 1001,
      currentGid: 1002,
    }), /must not share a uid/);

    const child = loaded.module.sanitizeBoxExecShellEnvironment({
      SAND_GATEWAY_TOKEN: "parent-secret",
      SAND_DEV_INFERENCE_TOKEN_FILE: "/run/secret",
      HOME: "/root",
      SAFE_PARENT: "visible",
    }, identity);
    assert.equal(child.SAND_GATEWAY_TOKEN, undefined);
    assert.equal(child.SAND_DEV_INFERENCE_TOKEN_FILE, undefined);
    assert.equal(child.SAFE_PARENT, "visible");
    assert.equal(child.HOME, "/home/box");
    assert.equal(child.USER, "box");
    assert.equal(child.LOGNAME, "box");

    const current = { PATH: "/usr/bin", SAND_GATEWAY_TOKEN: "stale-secret" };
    const result = loaded.module.applySanitizedBoxExecEnvironmentUpdate(current, {
      replace: false,
      env: { SAFE_UPDATE: "visible", SAND_BOX_EXEC_DAEMON_AUTH_TOKEN: "update-secret" },
    });
    assert.deepEqual(result, { applied: 1, removed: 1 });
    assert.deepEqual(current, { PATH: "/usr/bin", SAFE_UPDATE: "visible" });

    const server = await readFile(path.join(repoRoot, "source/box-exec-daemon/server.ts"), "utf8");
    assert.match(server, /this\.#environment = sanitizeBoxExecShellEnvironment\(environment, shellIdentity\)/);
    assert.match(server, /applySanitizedBoxExecEnvironmentUpdate\(this\.#environment, request\)/);
    assert.match(server, /env: sanitizeBoxExecShellEnvironment\(this\.#environment, this\.shellIdentity\)/);
    assert.match(server, /uid: this\.shellIdentity\.uid, gid: this\.shellIdentity\.gid/);
  } finally {
    await loaded.dispose();
  }
});
