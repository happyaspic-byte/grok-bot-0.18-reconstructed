import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(import.meta.dirname, "..");

async function loadHelper() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-win-acl-module-"));
  const output = path.join(temporary, "windows-private-path.mjs");
  await build({ entryPoints: [path.join(repoRoot, "source/shared/node/windows-private-path.ts")], outfile: output, bundle: true, format: "esm", platform: "node", target: "node22" });
  return { module: await import(`${pathToFileURL(output).href}?${Date.now()}`), dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("Windows credential ACL uses an encoded literal path and verifies the exact SID allow-list", async () => {
  const loaded = await loadHelper();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok win acl path "));
  const target = path.join(temporary, "Dashboard API key ; & '.json");
  await writeFile(target, "secret");
  let command;
  try {
    assert.deepEqual(loaded.module.windowsPowerShellEnvironment({ Path: "trusted", PSModulePath: "pwsh-modules", psmodulepath: "shadow" }), { Path: "trusted" });
    const result = await loaded.module.hardenWindowsPrivatePath(target, {
      platform: "win32",
      powershell: async (executable, args) => {
        command = { executable, args };
        return { stdout: JSON.stringify({ target, inherited: false, accessRuleCount: 3, principals: ["S-1-5-18", "S-1-5-21-test", "S-1-5-32-544"] }) };
      },
    });
    assert.equal(result.accessRuleCount, 3);
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? process.env.WINDIR ?? "C:\\Windows";
    assert.equal(command.executable, path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
    assert.deepEqual(command.args.slice(0, -1), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
    const script = Buffer.from(command.args.at(-1), "base64").toString("utf16le");
    assert.doesNotMatch(script, /Dashboard API key/);
    assert.match(script, /PSModulePath = \[IO\.Path\]::Combine\(\$PSHOME, 'Modules'\)/);
    assert.match(script, /Import-Module Microsoft\.PowerShell\.Management, Microsoft\.PowerShell\.Security, Microsoft\.PowerShell\.Utility/);
    assert.match(script, /S-1-5-18/);
    assert.match(script, /S-1-5-32-544/);
    assert.match(script, /SetAccessRuleProtection\(\$true, \$false\)/);
    assert.match(script, /Rules\.Count -ne 3/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
    await loaded.dispose();
  }
});

test("Windows credential ACL refuses non-Windows claims and links before invoking PowerShell", async () => {
  const loaded = await loadHelper();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-win-acl-link-"));
  const target = path.join(temporary, "secret.json");
  const link = path.join(temporary, "secret-link.json");
  await writeFile(target, "secret");
  await symlink(target, link);
  try {
    await assert.rejects(() => loaded.module.hardenWindowsPrivatePath(target, { platform: "linux" }), /require win32/);
    await assert.rejects(() => loaded.module.hardenWindowsPrivatePath(link, { platform: "win32", powershell: async () => { throw new Error("must not run"); } }), /link or special file/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
    await loaded.dispose();
  }
});
