import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

import {
  CLI_PROXY_DEFAULT_CONFIG,
  normalizeCliProxyPublicConfig,
  normalizeCliProxyApiKey,
  normalizeCliProxySaveRequest,
  requireCliProxyModel,
  type CliProxyPublicConfig,
  type CliProxyStatus,
  type CliProxyTurnConfig,
} from "../../shared/cli-proxy.js";
import { hardenWindowsPrivatePath } from "../../shared/node/windows-private-path.js";

export const CLI_PROXY_SECRET_FILENAME = "cli-proxy-provider.json";

interface CliProxySafeStorage {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

interface CliProxyStoreRuntime {
  readonly app: { getPath(name: "userData"): string };
  readonly safeStorage: CliProxySafeStorage;
}

interface PersistedDocument {
  readonly schemaVersion: 1;
  readonly config: CliProxyPublicConfig;
  /** A single fixed-purpose ciphertext. This is deliberately not a general secret map. */
  readonly apiKeyCiphertext?: string;
}

type CliProxyPrivatePathHardener = (target: string) => Promise<unknown>;

async function defaultPrivatePathHardener(target: string): Promise<void> {
  if (process.platform === "win32") await hardenWindowsPrivatePath(target);
}

function electronRuntime(): CliProxyStoreRuntime {
  return require("electron") as CliProxyStoreRuntime;
}

function defaultPath(): string {
  return join(electronRuntime().app.getPath("userData"), CLI_PROXY_SECRET_FILENAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function hasSameOrigin(left: CliProxyPublicConfig, right: CliProxyPublicConfig): boolean {
  return new URL(left.baseUrl).origin === new URL(right.baseUrl).origin;
}

function parseDocument(value: unknown): PersistedDocument | null {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.config)) return null;
  try {
    const config = normalizeCliProxyPublicConfig(value.config);
    const ciphertext = value.apiKeyCiphertext;
    if (ciphertext !== undefined && (typeof ciphertext !== "string" || ciphertext.length === 0 || ciphertext.length > 32_768)) return null;
    return { schemaVersion: 1, config, ...(typeof ciphertext === "string" ? { apiKeyCiphertext: ciphertext } : {}) };
  } catch { return null; }
}

export class SandCliProxySecretStore {
  private diskCache: PersistedDocument | null | undefined;
  private sessionConfig: CliProxyPublicConfig | null = null;
  private sessionApiKey: string | null = null;
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly storePath = defaultPath(),
    private readonly safeStorage: CliProxySafeStorage = electronRuntime().safeStorage,
    private readonly hardenPrivatePath: CliProxyPrivatePathHardener = defaultPrivatePathHardener,
  ) {}

  isPersistent(): boolean {
    try { return this.safeStorage.isEncryptionAvailable(); }
    catch { return false; }
  }

  async status(): Promise<CliProxyStatus> {
    if (this.sessionConfig != null) {
      return { ...this.sessionConfig, configured: this.sessionApiKey != null, isPersistent: false };
    }
    if (!this.isPersistent()) {
      return { ...CLI_PROXY_DEFAULT_CONFIG, configured: false, isPersistent: false };
    }
    const document = await this.loadDisk();
    return {
      ...(document?.config ?? CLI_PROXY_DEFAULT_CONFIG),
      configured: document?.apiKeyCiphertext != null,
      isPersistent: true,
    };
  }

  async save(raw: unknown): Promise<CliProxyStatus> {
    return this.enqueue(async () => this.saveNow(raw));
  }

  private async saveNow(raw: unknown): Promise<CliProxyStatus> {
    const { apiKey: suppliedKey, ...config } = normalizeCliProxySaveRequest(raw);
    if (!this.isPersistent()) {
      await this.discardPersistedDocument();
      const mayReuseSessionKey = this.sessionConfig != null && hasSameOrigin(this.sessionConfig, config);
      this.sessionConfig = config;
      if (suppliedKey !== undefined) this.sessionApiKey = suppliedKey;
      else if (!mayReuseSessionKey) this.sessionApiKey = null;
      return this.status();
    }
    const previous = await this.loadDisk();
    const mayReuseSessionKey = this.sessionConfig != null && hasSameOrigin(this.sessionConfig, config);
    const keyToEncrypt = suppliedKey ?? (mayReuseSessionKey ? this.sessionApiKey ?? undefined : undefined);
    let apiKeyCiphertext: string | undefined;
    try {
      const mayReusePersistedKey = previous != null && hasSameOrigin(previous.config, config);
      apiKeyCiphertext = keyToEncrypt === undefined
        ? mayReusePersistedKey ? previous?.apiKeyCiphertext : undefined
        : this.safeStorage.encryptString(keyToEncrypt).toString("base64");
    } catch {
      await this.discardPersistedDocument();
      this.sessionConfig = config;
      this.sessionApiKey = keyToEncrypt ?? null;
      return this.status();
    }
    const document: PersistedDocument = { schemaVersion: 1, config, ...(apiKeyCiphertext == null ? {} : { apiKeyCiphertext }) };
    await this.persist(document);
    this.diskCache = document;
    this.sessionConfig = null;
    this.sessionApiKey = null;
    return this.status();
  }

