import {
  CLI_PROXY_MAX_JSON_BYTES,
  CLI_PROXY_MAX_STREAM_BYTES,
  CLI_PROXY_REQUEST_TIMEOUT_MS,
  cliProxyEndpoint,
  requireCliProxyModel,
  type CliProxyProtocol,
  type CliProxyTurnConfig,
} from "../../../shared/cli-proxy.js";

type Loose = Record<string, any>;
export type OpenAiCompatibleUsage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
export type OpenAiCompatibleTool = { name: string; description?: string; parameters: unknown; source: Loose };
export type OpenAiCompatibleEvent =
  | { type: "text-delta"; delta: string }
  | { type: "done"; text: string; responseId: string; usage: OpenAiCompatibleUsage; protocol: Exclude<CliProxyProtocol, "auto"> };

export interface OpenAiCompatibleOptions {
  readonly fetch?: typeof fetch;
  readonly config: CliProxyTurnConfig;
  readonly instructions: string;
  readonly messages: readonly { role: string; content: unknown }[];
  readonly tools?: readonly OpenAiCompatibleTool[];
  readonly executeTool?: (tool: OpenAiCompatibleTool, args: unknown, toolCallId: string) => Promise<unknown>;
  readonly maxSteps?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

function record(value: unknown): Loose | null { return typeof value === "object" && value != null && !Array.isArray(value) ? value as Loose : null; }
function safeJson(value: unknown): string {
  try { return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item) ?? "null"; }
  catch { return JSON.stringify({ isError: true, error: "Tool result was not JSON serializable." }); }
}
function zeroUsage(): OpenAiCompatibleUsage { return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }; }
function addUsage(a: OpenAiCompatibleUsage, b: OpenAiCompatibleUsage): OpenAiCompatibleUsage {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens, cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens };
}
function numeric(value: unknown): number { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0; }
function chatUsage(value: unknown): OpenAiCompatibleUsage {
  const usage = record(value) ?? {}, inputDetails = record(usage.prompt_tokens_details) ?? {};
  return { inputTokens: numeric(usage.prompt_tokens), outputTokens: numeric(usage.completion_tokens), cacheReadTokens: numeric(inputDetails.cached_tokens), cacheWriteTokens: 0 };
}
function responsesUsage(value: unknown): OpenAiCompatibleUsage {
  const usage = record(value) ?? {}, inputDetails = record(usage.input_tokens_details) ?? {};
  return { inputTokens: numeric(usage.input_tokens), outputTokens: numeric(usage.output_tokens), cacheReadTokens: numeric(inputDetails.cached_tokens), cacheWriteTokens: 0 };
}

function requestTools(tools: readonly OpenAiCompatibleTool[] | undefined, protocol: "chat-completions" | "responses"): Loose[] | undefined {
  if (tools == null || tools.length === 0) return undefined;
  const seen = new Set<string>();
  return tools.map(tool => {
    if (seen.has(tool.name)) throw new Error(`9Router MCP tools contain a duplicate name: ${tool.name}`);
    seen.add(tool.name);
    const fn = { name: tool.name, ...(tool.description == null ? {} : { description: tool.description }), parameters: tool.parameters, strict: false };
    return protocol === "chat-completions" ? { type: "function", function: fn } : { type: "function", ...fn };
  });
}

type RequestLease = { timer: ReturnType<typeof setTimeout>; controller: AbortController; timedOut: boolean; callerAborted: boolean; cleanup(): void };
const requestLeases = new WeakMap<Response, RequestLease>();

async function readWithLease(reader: ReadableStreamDefaultReader<Uint8Array>, lease: RequestLease | undefined): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (lease == null) return reader.read();
  if (lease.controller.signal.aborted) throw new Error("9Router stream aborted.");
  return await new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error("9Router stream aborted."));
    lease.controller.signal.addEventListener("abort", onAbort, { once: true });
    void reader.read().then(resolve, reject).finally(() => lease.controller.signal.removeEventListener("abort", onAbort));
  });
}

