export const CLI_PROXY_DEFAULT_BASE_URL = "http://127.0.0.1:20128/v1";
export const CLI_PROXY_DEFAULT_MODEL = "";
export const CLI_PROXY_MAX_BASE_URL_LENGTH = 2_048;
export const CLI_PROXY_MAX_MODEL_LENGTH = 256;
export const CLI_PROXY_MAX_API_KEY_LENGTH = 8_192;
export const CLI_PROXY_MAX_MODELS = 500;
export const CLI_PROXY_MAX_JSON_BYTES = 2 * 1024 * 1024;
export const CLI_PROXY_MAX_STREAM_BYTES = 32 * 1024 * 1024;
export const CLI_PROXY_REQUEST_TIMEOUT_MS = 120_000;

export const CLI_PROXY_PROTOCOLS = ["auto", "chat-completions", "responses"] as const;
export type CliProxyProtocol = (typeof CLI_PROXY_PROTOCOLS)[number];

export interface CliProxyPublicConfig {
  readonly baseUrl: string;
  readonly model: string;
  readonly protocol: CliProxyProtocol;
  readonly allowRemoteHttps: boolean;
  readonly allowTailscaleHttp: boolean;
}

export interface CliProxyTurnConfig extends CliProxyPublicConfig {
  readonly apiKey: string;
}

export interface CliProxySaveRequest extends CliProxyPublicConfig {
  readonly apiKey?: string;
}

export interface CliProxyStatus extends CliProxyPublicConfig {
  readonly configured: boolean;
  readonly isPersistent: boolean;
  readonly probe?: {
    readonly outcome: "ok" | "empty";
    readonly models: readonly string[];
    readonly latencyMs: number;
    readonly message: string;
  };
}

export const CLI_PROXY_DEFAULT_CONFIG: CliProxyPublicConfig = {
  baseUrl: CLI_PROXY_DEFAULT_BASE_URL,
  model: CLI_PROXY_DEFAULT_MODEL,
  protocol: "chat-completions",
  allowRemoteHttps: false,
  allowTailscaleHttp: false,
};

function rawUrlHostname(value: string): string | null {
  const authority = /^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i.exec(value)?.[1];
  if (authority == null || authority.includes("@")) return null;
  if (authority.startsWith("[")) {
    const closingBracket = authority.indexOf("]");
    if (closingBracket < 0 || (authority.length > closingBracket + 1 && authority[closingBracket + 1] !== ":")) return null;
    return authority.slice(0, closingBracket + 1);
  }
  const colon = authority.lastIndexOf(":");
  return colon < 0 ? authority : authority.slice(0, colon);
}

function parseStrictIpv4(value: string): readonly number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^(?:0|[1-9]\d{0,2})$/.test(part))) return null;
  const octets = parts.map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

function parseStrictIpv6(value: string): readonly number[] | null {
  const literal = value.toLowerCase().replace(/^\[|\]$/g, "");
  if (literal.includes(".") || literal.includes("%") || !/^[0-9a-f:]+$/.test(literal)) return null;
  const halves = literal.split("::");
  if (halves.length > 2) return null;
  const [leftSource = "", rightSource = ""] = halves;
  const left = leftSource.length === 0 ? [] : leftSource.split(":");
  const right = halves.length === 1 || rightSource.length === 0 ? [] : rightSource.split(":");
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  if (halves.length === 1 ? left.length !== 8 : left.length + right.length >= 8) return null;
  const zeroCount = 8 - left.length - right.length;
  return [...left.map((part) => Number.parseInt(part, 16)), ...Array(zeroCount).fill(0), ...right.map((part) => Number.parseInt(part, 16))];
}

function isTailscaleIpLiteral(value: string, hostname: string): boolean {
  const rawHostname = rawUrlHostname(value);
  if (rawHostname == null) return false;
  const ipv4 = parseStrictIpv4(rawHostname);
  if (ipv4 != null) {
    const [first = -1, second = -1] = ipv4;
    return rawHostname === hostname && first === 100 && second >= 64 && second <= 127;
  }
  if (!rawHostname.startsWith("[") || !rawHostname.endsWith("]")) return false;
  const ipv6 = parseStrictIpv6(rawHostname);
  if (ipv6 == null) return false;
  const [first = -1, second = -1, third = -1] = ipv6;
  return first === 0xfd7a && second === 0x115c && third === 0xa1e0;
}

function isLoopbackIpLiteral(value: string, hostname: string): boolean {
  const rawHostname = rawUrlHostname(value);
  if (rawHostname == null) return false;
  const ipv4 = parseStrictIpv4(rawHostname);
  if (ipv4 != null) return rawHostname === hostname && ipv4[0] === 127;
  if (!rawHostname.startsWith("[") || !rawHostname.endsWith("]")) return false;
  const ipv6 = parseStrictIpv6(rawHostname);
  return ipv6 != null && ipv6.slice(0, 7).every((part) => part === 0) && ipv6[7] === 1;
}

