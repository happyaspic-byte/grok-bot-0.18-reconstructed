import assert from "node:assert/strict";
import test from "node:test";

import { build } from "esbuild";

let providerModule;

async function loadProviderModule() {
  if (providerModule != null) return providerModule;
  const result = await build({
    bundle: true,
    entryPoints: ["source/electron-main/production-binding-providers.ts"],
    external: ["electron"],
    format: "esm",
    logLevel: "silent",
    platform: "node",
    target: "node26",
    write: false,
  });
  providerModule = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`);
  return providerModule;
}

function startupPorts(platform) {
  return {
    platform,
    argv: [],
    env: {},
    app: {
      isPackaged: true,
      setPath() {},
      getPath() { return "fixture"; },
      relaunch() { assert.fail("Windows move check must not relaunch"); },
      exit() { assert.fail("Windows move check must not exit"); },
    },
    dialog: {
      async showMessageBox() {
        assert.fail("Windows move check must not show a macOS move dialog");
      },
    },
    async readDiscovery() { return null; },
    isDaemonProcess() { return false; },
    async terminate() {},
    isProcessAlive() { return false; },
  };
}

test("Windows startup accepts the absence of macOS-only application APIs", async () => {
  const { createProductionStartupBinding } = await loadProviderModule();
  const binding = createProductionStartupBinding(startupPorts("win32"));
  const disposition = await binding.runMoveCheck({
    dataRootSettlement: null,
    isLabBuild: false,
    hasPendingActivation: () => false,
    beforeExit: () => assert.fail("Windows move check must continue bootstrap"),
  });
  assert.equal(disposition, "continue-bootstrap");
  assert.throws(
    () => createProductionStartupBinding(startupPorts("darwin")),
    /requires electron\.app\.isInApplicationsFolder\(\)/,
  );
});

test("Windows notifications degrade the unsupported application badge API to a no-op", async () => {
  const { createProductionNotificationsBinding } = await loadProviderModule();
  class FixtureNotification {
    static isSupported() { return false; }
  }
  const binding = createProductionNotificationsBinding({
    platform: "win32",
    Notification: FixtureNotification,
    app: {},
  });
  const service = binding.create({
    getMainWindow: () => null,
    requireMainEdge: () => ({ emit() {} }),
  });
  service.resetAccountState();
  service.dispose();
  assert.throws(
    () => createProductionNotificationsBinding({ platform: "darwin", Notification: FixtureNotification, app: {} }),
    /requires electron\.app\.setBadgeCount\(\)/,
  );
});
