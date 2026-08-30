import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const smokePath = path.join(repoRoot, "scripts", "smoke-windows.mjs");
const fakeDockerRoot = path.join(repoRoot, "scripts", "fixtures", "windows-fake-docker");

test("Windows packaged smoke exercises the complete signed-out 9Router setup in dependency order", async () => {
  const source = await readFile(smokePath, "utf8");
  const milestones = [
    'phase = "fresh-profile-launch"',
    'phase = "provider-selection"',
    'phase = "credential-save-with-blank-model"',
    'phase = "models-probe"',
    'phase = "blank-model-blocker"',
    'phase = "model-save"',
    'phase = "strict-docker-control-plane"',
    'phase = "save-and-continue-without-sign-in"',
    'phase = "login-free-gate"',
    'phase = "first-process-stop"',
    'phase = "first-container-stopped"',
    'phase = "persistent-profile-relaunch"',
    'phase = "persistent-container-recovered"',
    'phase = "final-persistence-scan"',
    'phase = "final-container-stopped"',
  ];
  let previous = -1;
  for (const milestone of milestones) {
    const next = source.indexOf(milestone);
    assert.ok(next > previous, `missing or out-of-order Windows smoke milestone: ${milestone}`);
    previous = next;
  }

  assert.match(source, /window\.desktop\.cursorAccount\.getStatus\(\)/);
  assert.match(source, /authKind === "logged-out"/);
  assert.match(source, /\[role=\"main\"\]\[aria-label=\"Grok Bot\"\]/);
  assert.match(source, /button\[aria-label=\"New\"\]/);
  assert.match(source, /\[role=\"status\"\]\[aria-label=\"Connected\"\]/);
  assert.match(source, /main\[aria-label=\"New chat\"\]/);
  assert.match(source, /emptyWorkspace === true/);
  assert.match(source, /A key without a selected model incorrectly bypassed sign-in/);
  assert.match(source, /9Router without Local Docker incorrectly bypassed sign-in/);
  assert.match(source, /"Save & continue without sign-in"/);
  assert.match(source, /settingsOpen === false && value\.workspace === "local-9router"/);
  assert.match(source, /cliProxyProbeHeld === true/);
  assert.match(source, /Settings closed before the leased model probe and coordinator readiness completed/);
  assert.match(source, /Save & continue did not perform exactly one fresh coordinator activation/);
  assert.match(source, /activationStabilityDeadline = Date\.now\(\) \+ 2_000/);
  assert.match(source, /Save & continue activation did not remain stable/);
  assert.match(source, /runtimeReady === true/);
  assert.match(source, /document\.querySelector\('\[role="dialog"\]\[aria-label="Grok Bot settings"\]'\)/);
  assert.match(source, /matching\.length === 1/);
  assert.match(source, /matchCount: matching\.length/);
  assert.match(source, /label: node\.getAttribute\('aria-label'\)[\s\S]*visible: node\.isConnected/);
  assert.match(source, /credential\?\.isPersistent === true/);
  assert.match(source, /probeModels\?\.includes\(SMOKE_MODEL\)/);
  assert.match(source, /window\.desktop\?\.windowControls\?\.close/);
  assert.match(source, /firstQuitRequestIndex/);
  assert.match(source, /finalQuitRequestIndex/);
  assert.match(source, /process exited before its final 9Router credential lease revocation was acknowledged/);
  assert.match(source, /taskkill was used only as failure cleanup/);
});

test("Windows packaged smoke proves secure quit, persistent recovery, and final stop in order", async () => {
  const source = await readFile(smokePath, "utf8");
  const orderedAssertions = [
    '"First graceful quit did not stop the owned Local Docker VM"',
    'phase = "persistent-profile-relaunch"',
    '"Persistent relaunch did not restart the stopped Local Docker VM"',
    'phase = "final-persistence-scan"',
    '"Final graceful quit did not stop the recovered Local Docker VM"',
    "assertFakeDockerQuitRecoveryLifecycle(dockerCommands)",
  ];
  let previous = -1;
  for (const marker of orderedAssertions) {
    const next = source.indexOf(marker, previous + 1);
    assert.ok(next > previous, `missing or out-of-order quit/recovery assertion: ${marker}`);
    previous = next;
  }

  assert.match(source, /state\?\.ContainerExists !== true \|\| state\.ContainerRunning !== expectedRunning/);
  assert.match(source, /args\[0\] === "run" && args\.includes\("--detach"\) && nameIndex >= 0/);
  assert.match(source, /args\.length === 2 && args\[1\] === SMOKE_CONTAINER && \["start", "stop"\]\.includes\(args\[0\]\)/);
  assert.match(source, /const expectedLifecycle = \["create", "stop", "start", "stop"\]/);
  assert.match(source, /JSON\.stringify\(lifecycle\) !== JSON\.stringify\(expectedLifecycle\)/);
  assert.doesNotMatch(source, /unexpectedly fell back to stopping the owned Local Docker VM/);
});

test("Windows packaged smoke uses authenticated loopback services and never embeds a private Tailnet dependency", async () => {
  const source = await readFile(smokePath, "utf8");
  assert.match(source, /request\.headers\.authorization === `Bearer \$\{secretCanary\}`/);
  assert.match(source, /request\.method === "GET" && request\.url === "\/v1\/models"/);
  assert.match(source, /firstProbeRequests\.length < 1 \|\| firstProbeRequests\.some\(request => request\.method !== "GET" \|\| request\.authorized !== true\)/);
  assert.match(source, /value\?\.options\?\.length === 2[\s\S]*value\.options\.includes\(SECOND_SMOKE_MODEL\)/);
  assert.doesNotMatch(source, /const status = await window\.desktop\.cliProxy\.status\(\); return \{ models:/);
  assert.match(source, /const routerBaseUrl = `http:\/\/127\.0\.0\.1:\$\{routerPort\}\/v1`/);
  assert.match(source, /listenLoopback\(gateway, 1340\)/);
  assert.match(source, /request\.url === "\/events"/);
  assert.match(source, /command === "setHostSettings"/);
  assert.match(source, /request\.clearedCliProxyLease === true/);
  assert.match(source, /delete hostSettingsUpdate\.clearCliProxyCredentialLease/);
  assert.match(source, /command === "leaseCliProxyCredential"/);
  assert.match(source, /Object\.keys\(args\)\.length !== 1/);
  assert.match(source, /config\.apiKey !== secretCanary/);
  assert.match(source, /audit\.cliProxyLeaseValidated = true/);
  assert.match(source, /if \(cliProxyLease\?\.generation === generation\) clearHarnessCliProxyLease\(\)/);
  assert.match(source, /command === "probeCliProxyModels"/);
  assert.match(source, /Object\.keys\(args\)\.length !== 0/);
  assert.match(source, /fetch\(`\$\{lease\.config\.baseUrl\}\/models`/);
  assert.match(source, /method: "GET"/);
  assert.match(source, /authorization: `Bearer \$\{lease\.config\.apiKey\}`/);
  assert.match(source, /"user-agent": "grok-bot-9router\/1"/);
  assert.match(source, /redirect: "error"/);
  assert.match(source, /audit\.credentialFreeCliProxyProbe = true/);
  assert.match(source, /audit\.authenticatedRouterProbe = probeModels\.includes\(SMOKE_MODEL\)/);
  assert.match(source, /holdNextCliProxyProbe/);
  assert.match(source, /held 9Router model probe lease was superseded/);
  assert.match(source, /gatewayRequests: harness\.gatewayRequests/);
  assert.match(source, /routerRequests: harness\.routerRequests/);
  assert.match(source, /cliProxyModelProbes: harness\.gatewayState\.cliProxyModelProbes/);
  assert.match(source, /9Router API key reached the gateway audit log/);
  assert.match(source, /"\/api\/leaseCliProxyCredential", "\/api\/probeCliProxyModels"/);
  assert.match(source, /leaseRequests\.length < 2/);
  assert.match(source, /containerProbeRequests\.length < 2/);
  assert.match(source, /cliProxyLeaseActive !== false/);
  assert.match(source, /gateway\.once\("close", clearHarnessCliProxyLease\)/);
  assert.match(source, /gatewayCredential\.token !== servers\.gatewayState\.token/);
  assert.match(source, /Coordinator resync did not reach/);
  assert.match(source, /hostSettings\.inferenceProvider !== "cli-proxy"/);
  assert.match(source, /Login-free workspace never reached the coordinator roster path/);
  assert.match(source, /requests\.length < 2/);
  assert.match(source, /request\.url\.includes\("\/codex"\)/);
  assert.doesNotMatch(source, /100\.112\.10\.8/);
});

test("Windows smoke preserves the basic and --app entrypoints while defaulting CI to the full flow", async () => {
  const source = await readFile(smokePath, "utf8");
  assert.match(source, /\[--app portable-directory\] \[--basic\]/);
  assert.match(source, /if \(options\.basic\) await runBasicSmoke/);
  assert.match(source, /else await runFullLoginFreeSmoke/);
  assert.match(source, /const verified = await verifyWindowsPortable\(options\.root\)/);
  assert.match(source, /onLaunch\(launched\)[\s\S]{0,300}await connectCdp/);
  assert.match(source, /fetch\(`http:\/\/127\.0\.0\.1:\$\{port\}\/json\/list`, \{[\s\S]{0,120}AbortSignal\.timeout\(Math\.min\(1_000, remainingMs\)\)/);
  assert.equal(source.match(/handle => \{ launched = handle; \}/g)?.length, 3);
  assert.match(source, /childClosePromises\.set\(child, new Promise\(resolve => child\.once\("close"/);
  assert.match(source, /child\.once\("error", error => childLaunchErrors\.set\(child, error\)\)/);
  assert.match(source, /await waitForProcessClose\(launched\.child\)/);
  assert.match(source, /setTimeout\([\s\S]{0,180}Timed out waiting for packaged process close[\s\S]{0,180}closed\.then\(\(\) => \{ clearTimeout\(timeout\); resolve\(\); \}\)/);
  assert.match(source, /Timed out waiting for packaged process close/);
  assert.match(source, /Get-CimInstance Win32_Process/);
  assert.match(source, /const relatedPids = new Set/);
  assert.match(source, /relevantProcesses/);
  assert.match(source, /Basic Windows smoke cleanup also failed/);
  assert.match(source, /RETRYABLE_TEMP_CLEANUP_ERRORS/);
  assert.match(source, /rm\(target, \{ recursive: true, force: true, maxRetries: 0 \}\)/);
  assert.match(source, /removeTemporaryDirectory\(temporary\)/);
  assert.doesNotMatch(source, /rm\(temporary,[^\n]*maxRetries:/);
  assert.match(source, /PASS Windows structural smoke \(launch skipped on \$\{process\.platform\}\)/);
});

test("Windows smoke scans persistence for UTF-8 and UTF-16 key canaries and redacts failure artifacts", async () => {
  const source = await readFile(smokePath, "utf8");
  assert.match(source, /Buffer\.from\(secretCanary, "utf8"\)/);
  assert.match(source, /Buffer\.from\(secretCanary, "utf16le"\)/);
  assert.match(source, /apiKeyCiphertext/);
  assert.match(source, /Expected exactly one encrypted 9Router credential document/);
  assert.match(source, /Page\.captureScreenshot/);
  assert.match(source, /\[REDACTED-9ROUTER-KEY\]/);
  assert.match(source, /--sand-local-exec-generation=\[REDACTED\]/);
  assert.match(source, /local-exec-daemon\.json/);
  assert.match(source, /Windows smoke relevant process inventory \(redacted\)/);
  assert.match(source, /Refusing to write an unredacted Windows smoke failure artifact/);
  assert.match(source, /process\.stderr\.write\(`\$\{failure\.message\}\\n`\)/);
  assert.match(source, /Windows smoke cleanup also failed/);
  assert.match(source, /Windows smoke temporary directory cleanup failed/);
  assert.match(source, /if \(smokeFailure != null\) process\.stderr\.write/);
  assert.match(source, /server\.close\(finish\);[\s\S]{0,240}server\.closeAllConnections\?\.\(\)/);
  assert.match(source, /reports.*windows-smoke-failure/s);
});

test("strict fake Docker validates the Local VM security contract instead of accepting arbitrary commands", async () => {
  const project = await readFile(path.join(fakeDockerRoot, "FakeDocker.csproj"), "utf8");
  const source = await readFile(path.join(fakeDockerRoot, "Program.cs"), "utf8");
  assert.match(project, /<AssemblyName>docker<\/AssemblyName>/);
  assert.match(project, /<TargetFramework>net8\.0<\/TargetFramework>/);

  for (const marker of [
    "com.docker.network.bridge.enable_icc=false",
    "com.grok-bot.local-vm-control=1",
    "no-new-privileges:true",
    "NET_RAW",
    "SAND_GATEWAY_TOKEN_FILE=/run/grok-bot-control/gateway-token",
    "SAND_BOX_EXEC_SHELL_USER=box",
    "127.0.0.1:1340:1340",
    "127.0.0.1:6080:6080",
    "127.0.0.1:6081:6081",
    "test ! -r /run/grok-bot-control/gateway-token",
    "/exec-daemon/index.js serve --port 1337",
    "CapEff:",
    "NoNewPrivs:",
  ]) assert.ok(source.includes(marker), `strict fake Docker lost security assertion: ${marker}`);

  assert.match(source, /args\.Any\(ContainsForbiddenSecret\)/);
  assert.match(source, /SHA256\.HashData/);
  assert.match(source, /GrokBotWindowsSmokeFakeDocker-\{digest\[\.\.24\]\}/);
  assert.match(source, /!environment\.Any\(value => value\.StartsWith\("SAND_GATEWAY_TOKEN="/);
  assert.match(source, /published\.SetEquals\(expectedPublished\)/);
  assert.match(source, /unsupported Docker command/);
  assert.doesNotMatch(source, /100\.112\.10\.8/);
});

test("the packaged app reaches fake Docker only through PATH, without a production bypass hook", async () => {
  const smoke = await readFile(smokePath, "utf8");
  const productionConnector = await readFile(path.join(repoRoot, "source", "electron-main", "box", "local-docker-host-connector.ts"), "utf8");
  assert.match(smoke, /PATH: `\$\{fakeDockerDirectory\}\$\{path\.delimiter\}/);
  assert.match(productionConnector, /spawnDocker\("docker", \[\.\.\.args\]/);
  assert.doesNotMatch(productionConnector, /GROK_BOT_SMOKE|FAKE_DOCKER|SAND_DOCKER_COMMAND/);
});
