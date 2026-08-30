import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";
import { jsonSchema } from "ai";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = {
  baseUrl: "http://127.0.0.1:20128/v1",
  model: "provider/native-model",
  protocol: "chat-completions",
  allowRemoteHttps: false,
  allowTailscaleHttp: false,
  apiKey: "native-secret",
};

function sse(events) {
  const bytes = new TextEncoder().encode(`${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`);
  return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }), { status: 200 });
}

async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

test("cli-proxy prompt sessions hand native tool calls back to Grok Bot", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-provider-native-"));
  const output = path.join(temporary, "provider.mjs");
  const priorDataRoot = process.env.SAND_DATA_ROOT;
  const priorFetch = globalThis.fetch;
  process.env.SAND_DATA_ROOT = temporary;
  try {
    await build({
      stdin: {
        contents: [
          'export { createProviderPromptSession } from "./source/host/extensions/inference/provider-session.ts";',
          'export { toToolSet } from "./source/host/extensions/inference/provider-session.ts";',
          'export { installCliProxyCredentialLease, clearCliProxyCredentialLease } from "./source/host/extensions/inference/cli-proxy-credential-lease.ts";',
        ].join("\n"),
        resolveDir: repoRoot,
        sourcefile: "provider-native-test.ts",
      },
      outfile: output,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
    });
    const loaded = await import(`${pathToFileURL(output).href}?${Date.now()}`);
    loaded.installCliProxyCredentialLease(config);
    const requests = [];
    let turn = 0;
    globalThis.fetch = async (_url, init) => {
      requests.push(JSON.parse(init.body));
      turn += 1;
      return turn === 1
        ? sse([
          { id: "native-1", choices: [{ delta: { tool_calls: [{ index: 0, id: "shell-1", function: { name: "Shell", arguments: '{"command":"pwd"}' } }] } }] },
          { id: "native-1", choices: [], usage: { prompt_tokens: 8, completion_tokens: 2 } },
        ])
        : sse([
          { id: "native-2", choices: [{ delta: { content: "done" } }] },
          { id: "native-2", choices: [], usage: { prompt_tokens: 12, completion_tokens: 1 } },
        ]);
    };

    const session = loaded.createProviderPromptSession("cli-proxy");
    assert.equal(session.getModelId(), "provider/native-model");
    const executor = session.getExecutor();
    executor.appendMessages([{ role: "user", content: "inspect the workspace" }]);
    const shellParameters = {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    };
    const openRouterTools = loaded.toToolSet([{ name: "Shell", parameters: jsonSchema(shellParameters) }]);
    assert.deepEqual(openRouterTools.Shell.parameters.jsonSchema, shellParameters);
    assert.equal(Object.hasOwn(openRouterTools.Shell.parameters.jsonSchema, "jsonSchema"), false);
    const first = executor.stream({ signal: new AbortController().signal }, "invocation-1", [{ name: "Shell", parameters: jsonSchema(shellParameters) }]);
    assert.deepEqual(await collect(first.fullStream), [{ type: "tool-call", toolCallId: "shell-1", toolName: "Shell", args: { command: "pwd" } }]);
    const firstResponse = await first.response;
    executor.appendMessages(firstResponse.messages);
    executor.appendMessages([{ role: "tool", content: [{ type: "tool-result", toolCallId: "shell-1", toolName: "Shell", result: "/workspace" }] }]);

    loaded.clearCliProxyCredentialLease();
    assert.throws(
      () => executor.stream({ signal: new AbortController().signal }, "expired-step", [{ name: "Shell", parameters: { type: "object" } }]),
      /credential lease is unavailable/,
    );
    loaded.installCliProxyCredentialLease(config);
    const second = executor.stream({ signal: new AbortController().signal }, "invocation-2", [{ name: "Shell", parameters: { type: "object" } }]);
    assert.deepEqual(await collect(second.fullStream), [{ type: "text-delta", textDelta: "done" }]);
    assert.equal((await second.response).messages[0].content[0].text, "done");
    assert.deepEqual(requests[1].messages.slice(-2), [
      { role: "assistant", content: null, tool_calls: [{ id: "shell-1", type: "function", function: { name: "Shell", arguments: '{"command":"pwd"}' } }] },
      { role: "tool", tool_call_id: "shell-1", content: "/workspace" },
    ]);
    assert.deepEqual(requests[0].tools[0].function.parameters, shellParameters);
    assert.equal(Object.hasOwn(requests[0].tools[0].function.parameters, "jsonSchema"), false);
    assert.equal(JSON.stringify(requests).includes(config.apiKey), false);
    loaded.clearCliProxyCredentialLease();
  } finally {
    globalThis.fetch = priorFetch;
    if (priorDataRoot === undefined) delete process.env.SAND_DATA_ROOT;
    else process.env.SAND_DATA_ROOT = priorDataRoot;
    await rm(temporary, { recursive: true, force: true });
  }
});
