import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-cli-proxy-store-module-"));
  const output = path.join(temporary, "store.mjs");
  await build({ entryPoints: [path.join(repoRoot, "source/electron-main/secrets/cli-proxy-secret-store.ts")], outfile: output, bundle: true, format: "esm", platform: "node", target: "node22", external: ["electron"] });
  return { module: await import(`${pathToFileURL(output).href}?${Date.now()}`), dispose: () => rm(temporary, { recursive: true, force: true }) };
}

const publicConfig = { baseUrl: "http://127.0.0.1:20128/v1", model: "provider/model", protocol: "chat-completions", allowRemoteHttps: false, allowTailscaleHttp: false };

test("dedicated 9Router store persists one ciphertext and never reveals it in status", async () => {
  const loaded = await loadModule(), temporary = await mkdtemp(path.join(os.tmpdir(), "grok-cli-proxy-store-"));
  try {
    const storePath = path.join(temporary, "cli-proxy-provider.json");
    const key = "proxy-secret-not-management";
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`cipher:${[...value].reverse().join("")}`),
      decryptString: (value) => [...value.toString().slice(7)].reverse().join(""),
    };
    const store = new loaded.module.SandCliProxySecretStore(storePath, safeStorage);
    const status = await store.save({ ...publicConfig, apiKey: key });
    assert.equal(status.configured, true);
    assert.equal("apiKey" in status, false);
    assert.equal((await store.getTurnConfig()).apiKey, key);
    const persisted = await readFile(storePath, "utf8");
    assert.equal(persisted.includes(key), false);
    assert.equal(persisted.includes(Buffer.from(key).toString("base64")), false);
    assert.deepEqual(Object.keys(JSON.parse(persisted)).sort(), ["apiKeyCiphertext", "config", "schemaVersion"]);
    await Promise.all([
      store.save({ ...publicConfig, model: "provider/first" }),
      store.save({ ...publicConfig, model: "provider/second" }),
    ]);
    assert.equal((await store.status()).model, "provider/second");
    assert.deepEqual((await readdir(temporary)).filter(name => /\.(?:tmp|bak)$/.test(name)), []);
  } finally { await loaded.dispose(); await rm(temporary, { recursive: true, force: true }); }
});

test("9Router store hardens the temporary credential before publishing it", async () => {
  const loaded = await loadModule(), temporary = await mkdtemp(path.join(os.tmpdir(), "grok-cli-proxy-hardening-"));
  try {
    const storePath = path.join(temporary, "cli-proxy-provider.json");
    const hardened = [];
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`cipher:${value}`),
      decryptString: (value) => value.toString().slice(7),
    };
    const store = new loaded.module.SandCliProxySecretStore(storePath, safeStorage, async (target) => {
      hardened.push(target);
      assert.match(path.basename(target), /^cli-proxy-provider\.json\..+\.tmp$/);
      assert.equal((await readFile(target, "utf8")).includes("private-dashboard-key"), false);
      await assert.rejects(() => readFile(storePath, "utf8"), /ENOENT/);
    });
    await store.save({ ...publicConfig, apiKey: "private-dashboard-key" });
    assert.equal(hardened.length, 1);
    assert.equal((await store.getTurnConfig()).apiKey, "private-dashboard-key");
  } finally { await loaded.dispose(); await rm(temporary, { recursive: true, force: true }); }
});

test("unavailable or throwing safeStorage falls back to a session-only credential", async () => {
  const loaded = await loadModule(), temporary = await mkdtemp(path.join(os.tmpdir(), "grok-cli-proxy-session-"));
  try {
    const storePath = path.join(temporary, "cli-proxy-provider.json");
    const safeStorage = { isEncryptionAvailable() { throw new Error("keyring locked"); }, encryptString() { throw new Error("unused"); }, decryptString() { throw new Error("unused"); } };
    const store = new loaded.module.SandCliProxySecretStore(storePath, safeStorage);
    const status = await store.save({ ...publicConfig, apiKey: "session-key" });
    assert.equal(status.isPersistent, false);
    assert.equal(status.configured, true);
    assert.equal((await store.getTurnConfig()).apiKey, "session-key");
    assert.deepEqual(await readdir(temporary), []);
    const encryptThrows = new loaded.module.SandCliProxySecretStore(path.join(temporary, "encrypt-throws.json"), {
      isEncryptionAvailable: () => true,
      encryptString() { throw new Error("keychain locked after availability check"); },
      decryptString() { throw new Error("unused"); },
    });
    const fallback = await encryptThrows.save({ ...publicConfig, apiKey: "late-session-key" });
    assert.equal(fallback.isPersistent, false);
    assert.equal((await encryptThrows.getTurnConfig()).apiKey, "late-session-key");
    assert.deepEqual(await readdir(temporary), []);
  } finally { await loaded.dispose(); await rm(temporary, { recursive: true, force: true }); }
});