function cancellationError(options: OpenAiCompatibleOptions): Error | null {
  return options.signal?.aborted === true ? new Error("9Router request was cancelled.") : null;
}

async function boundedRequest(options: OpenAiCompatibleOptions, endpoint: "chat/completions" | "responses", body: unknown): Promise<Response> {
  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized) > CLI_PROXY_MAX_JSON_BYTES) throw new Error("9Router request is too large.");
  const controller = new AbortController();
  const lease = { timer: undefined as unknown as ReturnType<typeof setTimeout>, controller, timedOut: false, callerAborted: false, cleanup: () => {} };
  const onCallerAbort = () => { lease.callerAborted = true; controller.abort(); };
  if (options.signal?.aborted === true) throw new Error("9Router request was cancelled.");
  options.signal?.addEventListener("abort", onCallerAbort, { once: true });
  lease.timer = setTimeout(() => { lease.timedOut = true; controller.abort(); }, options.timeoutMs ?? CLI_PROXY_REQUEST_TIMEOUT_MS);
  lease.timer.unref?.();
  lease.cleanup = () => { clearTimeout(lease.timer); options.signal?.removeEventListener("abort", onCallerAbort); };
  try {
    const response = await (options.fetch ?? fetch)(cliProxyEndpoint(options.config, endpoint), {
      method: "POST",
      headers: { authorization: `Bearer ${options.config.apiKey}`, "content-type": "application/json", accept: "text/event-stream", "user-agent": "grok-bot-9router/1" },
      body: serialized,
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      try { await response.body?.cancel(); } catch {}
      lease.cleanup();
      throw new Error(`9Router ${endpoint === "responses" ? "Responses" : "Chat Completions"} request failed with HTTP ${response.status}.`);
    }
    requestLeases.set(response, lease);
    return response;
  } catch (error) {
    lease.cleanup();
    if (lease.callerAborted) throw new Error("9Router request was cancelled.");
    if (lease.timedOut) throw new Error("9Router request timed out.");
    if (error instanceof Error && error.message.startsWith("9Router ")) throw error;
    throw new Error("9Router request could not be completed.");
  }
}

async function* sse(response: Response): AsyncGenerator<Loose> {
  const lease = requestLeases.get(response);
  if (response.body == null) {
    lease?.cleanup(); requestLeases.delete(response);
    throw new Error("9Router response did not include a stream.");
  }
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "", bytes = 0;
  try {
    while (true) {
      const { done, value } = await readWithLease(reader, lease);
      if (value != null) {
        bytes += value.byteLength;
        if (bytes > CLI_PROXY_MAX_STREAM_BYTES) throw new Error("9Router response exceeded the stream size limit.");
      }
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length > CLI_PROXY_MAX_JSON_BYTES) throw new Error("9Router sent an oversized SSE event.");
      let boundary: number;
      while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const match = /\r?\n\r?\n/.exec(buffer.slice(boundary))!;
        const block = buffer.slice(0, boundary).replaceAll("\r", "");
        buffer = buffer.slice(boundary + match[0].length);
        const data = block.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (data.length === 0 || data === "[DONE]") continue;
        let parsed: unknown;
        try { parsed = JSON.parse(data); } catch { throw new Error("9Router returned malformed streaming JSON."); }
        const event = record(parsed); if (event != null) yield event;
      }
      if (done) break;
    }
    if (buffer.trim().length > 0 && buffer.trim() !== "data: [DONE]") throw new Error("9Router stream ended with an incomplete event.");
  } catch (error) {
    if (lease?.callerAborted) throw new Error("9Router request was cancelled.");
    if (lease?.timedOut) throw new Error("9Router request timed out.");
    throw error;
  } finally { lease?.cleanup(); requestLeases.delete(response); try { await reader.cancel(); } catch {} try { reader.releaseLock(); } catch {} }
}

