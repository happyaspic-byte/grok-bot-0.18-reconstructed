import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const workflowPath = path.join(repoRoot, ".github", "workflows", "windows-draft-release.yml");

test("Windows release workflow is main-only, manual-capable, and draft-only", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /gh release create[\s\S]*--draft --prerelease --latest=false/);
  assert.match(workflow, /publicReleaseEligible -ne \$false/);
  assert.doesNotMatch(workflow, /pull_request:/);
  assert.doesNotMatch(workflow, /gh release create[^\n]*--public/);
});

test("Windows release workflow verifies and launches both the directory and ZIP round trip", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  for (const command of [
    "npm run package:windows",
    "npm run verify:windows",
    "npm run smoke:windows",
    "node scripts/verify-windows.mjs --app $roundTripPortable",
    "node scripts/smoke-windows.mjs --app $roundTripPortable",
    "sha256sum --check SHA256SUMS.txt",
  ]) assert.ok(workflow.includes(command), `missing release gate: ${command}`);

  const publicationCheck = await readFile(path.join(repoRoot, "scripts", "verify-publication-tree.mjs"), "utf8");
  assert.match(publicationCheck, /process\.platform === "win32" \? "git" : "\/usr\/bin\/git"/);
  assert.match(publicationCheck, /process\.platform === "win32" \? "tar" : "\/usr\/bin\/tar"/);
});

test("write permission exists only in the isolated draft creation job", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const buildJob = workflow.slice(workflow.indexOf("  build-and-smoke:"), workflow.indexOf("  create-draft-release:"));
  const publishJob = workflow.slice(workflow.indexOf("  create-draft-release:"));
  assert.doesNotMatch(buildJob, /contents: write/);
  assert.match(publishJob, /contents: write/);
  assert.doesNotMatch(publishJob, /npm |node scripts|git lfs|package:windows/);
  for (const pin of [
    "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
    "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
    "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6",
    "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
    "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
  ]) assert.ok(workflow.includes(pin), `unpinned release action: ${pin}`);
});