  async remove(): Promise<CliProxyStatus> {
    return this.enqueue(async () => this.removeNow());
  }

  private async removeNow(): Promise<CliProxyStatus> {
    this.diskCache = null;
    this.sessionConfig = null;
    this.sessionApiKey = null;
    await fs.rm(this.storePath, { force: true });
    return this.status();
  }

  /** Main-process-only, per-turn lease. Never expose this result on renderer IPC. */
  async getTurnConfig(): Promise<CliProxyTurnConfig> {
    const connection = await this.getConnectionConfig();
    return { ...connection, model: requireCliProxyModel(connection.model) };
  }

  /** Main-process-only connection lease used by the bounded /v1/models probe. */
  async getConnectionConfig(): Promise<CliProxyTurnConfig> {
    if (this.sessionConfig != null) {
      if (this.sessionApiKey == null) throw new Error("9Router is not configured. Open Settings → Router.");
      return { ...this.sessionConfig, apiKey: this.sessionApiKey };
    }
    if (!this.isPersistent()) {
      throw new Error("9Router is not configured. Open Settings → Router.");
    }
    const document = await this.loadDisk();
    if (document?.apiKeyCiphertext == null) throw new Error("9Router is not configured. Open Settings → Router.");
    let apiKey: string;
    try { apiKey = normalizeCliProxyApiKey(this.safeStorage.decryptString(Buffer.from(document.apiKeyCiphertext, "base64"))); }
    catch { throw new Error("9Router credential is unavailable. Save the API key again in Settings → Router."); }
    return { ...document.config, apiKey };
  }

  private async loadDisk(): Promise<PersistedDocument | null> {
    if (this.diskCache !== undefined) return this.diskCache;
    try { this.diskCache = parseDocument(JSON.parse(await fs.readFile(this.storePath, "utf8"))); }
    catch { this.diskCache = null; }
    return this.diskCache;
  }

  private async discardPersistedDocument(): Promise<void> {
    try { await fs.rm(this.storePath, { force: true }); }
    catch {
      this.sessionConfig = null;
      this.sessionApiKey = null;
      throw new Error("Unable to remove the previous 9Router credential; the new session credential was not activated.");
    }
    this.diskCache = null;
  }

  private async persist(document: PersistedDocument): Promise<void> {
    await fs.mkdir(dirname(this.storePath), { recursive: true });
    const temporary = `${this.storePath}.${process.pid}.${randomUUID()}.tmp`;
    const backup = `${this.storePath}.${process.pid}.${randomUUID()}.bak`;
    let backupHoldsOldFile = false;
    await fs.writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      // Windows ignores POSIX mode bits. Secure and verify the uniquely named
      // file before its same-directory rename publishes the credential.
      await this.hardenPrivatePath(temporary);
      try { await fs.rename(temporary, this.storePath); }
      catch (error) {
        const code = typeof error === "object" && error != null && "code" in error ? String(error.code) : "";
        if (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES") throw error;
        await fs.rename(this.storePath, backup);
        backupHoldsOldFile = true;
        try { await fs.rename(temporary, this.storePath); }
        catch (replaceError) {
          try { await fs.rename(backup, this.storePath); backupHoldsOldFile = false; }
          catch {}
          throw replaceError;
        }
        await fs.rm(backup, { force: true });
        backupHoldsOldFile = false;
      }
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      if (!backupHoldsOldFile) await fs.rm(backup, { force: true }).catch(() => undefined);
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes.then(operation, operation);
    this.writes = result.then(() => undefined, () => undefined);
    return result;
  }
}