type ToolCall = { id: string; name: string; arguments: string };
function boundedToolOutput(value: unknown): string {
  const output = safeJson(value);
  return Buffer.byteLength(output) <= CLI_PROXY_MAX_JSON_BYTES ? output : safeJson({ isError: true, error: "Tool result exceeded the size limit." });
}

async function executeCalls(calls: readonly ToolCall[], tools: readonly OpenAiCompatibleTool[] | undefined, executeTool: OpenAiCompatibleOptions["executeTool"], signal?: AbortSignal): Promise<Array<{ call: ToolCall; output: string }>> {
  if (calls.length === 0) return [];
  if (executeTool == null) throw new Error("9Router requested an MCP tool while tool routing is disabled.");
  const byName = new Map((tools ?? []).map(tool => [tool.name, tool]));
  const callIds = new Set<string>();
  const results = [];
  for (const call of calls) {
    if (signal?.aborted) throw new Error("9Router request was cancelled.");
    if (call.id.trim().length === 0 || call.name.trim().length === 0) throw new Error("9Router returned an invalid tool call.");
    if (callIds.has(call.id)) throw new Error("9Router returned duplicate tool-call identifiers.");
    callIds.add(call.id);
    const selected = byName.get(call.name);
    if (selected == null) { results.push({ call, output: safeJson({ isError: true, error: "Unknown Grok Bot tool." }) }); continue; }
    let args: unknown;
    try { args = call.arguments.length === 0 ? {} : JSON.parse(call.arguments); }
    catch { results.push({ call, output: safeJson({ isError: true, error: "Tool arguments were not valid JSON." }) }); continue; }
    try { results.push({ call, output: boundedToolOutput(await executeTool(selected, args, call.id)) }); }
    catch { results.push({ call, output: safeJson({ isError: true, error: "Tool execution failed." }) }); }
    if (signal?.aborted) throw new Error("9Router request was cancelled.");
  }
  return results;
}

async function* streamChat(options: OpenAiCompatibleOptions, irreversible: () => void): AsyncGenerator<OpenAiCompatibleEvent> {
  const model = requireCliProxyModel(options.config.model), maxSteps = options.maxSteps ?? 8;
  const declaredTools = requestTools(options.tools, "chat-completions");
  let messages: Loose[] = [{ role: "system", content: options.instructions }, ...options.messages.map(message => ({ role: message.role === "assistant" ? "assistant" : "user", content: typeof message.content === "string" ? message.content : safeJson(message.content) }))];
  let text = "", responseId = "", usage = zeroUsage();
  for (let step = 0; step < maxSteps; step += 1) {
    const response = await boundedRequest(options, "chat/completions", { model, messages, ...(declaredTools == null ? {} : { tools: declaredTools, tool_choice: "auto", parallel_tool_calls: true }), stream: true, stream_options: { include_usage: true } });
    const calls = new Map<number, ToolCall>();
    let stepUsage = zeroUsage();
    for await (const chunk of sse(response)) {
      if (chunk.error != null) throw new Error("9Router Chat Completions request failed.");
      if (typeof chunk.id === "string") responseId = chunk.id;
      const observedUsage = chatUsage(chunk.usage);
      if (observedUsage.inputTokens + observedUsage.outputTokens + observedUsage.cacheReadTokens > 0) stepUsage = observedUsage;
      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      for (const rawChoice of choices) {
        const delta = record(record(rawChoice)?.delta) ?? {};
        if (typeof delta.content === "string" && delta.content.length > 0) { irreversible(); text += delta.content; yield { type: "text-delta", delta: delta.content }; }
        const streamedToolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
        if (streamedToolCalls.length > 0) irreversible();
        for (const rawCall of streamedToolCalls) {
          const part = record(rawCall) ?? {}, index = Number.isInteger(part.index) ? part.index : calls.size, fn = record(part.function) ?? {};
          const previous = calls.get(index) ?? { id: "", name: "", arguments: "" };
          calls.set(index, { id: typeof part.id === "string" ? part.id : previous.id, name: previous.name + (typeof fn.name === "string" ? fn.name : ""), arguments: previous.arguments + (typeof fn.arguments === "string" ? fn.arguments : "") });
        }
      }
    }
    usage = addUsage(usage, stepUsage);
    const completeCalls = [...calls.values()];
    if (completeCalls.length === 0) { yield { type: "done", text, responseId, usage, protocol: "chat-completions" }; return; }
    irreversible();
    const cancelled = cancellationError(options); if (cancelled != null) throw cancelled;
    const results = await executeCalls(completeCalls, options.tools, options.executeTool, options.signal);
    messages = [...messages, { role: "assistant", content: null, tool_calls: completeCalls.map(call => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })) }, ...results.map(({ call, output }) => ({ role: "tool", tool_call_id: call.id, content: output }))];
  }
  throw new Error(`9Router exceeded Grok Bot's ${maxSteps}-step tool limit.`);
}

