import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  applyReconstructedUpdaterGuard,
  prepareReconstructedElectronMainArtifactFallback,
  reconstructedUpdaterGuard,
} from "../scripts/lib/build-asar.mjs";

const root = path.resolve(import.meta.dirname, "..");

test("reconstructed fallback and clean packaging share one idempotent service guard", async () => {
  const source = "console.log('electron-main');\n";
  const guarded = applyReconstructedUpdaterGuard(source);
  assert.equal(guarded, `${reconstructedUpdaterGuard}${source}`);
  assert.equal(applyReconstructedUpdaterGuard(guarded), guarded);
  assert.match(guarded, /SAND_DISABLE_UPDATES = "1"/);
  assert.match(guarded, /SAND_DISABLE_SENTRY \?\?= "1"/);
  assert.match(guarded, /SAND_DISABLE_TELEMETRY \?\?= "1"/);
  assert.match(guarded, /SAND_DISABLE_PROTOCOL_REGISTRATION = "1"/);
  assert.match(guarded, /Grok Bot 0\.18 Reconstructed/);

  const fallbackFixture = [
    "var isSandLabBuild2 = appPackageJson.sandLab === true;",
    "var isPrimaryInstance = !import_electron51.app.isPackaged || import_electron51.app.requestSingleInstanceLock();",
    "if (import_electron51.app.isPackaged && !isSandLabBuild2) {",
    "    import_electron51.app.setAsDefaultProtocolClient(SAND_DEEP_LINK_SCHEME);",
    "  }",
  ].join("\n");
  const productionFallback = prepareReconstructedElectronMainArtifactFallback(fallbackFixture);
  assert.ok(productionFallback.startsWith(reconstructedUpdaterGuard));
  assert.match(productionFallback, /process\.env\.SAND_DISABLE_PROTOCOL_REGISTRATION !== "1"/);
  assert.doesNotMatch(productionFallback, /isPackaged && !isSandLabBuild2\) \{\n    import_electron51\.app\.setAsDefaultProtocolClient/);

  const cleanBuildSource = await readFile(path.join(root, "scripts", "clean-build.mjs"), "utf8");
  assert.match(cleanBuildSource, /runtimeCompositionForPlatform\(built\.runtime\?\.platform\), \{ reconstructedPackage: true \}/);
});
