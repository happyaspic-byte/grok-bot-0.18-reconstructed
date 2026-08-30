import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import yaml from "js-yaml";

const repoRoot = path.resolve(import.meta.dirname, "..");
const workflowPath = path.join(repoRoot, ".github", "workflows", "windows-draft-release.yml");
const checkWorkflowPath = path.join(repoRoot, ".github", "workflows", "check.yml");

test("Windows release workflow is main-only, manual-capable, and draft-only", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  assert.match(workflow, /^name: Windows push-access-visible draft release$/m);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /gh release create[\s\S]*--draft --prerelease --latest=false/);
  assert.match(workflow, /create-windows-release-bundle\.mjs/);
  assert.doesNotMatch(workflow, /pull_request:/);
  assert.doesNotMatch(workflow, /gh release create[^\n]*--public/);
  assert.doesNotMatch(workflow, /collaborator-visible|immutable unpublished/i);
  for (const releaseInput of [
    ".gitattributes",
    ".github/workflows/**",
    ".gitignore",
    ".node-version",
    "package.json",
    "package-lock.json",
    "README.md",
    "docs/**",
    "frontend/**",
    "manifests/**",
    "patches/**",
    "research-archives/original/0.18.0/**",
    "scripts/**",
    "source/**",
    "src/app/**",
    "tests/**",
  ]) {
    assert.ok(workflow.includes(`- ${releaseInput}`), `release trigger omits build input: ${releaseInput}`);
  }
});