async function* streamResponses(options: OpenAiCompatibleOptions, irreversible: () => void): AsyncGenerator<OpenAiCompatibleEvent> {
  const model = requireCliProxyModel(options.config.model), maxSteps = options.maxSteps ?? 8;
  const declaredTools = requestTools(options.tools, "responses");
  let input: Loose[] = options.messages.map(message => ({ role: message.role === "assistant" ? "assistant" : "user", content: typeof message.content === "string" ? message.content : safeJson(message.content) }));
  let text = "", responseId = "", usage = zeroUsage();
  for (let step = 0; step < maxSteps; step += 1) {
    const response = await boundedRequest(options, "responses", { model, instructions: options.instructions, input, ...(declaredTools == null ? {} : { tools: declaredTools, tool_choice: "auto", parallel_tool_calls: true }), stream: true, store: false });
    let completed: Loose | null = null; const observed: Loose[] = [];
    for await (const event of sse(response)) {
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") { irreversible(); text += event.delta; yield { type: "text-delta", delta: event.delta }; }
      else if (event.type === "response.output_item.done") { const item = record(event.item); if (item != null) observed.push(item); }
      else if (event.type === "response.completed") completed = record(event.response);
      else if (event.type === "response.failed" || event.type === "error") throw new Error("9Router Responses request failed.");
    }
    if (completed == null) throw new Error("9Router Responses stream ended before completion.");
    if (typeof completed.id === "string") responseId = completed.id;
    usage = addUsage(usage, responsesUsage(completed.usage));
    const output = Array.isArray(completed.output) && completed.output.length > 0 ? completed.output.map(item => record(item) ?? {}) : observed;
    const calls: ToolCall[] = output.flatMap(item => item.type === "function_call" && typeof item.call_id === "string" && typeof item.name === "string" ? [{ id: item.call_id, name: item.name, arguments: typeof item.arguments === "string" ? item.arguments : "" }] : []);
    if (calls.length === 0) { yield { type: "done", text, responseId, usage, protocol: "responses" }; return; }
    irreversible();
    const cancelled = cancellationError(options); if (cancelled != null) throw cancelled;
    const results = await executeCalls(calls, options.tools, options.executeTool, options.signal);
    input = [...input, ...output, ...results.map(({ call, output: toolOutput }) => ({ type: "function_call_output", call_id: call.id, output: toolOutput }))];
  }
  throw new Error(`9Router exceeded Grok Bot's ${maxSteps}-step tool limit.`);
}

export async function* streamOpenAiCompatible(options: OpenAiCompatibleOptions): AsyncGenerator<OpenAiCompatibleEvent> {
  const configured = options.config.protocol;
  if (configured !== "auto") {
    yield* configured === "responses" ? streamResponses(options, () => {}) : streamChat(options, () => {});
    return;
  }
  let irreversible = false;
  try { yield* streamChat(options, () => { irreversible = true; }); }
  catch (error) {
    if (irreversible) throw error;
    yield* streamResponses(options, () => { irreversible = true; });
  }
}