export function normalizeCliProxyBaseUrl(raw: unknown, allowRemoteHttps: boolean, allowTailscaleHttp = false): string {
  if (typeof raw !== "string") throw new Error("9Router Base URL must be a string.");
  const value = raw.trim();
  if (value.length === 0 || value.length > CLI_PROXY_MAX_BASE_URL_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("9Router Base URL is empty, too long, or contains control characters.");
  }
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new Error("9Router Base URL is not a valid URL."); }
  if (parsed.username.length > 0 || parsed.password.length > 0 || parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new Error("9Router Base URL cannot contain credentials, a query, or a fragment.");
  }
  if (parsed.hostname.toLowerCase() === "host.docker.internal") {
    throw new Error("host.docker.internal is not allowed as a 9Router endpoint.");
  }
  // Hostnames are intentionally excluded, even `localhost`: a privileged process
  // in the container can rewrite resolver state between validation and connect.
  const loopback = isLoopbackIpLiteral(value, parsed.hostname);
  if (parsed.protocol === "http:") {
    const tailscale = allowTailscaleHttp && isTailscaleIpLiteral(value, parsed.hostname);
    if (!loopback && !tailscale) {
      throw new Error("Plain HTTP is allowed only for loopback, or a literal Tailscale IP with the explicit Tailscale opt-in.");
    }
    if (tailscale && parsed.port !== "20128") {
      throw new Error("Tailscale HTTP is restricted to the 9Router port 20128.");
    }
  } else if (parsed.protocol === "https:") {
    if (!loopback && !allowRemoteHttps) throw new Error("Remote HTTPS requires the explicit remote-endpoint opt-in.");
  } else {
    throw new Error("9Router Base URL must use HTTP or HTTPS.");
  }
  const pathname = parsed.pathname.replace(/\/+$/, "") || "/v1";
  if (pathname !== "/v1") {
    throw new Error("9Router Base URL must use the exact /v1 API root; /codex and endpoint-specific paths are not allowed.");
  }
  parsed.pathname = pathname;
  return parsed.toString().replace(/\/$/, "");
}

export function normalizeCliProxyPublicConfig(raw: unknown): CliProxyPublicConfig {
  const record = typeof raw === "object" && raw != null && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const allowRemoteHttps = record.allowRemoteHttps === true;
  const allowTailscaleHttp = record.allowTailscaleHttp === true;
  const model = typeof record.model === "string" ? record.model.trim() : "";
  if (model.length > CLI_PROXY_MAX_MODEL_LENGTH || /[\u0000-\u001f\u007f]/.test(model)) {
    throw new Error("9Router model must be at most 256 characters without control characters.");
  }
  const protocol = record.protocol;
  if (typeof protocol !== "string" || !(CLI_PROXY_PROTOCOLS as readonly string[]).includes(protocol)) {
    throw new Error("Unknown 9Router API protocol.");
  }
  return {
    baseUrl: normalizeCliProxyBaseUrl(record.baseUrl, allowRemoteHttps, allowTailscaleHttp),
    model,
    protocol: protocol as CliProxyProtocol,
    allowRemoteHttps,
    allowTailscaleHttp,
  };
}

export function requireCliProxyModel(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("Choose a 9Router model in Settings → Router.");
  const value = raw.trim();
  if (value.length === 0 || value.length > CLI_PROXY_MAX_MODEL_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Choose a valid 9Router model in Settings → Router.");
  }
  return value;
}

export function normalizeCliProxyApiKey(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("9Router API key must be a string.");
  const value = raw.trim();
  if (value.length === 0 || value.length > CLI_PROXY_MAX_API_KEY_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("9Router API key is empty, too long, or contains control characters.");
  }
  return value;
}

/**
 * Pure validation for a renderer save request. Callers may run this before any
 * credential-revocation fence so malformed input cannot disrupt an active turn.
 */
export function normalizeCliProxySaveRequest(raw: unknown): CliProxySaveRequest {
  const record = typeof raw === "object" && raw != null && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const config = normalizeCliProxyPublicConfig(record);
  return {
    ...config,
    ...(record.apiKey === undefined ? {} : { apiKey: normalizeCliProxyApiKey(record.apiKey) }),
  };
}

export function normalizeCliProxyTurnConfig(raw: unknown): CliProxyTurnConfig {
  const record = typeof raw === "object" && raw != null && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const config = normalizeCliProxyPublicConfig(record);
  return { ...config, model: requireCliProxyModel(config.model), apiKey: normalizeCliProxyApiKey(record.apiKey) };
}

export function cliProxyEndpoint(config: CliProxyPublicConfig, endpoint: "chat/completions" | "responses" | "models"): string {
  const base = normalizeCliProxyBaseUrl(config.baseUrl, config.allowRemoteHttps, config.allowTailscaleHttp);
  return `${base}/${endpoint}`;
}