test("Windows release workflow selectively hydrates LFS and uses the repository Node contract", async () => {
  const [workflow, nodeVersion, packageJson, packageLock] = await Promise.all([
    readFile(workflowPath, "utf8"),
    readFile(path.join(repoRoot, ".node-version"), "utf8").then((value) => value.trim()),
    readFile(path.join(repoRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(repoRoot, "package-lock.json"), "utf8").then(JSON.parse),
  ]);
  assert.equal(nodeVersion, "26.5.0");
  assert.equal(packageJson.engines.node, ">=26.5.0 <27");
  assert.equal(packageLock.lockfileVersion, 3);
  assert.match(workflow, /lfs: false[\s\S]*persist-credentials: false/);
  assert.match(workflow, /git lfs pull --include="research-archives\/original\/0\.18\.0\/windows-x64\/Grok_Bot_0\.18\.0_Setup\.exe" --exclude=""/);
  assert.match(workflow, /node-version: 26\.5\.0[\s\S]*cache: npm/);
  assert.match(workflow, /npm ci --no-audit --no-fund/);
});

test("workflow enforces append-only identity and safely resumes only an exact partial unpublished draft", async () => {
  const [workflow, bundle] = await Promise.all([
    readFile(workflowPath, "utf8"),
    readFile(path.join(repoRoot, "scripts", "create-windows-release-bundle.mjs"), "utf8"),
  ]);
  assert.match(workflow, /RELEASE_VERSION: 0\.18\.0-reconstructed\.3/);
  assert.match(bundle, /Portable manifest version[\s\S]*does not match package version/);
  assert.match(bundle, /mkdtemp\(path\.join\(releaseParent, `\.\$\{releaseBase\}\.reproducible-`\)\)/);
  assert.match(bundle, /path\.join\(stagingRoot, "attempt-a"\)/);
  assert.match(bundle, /path\.join\(stagingRoot, "attempt-b"\)/);
  assert.match(bundle, /publication lock/);
  assert.match(bundle, /Release bundle is not reproducible across two clean attempts/);
  assert.match(bundle, /sourceCommitAtUtc/);
  assert.match(bundle, /visibility: "push-access-visible-draft"/);
  assert.match(bundle, /classification: "artifact-attributed-dependency-sbom"/);
  assert.match(bundle, /artifactSha256: zipHash/);
  assert.match(bundle, /"--omit=dev"/);
  assert.doesNotMatch(bundle, /Date\.now|randomUUID|ImageVersion|ImageOS/);
  assert.doesNotMatch(workflow, /Compress-Archive|\[DateTime\]::UtcNow/);
  assert.match(workflow, /\.target_commitish == \$commit/);
  assert.match(workflow, /\.object\.type == "commit" and \.object\.sha == \$commit/);
  assert.match(workflow, /Refusing to mutate a release whose tag, title, state, or target commit differs/);
  assert.match(workflow, /normalize\(release\.body \|\| ""\)[\s\S]*normalize\(expected\)/);
  assert.match(workflow, /Refusing to overwrite a different existing release asset/);
  assert.match(workflow, /gh api --paginate "repos\/\$GH_REPO\/releases\?per_page=100"/);
  assert.doesNotMatch(workflow, /repos\/\$GH_REPO\/releases\/tags\/\$RELEASE_TAG/);
  assert.match(workflow, /repos\/\$GH_REPO\/releases\/assets\/\$asset_id[\s\S]*cmp -s -- "\$asset"/);
  assert.match(workflow, /if \[\[ "\$count" == 0 \]\]; then[\s\S]*uploads\.github\.com\/repos\/\$GH_REPO\/releases\/\$release_id\/assets\?name=\$encoded_name/);
  assert.match(workflow, /Preflight every existing expected asset before making any draft[\s\S]*Only after the complete byte preflight may missing assets be/);
  assert.match(workflow, /"\$asset_state" == starter && "\$asset_size" == 0[\s\S]*complete byte preflight[\s\S]*--method DELETE "repos\/\$GH_REPO\/releases\/assets\/\$asset_id"/);
  assert.match(workflow, /Refusing to replace a nonempty or unknown-state release asset/);
  assert.match(workflow, /"\$count" != 1[\s\S]*"\$state" != uploaded[\s\S]*"\$remote_size" != "\$local_size"/);
  assert.match(workflow, /remote_digest[\s\S]*local_digest="sha256:/);
  assert.match(workflow, /cmp -s -- "\$expected_names" "\$work\/final-assets\.txt"/);
  assert.match(workflow, /comm -13 "\$expected_names" "\$existing_names"[\s\S]*draft contains unexpected assets/);
  assert.doesNotMatch(workflow, /--clobber/);
  assert.doesNotMatch(workflow, /gh release edit/);
});

test("Windows release workflow verifies and launches both the directory and ZIP round trip", async () => {
  const [workflow, bundle] = await Promise.all([
    readFile(workflowPath, "utf8"),
    readFile(path.join(repoRoot, "scripts", "create-windows-release-bundle.mjs"), "utf8"),
  ]);
  for (const command of [
    "npm run package:windows",
    "npm run verify:windows",
    "npm run smoke:windows",
    "node scripts/verify-windows.mjs --app $roundTripPortable",
    "node scripts/smoke-windows.mjs --app $roundTripPortable",
    "sha256sum --check SHA256SUMS.txt",
  ]) assert.ok(workflow.includes(command), `missing release gate: ${command}`);
  assert.match(workflow, /\$PSNativeCommandUseErrorActionPreference = \$true/);
  assert.match(bundle, /canonicalizeCycloneDx/);
  assert.match(workflow, /dotnet-version: 8\.0\.x/);
  assert.match(bundle, /authenticatedCoordinatorResync: "passed"/);
  assert.match(bundle, /strictDockerControlPlane: "passed-with-simulator"/);
  assert.match(bundle, /sourceNativeRouterToolLoop: "passed"/);
  assert.match(bundle, /dockerDesktop: "destination-validation-required"/);

  const checks = await readFile(checkWorkflowPath, "utf8");
  assert.doesNotMatch(checks, /uses: actions\/(?:checkout|setup-node)@v\d/);
  const parsedChecks = yaml.load(checks);
  for (const [jobName, job] of Object.entries(parsedChecks.jobs)) {
    const checkout = job.steps.find((step) => typeof step.uses === "string" && step.uses.startsWith("actions/checkout@"));
    assert.equal(checkout?.with?.["persist-credentials"], false, `${jobName} checkout must not retain the GitHub token for repository code`);
  }
  const windowsJob = checks.slice(checks.indexOf("  windows-x64-portable:"), checks.indexOf("  full-original-provenance:"));
  assert.match(windowsJob, /\$PSNativeCommandUseErrorActionPreference = \$true/);
  assert.match(windowsJob, /actions\/setup-dotnet@a98b56852c35b8e3190ac28c8c2271da59106c68/);
  assert.match(windowsJob, /dotnet-version: 8\.0\.x/);
  assert.match(windowsJob, /npm test/);
  assert.match(windowsJob, /npm run publication:check/);
  assert.match(windowsJob, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/);
  assert.match(windowsJob, /path: reports\/windows-smoke-failure-\*/);
  assert.match(windowsJob, /Preserve redacted Windows smoke diagnostics on failure[\s\S]*if: failure\(\)[\s\S]*if-no-files-found: ignore[\s\S]*include-hidden-files: false[\s\S]*retention-days: 7/);

  const publicationCheck = await readFile(path.join(repoRoot, "scripts", "verify-publication-tree.mjs"), "utf8");
  assert.match(publicationCheck, /process\.platform === "win32" \? "git" : "\/usr\/bin\/git"/);
  assert.match(publicationCheck, /process\.platform === "win32" \? "tar" : "\/usr\/bin\/tar"/);
});

test("Windows launch smoke uses the credential-independent first-run Router entry", async () => {
  const smoke = await readFile(path.join(repoRoot, "scripts", "smoke-windows.mjs"), "utf8");
  const renderer = await readFile(path.join(repoRoot, "frontend", "src", "production", "ProductionRenderer.tsx"), "utf8");
  const panel = await readFile(path.join(repoRoot, "frontend", "src", "recovered", "features", "settings", "overlay", "panels.tsx"), "utf8");
  const surface = await readFile(path.join(repoRoot, "frontend", "src", "recovered", "features", "settings", "overlay", "desktop-surface.tsx"), "utf8");
  const firstRun = smoke.indexOf("configure 9router");
  const provider = smoke.indexOf("router provider");
  const option = smoke.indexOf("openai-compatible / 9router");
  const backend = smoke.indexOf('value?.provider === "cli-proxy"');
  const rendererExpressions = [...smoke.matchAll(/await waitForRendererState\(\s*cdp,\s*`([^`]*)`,/g)].map((match) => match[1]);
  assert.ok(firstRun !== -1 && firstRun < provider && provider < option && option < backend);
  assert.ok(rendererExpressions.length >= 5);
  for (const expression of rendererExpressions) {
    assert.doesNotThrow(() => Function(`"use strict"; return (${expression});`), `invalid CDP expression: ${expression}`);
  }
  assert.match(smoke, /configure\?\.click\(\)/);
  assert.match(smoke, /provider\?\.click\(\)/);
  assert.match(smoke, /option\?\.click\(\)/);
  assert.match(smoke, /\.trim\(\)\.toLowerCase\(\) === 'openai-compatible \/ 9router'/);
  assert.match(smoke, /input\[aria-label="9Router Base URL"\]/);
  assert.match(renderer, /aria-label="Configure 9Router"/);
  assert.match(renderer, /aria-label=\{UI_TEXT\.title\}[\s\S]{0,100}role="main"/);
  assert.match(smoke, /document\.querySelector\('\[role="main"\]\[aria-label="Grok Bot"\]'\)/);
  assert.match(renderer, /setSettingsSection\("router"\);[\s\S]{0,120}setOverlay\("settings"\)/);
  assert.match(renderer, /showSignIn && overlay !== "settings"/);
  assert.match(panel, /ariaLabel="Router provider"/);
  assert.match(panel, /aria-label="9Router Base URL"/);
  assert.ok(surface.indexOf('section === "router"') < surface.indexOf("snapshot == null"), "Router must render before the signed-in settings snapshot resolves");
});

test("the validated Windows job uploads directly to the draft without a release artifact handoff", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const parsed = yaml.load(workflow);
  assert.deepEqual(Object.keys(parsed.jobs), ["build-and-smoke"]);

  const job = parsed.jobs["build-and-smoke"];
  assert.equal(job["runs-on"], "windows-latest");
  assert.equal(job["timeout-minutes"], 90, "two reproducible ZIP passes and both launch smokes need a bounded but realistic Windows budget");
  assert.equal(job.permissions.contents, "write");
  assert.equal(job.permissions.actions, undefined);
  assert.equal(job.permissions["id-token"], "write");
  assert.equal(job.permissions.attestations, "write");

  const stepNames = job.steps.map((step) => step.name);
  const smokeIndex = stepNames.indexOf("Build and launch the Windows x64 portable directory");
  const bundleIndex = stepNames.indexOf("Create the push-access-visible draft release bundle");
  const attestIndex = stepNames.indexOf("Attest the exact portable ZIP");
  const checksumIndex = stepNames.indexOf("Recheck the ZIP checksum before draft mutation");
  const releaseIndex = stepNames.indexOf("Create or safely resume the workflow-enforced append-only exact-resume unpublished draft");
  const cleanupIndex = stepNames.indexOf("Best-effort cleanup of local release files");
  assert.ok(smokeIndex < bundleIndex && bundleIndex < attestIndex && attestIndex < checksumIndex && checksumIndex < releaseIndex);
  assert.equal(cleanupIndex, job.steps.length - 1);
  assert.equal(job.steps[cleanupIndex].if, "always()");

  const bundleStep = job.steps[bundleIndex];
  assert.match(bundleStep.run, /node scripts\/create-windows-release-bundle\.mjs --app \$portable --release-dir \$releaseDirectory --expected-commit \$env:GITHUB_SHA/);
  assert.doesNotMatch(bundleStep.run, /New-Item[\s\S]*\$releaseDirectory/);

  const releaseStep = job.steps[releaseIndex];
  assert.equal(releaseStep.env.GH_TOKEN, "${{ github.token }}");
  assert.match(releaseStep.env.RELEASE_TITLE, /Unsigned Push-Access-Visible Draft/);
  assert.match(releaseStep.run, /gh api --paginate "repos\/\$GH_REPO\/releases\?per_page=100"/);
  assert.match(releaseStep.run, /uploads\.github\.com\/repos\/\$GH_REPO\/releases\/\$release_id\/assets/);
  assert.match(releaseStep.run, /assets_root=\.release\/windows-x64/);
  assert.match(workflow, /visible only to users with push access/);
  assert.match(workflow, /artifact-attributed production-dependency SBOM/);

  const artifactSteps = job.steps.filter((step) => typeof step.uses === "string" && step.uses.startsWith("actions/upload-artifact@"));
  assert.equal(artifactSteps.length, 1);
  assert.equal(artifactSteps[0].name, "Preserve redacted Windows smoke diagnostics on failure");
  assert.equal(artifactSteps[0].if, "failure()");
  assert.equal(artifactSteps[0].with.path, "reports/windows-smoke-failure-*");
  assert.equal(artifactSteps[0].with["retention-days"], 7);

  assert.doesNotMatch(workflow, /actions\/download-artifact@/);
  assert.doesNotMatch(workflow, /windows-x64-(?:owner|push-access-visible)-draft-\$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(workflow, /Transfer the verified bundle|Download only the verified release bundle|create-draft-release:/);
  assert.doesNotMatch(workflow, /actions: write/);
  for (const inaccurateVisibility of [["owner", "only"].join("-"), ["owner", "draft"].join(" "), "private-to-owner", "collaborator-visible"]) {
    assert.equal(workflow.toLowerCase().includes(inaccurateVisibility), false);
  }
  for (const pin of [
    "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803",
    "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38",
    "actions/setup-dotnet@a98b56852c35b8e3190ac28c8c2271da59106c68",
    "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6",
    "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  ]) assert.ok(workflow.includes(pin), `unpinned release action: ${pin}`);
});