test("changing the 9Router origin requires re-entering the API key", async () => {
  const loaded = await loadModule(), temporary = await mkdtemp(path.join(os.tmpdir(), "grok-cli-proxy-origin-"));
  try {
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`cipher:${value}`),
      decryptString: (value) => value.toString().slice(7),
    };
    const storePath = path.join(temporary, "persistent.json");
    const store = new loaded.module.SandCliProxySecretStore(storePath, safeStorage);
    await store.save({ ...publicConfig, apiKey: "origin-bound-key" });
    const sameOrigin = await store.save({ ...publicConfig, model: "provider/model-v2" });
    assert.equal(sameOrigin.configured, true);
    assert.equal((await store.getTurnConfig()).apiKey, "origin-bound-key");
    const changedOrigin = await store.save({ ...publicConfig, baseUrl: "http://127.0.0.2:20128/v1" });
    assert.equal(changedOrigin.configured, false);
    await assert.rejects(() => store.getTurnConfig(), /not configured/);
    assert.equal("apiKeyCiphertext" in JSON.parse(await readFile(storePath, "utf8")), false);
    const reconfigured = await store.save({ ...publicConfig, baseUrl: "http://127.0.0.2:20128/v1", apiKey: "replacement-key" });
    assert.equal(reconfigured.configured, true);
    assert.equal((await store.getTurnConfig()).apiKey, "replacement-key");

    const sessionStore = new loaded.module.SandCliProxySecretStore(path.join(temporary, "session.json"), {
      isEncryptionAvailable: () => false,
      encryptString() { throw new Error("unused"); },
      decryptString() { throw new Error("unused"); },
    });
    await sessionStore.save({ ...publicConfig, apiKey: "session-origin-key" });
    const changedSessionOrigin = await sessionStore.save({ ...publicConfig, baseUrl: "http://127.0.0.2:20128/v1" });
    assert.equal(changedSessionOrigin.configured, false);
    await assert.rejects(() => sessionStore.getTurnConfig(), /not configured/);
  } finally { await loaded.dispose(); await rm(temporary, { recursive: true, force: true }); }
});

test("session-only fallback removes any older persistent credential before activation", async () => {
  const loaded = await loadModule(), temporary = await mkdtemp(path.join(os.tmpdir(), "grok-cli-proxy-no-resurrection-"));
  try {
    const storePath = path.join(temporary, "provider.json");
    let encryptionAvailable = true;
    let encryptionThrows = false;
    const safeStorage = {
      isEncryptionAvailable: () => encryptionAvailable,
      encryptString(value) {
        if (encryptionThrows) throw new Error("keychain locked");
        return Buffer.from(`cipher:${value}`);
      },
      decryptString: (value) => value.toString().slice(7),
    };
    const store = new loaded.module.SandCliProxySecretStore(storePath, safeStorage);
    await store.save({ ...publicConfig, apiKey: "old-disk-key" });
    encryptionAvailable = false;
    await store.save({ ...publicConfig, apiKey: "new-session-key" });
    await assert.rejects(() => readFile(storePath, "utf8"), /ENOENT/);
    assert.equal((await store.getTurnConfig()).apiKey, "new-session-key");

    encryptionAvailable = true;
    const restarted = new loaded.module.SandCliProxySecretStore(storePath, safeStorage);
    await assert.rejects(() => restarted.getTurnConfig(), /not configured/);

    await restarted.save({ ...publicConfig, apiKey: "second-disk-key" });
    encryptionThrows = true;
    await restarted.save({ ...publicConfig, apiKey: "late-session-key" });
    await assert.rejects(() => readFile(storePath, "utf8"), /ENOENT/);
    assert.equal((await restarted.getTurnConfig()).apiKey, "late-session-key");
  } finally { await loaded.dispose(); await rm(temporary, { recursive: true, force: true }); }
});

test("session fallback fails closed when the previous credential cannot be removed", async () => {
  const loaded = await loadModule(), temporary = await mkdtemp(path.join(os.tmpdir(), "grok-cli-proxy-delete-failure-"));
  try {
    const storePath = path.join(temporary, "provider.json");
    await mkdir(storePath);
    await writeFile(path.join(storePath, "blocker"), "x");
    const store = new loaded.module.SandCliProxySecretStore(storePath, {
      isEncryptionAvailable: () => false,
      encryptString() { throw new Error("unused"); },
      decryptString() { throw new Error("unused"); },
    });
    await assert.rejects(() => store.save({ ...publicConfig, apiKey: "must-not-activate" }), /not activated/);
    await assert.rejects(() => store.getTurnConfig(), /not configured/);
  } finally { await loaded.dispose(); await rm(temporary, { recursive: true, force: true }); }
});

test("9Router key path is separate from user and box secret export paths", async () => {
  for (const relative of ["source/electron-main/secrets/user-secrets-store.ts", "source/electron-main/secrets/secrets-ipc.ts", "source/host/extensions/secrets/secrets-service.ts"]) {
    const source = await readFile(path.join(repoRoot, relative), "utf8");
    if (!relative.endsWith("secrets-ipc.ts")) assert.doesNotMatch(source, /CLI_PROXY_API_KEY|9ROUTER_API_KEY/);
  }
  const source = await readFile(path.join(repoRoot, "source/electron-main/secrets/cli-proxy-secret-store.ts"), "utf8");
  assert.match(source, /apiKeyCiphertext/);
  assert.doesNotMatch(source, /exportSnapshot|setBoxSecrets|userSecrets/);
});
