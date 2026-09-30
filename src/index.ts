/** JSON values, not a schema for Caddy's extensible configuration. */
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };
/** Each item is one config key or array index. [] selects the config root. */
export type ConfigPath = readonly (string | number)[];
export type Fetch = typeof globalThis.fetch;
export type HeadersInput = NonNullable<ConstructorParameters<typeof Headers>[0]>;

export interface ClientOptions {
  /** Defaults to http://localhost:2019. A trusted reverse-proxy path prefix is allowed. */
  baseUrl?: string | URL;
  /** A positive integer, in milliseconds. Defaults to 10_000. */
  timeoutMs?: number;
  /** Optional headers for a trusted, authenticated admin proxy. Never logged by this library. */
  headers?: HeadersInput;
  /** Must honor RequestInit, including redirect: "error" and AbortSignal. */
  fetch?: Fetch;
}
export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface MutationOptions extends RequestOptions {
  /** Replay a getConfig() ETag verbatim; Caddy reports conflicts with HTTP 412. */
  ifMatch?: string;
}
export interface LoadOptions extends RequestOptions {
  /** Send Cache-Control: must-revalidate even when the config has not changed. */
  forceReload?: boolean;
}
export interface TextLoadOptions extends LoadOptions {
  /** An adapter's media type, for example text/caddyfile. */
  contentType: string;
}
export interface AdaptOptions extends RequestOptions {
  /** Defaults to text/caddyfile. The adapter must be installed in the server. */
  contentType?: string;
}
export interface ConfigResponse<T = JsonValue> {
  config: T;
  etag: string | null;
}
export interface AdaptWarning {
  file?: string;
  line?: number;
  directive?: string;
  message?: string;
}
export interface LoadResult {
  warnings: AdaptWarning[];
}
export interface AdaptResult<T = JsonValue> extends LoadResult {
  result: T;
}

/** HTTP failures deliberately omit server bodies, URLs, headers and credentials. */
export class CaddyHttpError extends Error {
  readonly status: number;
  readonly method: string;
  constructor(status: number, method: string) {
    super(`Caddy admin API returned HTTP ${status} for ${method}`);
    this.name = "CaddyHttpError";
    this.status = status;
    this.method = method;
  }
}
export type RequestErrorCode = "timeout" | "aborted" | "network" | "invalid-response";
/** Transport and protocol failures omit underlying errors, which can contain secrets. */
export class CaddyRequestError extends Error {
  readonly code: RequestErrorCode;
  constructor(code: RequestErrorCode) {
    super({
      timeout: "Caddy admin API request timed out; a mutation may already have applied",
      aborted: "Caddy admin API request was aborted; a mutation may already have applied",
      network: "Caddy admin API request failed; a mutation may already have applied",
      "invalid-response": "Caddy admin API returned an unexpected response",
    }[code]);
    this.name = "CaddyRequestError";
    this.code = code;
  }
}

function timeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new TypeError("timeoutMs must be a positive integer no larger than 2147483647");
  }
  return value;
}
function baseUrl(input: string | URL): string {
  let url: URL;
  try { url = new URL(input); } catch { throw new TypeError("baseUrl must be an absolute HTTP(S) URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new TypeError("baseUrl must be HTTP(S) without credentials, a query, or a fragment");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}
function configEndpoint(path: ConfigPath): string {
  if (!Array.isArray(path)) throw new TypeError("A config path must be an array of keys or indexes");
  const segments = path.map((value) => {
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Config indexes must be nonnegative safe integers");
      return String(value);
    }
    // Caddy decodes paths before splitting them; encoded slashes are not literal keys.
    if (typeof value !== "string" || !value || value === "." || value === ".." || /[/\\%\u0000-\u001f\u007f]/u.test(value)) {
      throw new TypeError("Config keys must be nonempty and cannot contain dot segments, slashes, percent signs, or control characters");
    }
    try { return encodeURIComponent(value); } catch { throw new TypeError("Config keys must contain valid Unicode"); }
  });
  return `config/${segments.join("/")}`;
}
function json(value: JsonValue): string {
  // Serialize an inert copy: accessors and toJSON hooks must not alter a checked config.
  const ancestors = new Set<object>();
  const clone = (item: unknown): JsonValue => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item !== "object" || item === null || ancestors.has(item)) throw new Error();
    const array = Array.isArray(item);
    if (!array && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error();
    ancestors.add(item);
    const read = (key: string): JsonValue => {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !("value" in descriptor)) throw new Error();
      return clone(descriptor.value);
    };
    let result: JsonValue;
    if (array) {
      result = Array.from({ length: item.length }, (_, i) => read(String(i)));
    } else {
      const object: JsonObject = Object.create(null) as JsonObject;
      for (const key of Object.keys(item)) object[key] = read(key);
      result = object;
    }
    ancestors.delete(item);
    return result;
  };
  try { return JSON.stringify(clone(value)); }
  catch { throw new TypeError("Config values must be acyclic, plain JSON data without accessors"); }
}
function makeHeaders(input?: HeadersInput): Headers {
  try { return new Headers(input); }
  catch { throw new TypeError("Invalid request headers"); }
}
function setHeader(headers: Headers, name: string, value: string): void {
  try { headers.set(name, value); }
  catch { throw new TypeError("Invalid request header value"); }
}
function warnings(value: unknown): AdaptWarning[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => !isObject(item) ||
    ["file", "directive", "message"].some((key) => item[key] !== undefined && typeof item[key] !== "string") ||
    (item.line !== undefined && typeof item.line !== "number"))) throw new CaddyRequestError("invalid-response");
  return value as AdaptWarning[];
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A server-side HTTP client. It neither starts nor exposes a Caddy admin server. */
export class CaddyClient {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #headers: Headers;
  readonly #fetch: Fetch;
  constructor(options: ClientOptions = {}) {
    this.#baseUrl = baseUrl(options.baseUrl ?? "http://localhost:2019");
    this.#timeoutMs = timeout(options.timeoutMs ?? 10_000);
    this.#headers = makeHeaders(options.headers);
    // Node fetch sends Sec-Fetch-Mode, so Caddy correctly also requires an Origin.
    if (!this.#headers.has("Origin")) this.#headers.set("Origin", new URL(this.#baseUrl).origin);
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** T is a caller assertion, not runtime schema validation. */
  async getConfig<T = JsonValue>(path: ConfigPath = [], options: RequestOptions = {}): Promise<ConfigResponse<T>> {
    const { value, etag } = await this.#request("GET", configEndpoint(path), undefined, options, undefined, true);
    return { config: value as T, etag };
  }
  /** POST creates/replaces object values, or appends to an existing array. */
  async postConfig(path: ConfigPath, value: JsonValue, options: MutationOptions = {}): Promise<void> {
    await this.#write("POST", path, value, options);
  }
  /** PUT strictly creates an object value, or inserts at an array index. */
  async putConfig(path: ConfigPath, value: JsonValue, options: MutationOptions = {}): Promise<void> {
    await this.#write("PUT", path, value, options);
  }
  /** PATCH strictly replaces an existing object value or array element. */
  async patchConfig(path: ConfigPath, value: JsonValue, options: MutationOptions = {}): Promise<void> {
    await this.#write("PATCH", path, value, options);
  }
  /** [] unloads the entire active config. It does not exit the Caddy process. */
  async deleteConfig(path: ConfigPath, options: MutationOptions = {}): Promise<void> {
    await this.#write("DELETE", path, undefined, options);
  }
  async #write(method: string, path: ConfigPath, value: JsonValue | undefined, options: MutationOptions): Promise<void> {
    const headers = makeHeaders();
    if (options.ifMatch !== undefined) setHeader(headers, "If-Match", options.ifMatch);
    if (value !== undefined) headers.set("Content-Type", "application/json");
    await this.#request(method, configEndpoint(path), method === "DELETE" ? undefined : json(value as JsonValue), options, headers);
  }

  /** Replaces and runs the entire config. This is a mutation, never a dry run. */
  load(config: JsonObject, options?: LoadOptions): Promise<LoadResult>;
  load(config: string, options: TextLoadOptions): Promise<LoadResult>;
  async load(config: JsonObject | string, options: LoadOptions | TextLoadOptions = {}): Promise<LoadResult> {
    const headers = makeHeaders();
    let body: string;
    if (typeof config === "string") {
      if (!("contentType" in options) || !options.contentType) throw new TypeError("Text configs require an explicit contentType");
      setHeader(headers, "Content-Type", options.contentType);
      body = config;
    } else {
      if (!isObject(config)) throw new TypeError("A JSON config must be an object");
      headers.set("Content-Type", "application/json");
      body = json(config);
    }
    if (options.forceReload) headers.set("Cache-Control", "must-revalidate");
    const { value } = await this.#request("POST", "load", body, options, headers);
    if (value === undefined) return { warnings: [] };
    // Released Caddy 2.11 uses a bare array; newer builds use an envelope.
    if (Array.isArray(value)) return { warnings: warnings(value) };
    if (!isObject(value)) throw new CaddyRequestError("invalid-response");
    return { warnings: warnings(value.warnings) };
  }

  /** Converts adapter input to JSON; does not provision, validate fully, or run it. */
  async adapt<T = JsonValue>(source: string, options: AdaptOptions = {}): Promise<AdaptResult<T>> {
    if (typeof source !== "string") throw new TypeError("Adapter input must be text");
    const headers = makeHeaders({ "Content-Type": options.contentType ?? "text/caddyfile" });
    const { value } = await this.#request("POST", "adapt", source, options, headers, true);
    if (!isObject(value) || !("result" in value)) throw new CaddyRequestError("invalid-response");
    return { result: value.result as T, warnings: warnings(value.warnings) };
  }

  async #request(method: string, endpoint: string, body: string | undefined, options: RequestOptions, extraHeaders?: Headers, requireJson = false): Promise<{ value: unknown; etag: string | null }> {
    const timeoutMs = timeout(options.timeoutMs ?? this.#timeoutMs);
    if (options.signal?.aborted) throw new CaddyRequestError("aborted");
    const controller = new AbortController();
    const headers = makeHeaders(this.#headers);
    extraHeaders?.forEach((value, key) => headers.set(key, value));
    let cancel!: (reason: CaddyRequestError) => void;
    const cancelled = new Promise<never>((_, reject) => { cancel = reject; });
    const abort = (code: "timeout" | "aborted") => {
      cancel(new CaddyRequestError(code));
      controller.abort();
    };
    const onAbort = () => abort("aborted");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => abort("timeout"), timeoutMs);
    const perform = async () => {
      try {
        const response = await this.#fetch(new URL(endpoint, this.#baseUrl), {
          method, headers, signal: controller.signal, redirect: "error", credentials: "omit",
          ...(body === undefined ? {} : { body }),
        });
        if (!response.ok) {
          // Do not read or retain an error body; it can echo secrets from the config.
          void response.body?.cancel().catch(() => {});
          throw new CaddyHttpError(response.status, method);
        }
        const text = await response.text();
        let value: unknown;
        if (text.trim()) {
          try { value = JSON.parse(text); } catch { throw new CaddyRequestError("invalid-response"); }
        } else if (requireJson) {
          throw new CaddyRequestError("invalid-response");
        }
        return { value, etag: response.headers.get("ETag") };
      } catch (error) {
        if (error instanceof CaddyHttpError || error instanceof CaddyRequestError) throw error;
        throw new CaddyRequestError("network");
      }
    };
    try { return await Promise.race([cancelled, perform()]); }
    finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }
}
