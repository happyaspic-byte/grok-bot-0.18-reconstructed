import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = { baseUrl: "http://127.0.0.1:20128/v1", model: "provider/model", protocol: "chat-completions", allowRemoteHttps: false, apiKey: "proxy-key" };

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-openai-compatible-"));
  const output = path.join(temporary, "stream.mjs");
  await build({ entryPoints: [path.join(repoRoot, "source/host/extensions/inference/openai-compatible-stream.ts")], outfile: output, bundle: true, format: "esm", platform: "node", target: "node22" });
  return { module: await import(`${pathToFileURL(output).href}?${Date.now()}`), dispose: () => rm(temporary, { recursive: true, force: true }) };
}

function sse(events, split = 13) {
  const bytes = new TextEncoder().encode(`${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`);
  return new Response(new ReadableStream({ start(controller) { for (let offset = 0; offset < bytes.length; offset += split) controller.enqueue(bytes.slice(offset, offset + split)); controller.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function sseWithoutDone(events, split = 13) {
  const bytes = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
  return new Response(new ReadableStream({ start(controller) { for (let offset = 0; offset < bytes.length; offset += split) controller.enqueue(bytes.slice(offset, offset + split)); controller.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function collect(stream) { const events = []; for await (const event of stream) events.push(event); return events; }

test("Chat Completions streams text with bounded authenticated request options", async () => {
  const loaded = await loadModule();
  try {
    const requests = [];
    const events = await collect(loaded.module.streamOpenAiCompatible({
      config,
      instructions: "Grok",
      messages: [{ role: "user", content: "hi" }],
      fetch: async (url, init) => {
        requests.push({ url, init, body: JSON.parse(init.body) });
        return sse([
          { id: "chat-1", choices: [{ delta: { content: "hello" } }] },
          { id: "chat-1", choices: [], usage: { prompt_tokens: 4, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 2 } } },
        ]);
      },
    }));
    assert.deepEqual(events, [
      { type: "text-delta", delta: "hello" },
      { type: "done", text: "hello", responseId: "chat-1", usage: { inputTokens: 4, outputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 0 }, protocol: "chat-completions" },
    ]);
    assert.equal(requests[0].url, "http://127.0.0.1:20128/v1/chat/completions");
    assert.equal(requests[0].init.redirect, "error");
    assert.equal(requests[0].init.headers.authorization, "Bearer proxy-key");
    assert.equal(requests[0].body.stream, true);
  } finally { await loaded.dispose(); }
});

test("Chat Completions rejects boundary-aligned truncation and accepts a terminal finish_reason", async () => {
  const loaded = await loadModule();
  try {
    const finishReasonEvents = await collect(loaded.module.streamOpenAiCompatible({
      config,
      instructions: "Grok",
      messages: [{ role: "user", content: "hi" }],
      fetch: async () => sseWithoutDone([
        { id: "chat-finish", choices: [{ delta: { content: "complete" } }] },
        { id: "chat-finish", choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
    }));
    assert.equal(finishReasonEvents.at(-1).type, "done");
    assert.equal(finishReasonEvents.at(-1).text, "complete");

    await assert.rejects(async () => collect(loaded.module.streamOpenAiCompatible({
      config,
      instructions: "Grok",
      messages: [{ role: "user", content: "hi" }],
      fetch: async () => sseWithoutDone([
        { id: "chat-truncated", choices: [{ delta: { content: "partial" } }] },
      ]),
    })), /stream ended before completion/);

    const nativeEvents = [];
    await assert.rejects(async () => {
      for await (const event of loaded.module.streamOpenAiCompatibleModelStep({
        config,
        instructions: "Grok native tools",
        messages: [{ role: "user", content: "use a tool" }],
        tools: [{ name: "Read", parameters: { type: "object" }, source: {} }],
        fetch: async () => sseWithoutDone([
          { id: "chat-native-truncated", choices: [{ delta: { tool_calls: [{ index: 0, id: "call-truncated", function: { name: "Read", arguments: '{"path":"README.md"}' } }] } }] },
        ]),
      })) nativeEvents.push(event);
    }, /stream ended before completion/);
    assert.deepEqual(nativeEvents, []);
  } finally { await loaded.dispose(); }
});

test("Responses streaming is explicit and auto fallback happens only before output or tools", async () => {
  const loaded = await loadModule();
  try {
    let calls = 0;
    const autoEvents = await collect(loaded.module.streamOpenAiCompatible({
      config: { ...config, protocol: "auto" }, instructions: "Grok", messages: [{ role: "user", content: "hi" }],
      fetch: async (_url, _init) => {
        calls += 1;
        if (calls === 1) return new Response("sensitive upstream body", { status: 400 });
        return sse([{ type: "response.output_text.delta", delta: "fallback" }, { type: "response.completed", response: { id: "resp-1", output: [], usage: { input_tokens: 3, output_tokens: 1 } } }]);
      },
    }));
    assert.equal(calls, 2);
    assert.equal(autoEvents.at(-1).protocol, "responses");

    calls = 0;
    await assert.rejects(async () => collect(loaded.module.streamOpenAiCompatible({
      config: { ...config, protocol: "auto" }, instructions: "Grok", messages: [{ role: "user", content: "hi" }],
      fetch: async () => { calls += 1; return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"visible"}}]}\n\n')); controller.enqueue(new TextEncoder().encode("data: broken\n\n")); controller.close(); } }), { status: 200 }); },
    })), /malformed streaming JSON/);
    assert.equal(calls, 1);

    calls = 0;
    await assert.rejects(async () => collect(loaded.module.streamOpenAiCompatible({
      config: { ...config, protocol: "auto" }, instructions: "Grok", messages: [{ role: "user", content: "tool" }],
      tools: [{ name: "effect", parameters: {}, source: {} }], executeTool: async () => ({ ok: true }),
      fetch: async () => { calls += 1; return new Response('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"effect","arguments":"{}"}}]}}]}\n\ndata: broken\n\n', { status: 200 }); },
    })), /malformed streaming JSON/);
    assert.equal(calls, 1);
  } finally { await loaded.dispose(); }
});

test("stalled streams time out even when a fetch mock ignores its AbortSignal", async () => {
  const loaded = await loadModule();
  try {
    await assert.rejects(async () => collect(loaded.module.streamOpenAiCompatible({
      config, instructions: "Grok", messages: [{ role: "user", content: "hi" }], timeoutMs: 20,
      fetch: async () => new Response(new ReadableStream({ start() {} }), { status: 200 }),
    })), /timed out/);
  } finally { await loaded.dispose(); }
});

test("caller cancellation stops later MCP tool effects", async () => {
  const loaded = await loadModule();
  try {
    const abort = new AbortController(); let toolCalls = 0;
    const toolChunks = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "first", arguments: "{}" } }, { index: 1, id: "call-2", function: { name: "second", arguments: "{}" } }] } }] },
    ];
    await assert.rejects(async () => collect(loaded.module.streamOpenAiCompatible({
      config, instructions: "Grok", messages: [{ role: "user", content: "tools" }], signal: abort.signal,
      tools: [{ name: "first", parameters: { type: "object" }, source: {} }, { name: "second", parameters: { type: "object" }, source: {} }],
      fetch: async () => sse(toolChunks),
      executeTool: async () => { toolCalls += 1; abort.abort(); return { ok: true }; },
    })), /cancelled/);
    assert.equal(toolCalls, 1);
  } finally { await loaded.dispose(); }
});

test("tool definitions fail closed on duplicate names and error bodies are redacted", async () => {
  const loaded = await loadModule();
  try {
    await assert.rejects(async () => collect(loaded.module.streamOpenAiCompatible({
      config, instructions: "Grok", messages: [{ role: "user", content: "tools" }],
      tools: [{ name: "same", parameters: {}, source: {} }, { name: "same", parameters: {}, source: {} }], fetch: async () => { throw new Error("must not fetch"); },
    })), /duplicate name/);
    await assert.rejects(async () => collect(loaded.module.streamOpenAiCompatible({
      config, instructions: "Grok", messages: [{ role: "user", content: "hi" }], fetch: async () => new Response("Bearer proxy-key internal-stack", { status: 500 }),
    })), (error) => !error.message.includes("proxy-key") && !error.message.includes("internal-stack") && /HTTP 500/.test(error.message));
  } finally { await loaded.dispose(); }
});

test("native agent model steps emit tool calls and replay reviewed tool results", async () => {
  const loaded = await loadModule();
  try {
    const requests = [];
    const events = await collect(loaded.module.streamOpenAiCompatibleModelStep({
      config,
      instructions: "Grok native tools",
      messages: [
        { role: "assistant", content: [{ type: "tool-call", toolCallId: "prior-1", toolName: "Shell", args: { command: "pwd" } }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "prior-1", toolName: "Shell", result: "/workspace", experimental_content: [{ type: "text", text: "/workspace" }, { type: "text", text: "<system_reminder>Finish with SendMessage.</system_reminder>" }, { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }] }] },
        { role: "assistant", content: [{ type: "tool-call", toolCallId: "prior_Abc1234", toolName: "Read", args: { path: "README.md" } }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "prior_Abc1234", toolName: "Read", result: "README text\n<tool_call_id>Abc1234</tool_call_id>", experimental_content: [{ type: "text", text: "README text" }, { type: "text", text: "<system_reminder>Return to the parent.</system_reminder>\n<tool_call_id>Abc1234</tool_call_id>" }] }] },
        { role: "user", content: "continue" },
      ],
      tools: [{ name: "Read", description: "Read a file", parameters: { type: "object" }, source: {} }],
      fetch: async (url, init) => {
        requests.push({ url, init, body: JSON.parse(init.body) });
        return sse([
          { id: "chat-native", choices: [{ delta: { tool_calls: [{ index: 0, id: "call-2", function: { name: "Read", arguments: '{"path":' } }] } }] },
          { id: "chat-native", choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }] } }] },
          { id: "chat-native", choices: [], usage: { prompt_tokens: 20, completion_tokens: 4 } },
        ]);
      },
    }));
    assert.deepEqual(events, [
      { type: "tool-call", toolCallId: "call-2", toolName: "Read", args: { path: "README.md" } },
      {
        type: "done",
        responseId: "chat-native",
        usage: { inputTokens: 20, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 },
        content: [{ type: "tool-call", toolCallId: "call-2", toolName: "Read", args: { path: "README.md" } }],
        protocol: "chat-completions",
      },
    ]);
    assert.equal(requests[0].url, "http://127.0.0.1:20128/v1/chat/completions");
    assert.deepEqual(requests[0].body.messages.slice(1), [
      { role: "assistant", content: null, tool_calls: [{ id: "prior-1", type: "function", function: { name: "Shell", arguments: '{"command":"pwd"}' } }] },
      { role: "tool", tool_call_id: "prior-1", content: "/workspace\n<system_reminder>Finish with SendMessage.</system_reminder>" },
      { role: "user", content: [{ type: "text", text: "Visual output returned by the preceding Grok Bot tool call." }, { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } }] },
      { role: "assistant", content: null, tool_calls: [{ id: "prior_Abc1234", type: "function", function: { name: "Read", arguments: '{"path":"README.md"}' } }] },
      { role: "tool", tool_call_id: "prior_Abc1234", content: "README text\n<system_reminder>Return to the parent.</system_reminder>\n<tool_call_id>Abc1234</tool_call_id>" },
      { role: "user", content: "continue" },
    ]);
    assert.equal(requests[0].body.tools[0].function.name, "Read");
    assert.equal(requests[0].init.headers.authorization, "Bearer proxy-key");
  } finally { await loaded.dispose(); }
});

test("native agent model steps fail closed for unverified Responses mode", async () => {
  const loaded = await loadModule();
  try {
    let fetched = false;
    await assert.rejects(async () => collect(loaded.module.streamOpenAiCompatibleModelStep({
      config: { ...config, protocol: "responses" },
      instructions: "Grok native tools",
      messages: [{ role: "user", content: "hi" }],
      fetch: async () => { fetched = true; throw new Error("must not fetch"); },
    })), /Responses mode is not available/);
    assert.equal(fetched, false);
  } finally { await loaded.dispose(); }
});
