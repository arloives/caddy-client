# caddy-client

A small, unofficial TypeScript client for [Caddy's admin API](https://caddyserver.com/docs/api).

Read config, make targeted changes, load a complete config, or adapt a Caddyfile to JSON. Zero runtime dependencies. Native `fetch`, ESM, and TypeScript declarations. Node.js 22+.

This project is independent of Caddy and is not maintained or endorsed by its authors.

> The admin API is privileged: it can replace your server's running configuration. Keep it private, preferably on loopback or behind a properly secured administrative proxy. This library does not start or expose an admin endpoint.

## Install

There is no npm registry release yet. Install directly from GitHub:

```sh
npm install github:arloives/caddy-client
```

npm runs the package's `prepare` script to build the TypeScript source. Git and npm development-dependency installation are required for that step. Pin a commit in the GitHub dependency URL for reproducible installs.

Or build locally:

```sh
git clone https://github.com/arloives/caddy-client.git
cd caddy-client
npm ci
npm run check
npm pack
# In another project: npm install /path/to/arloives-caddy-client-0.1.0.tgz
```

## Read a config

```ts
import { CaddyClient } from '@arloives/caddy-client';

const caddy = new CaddyClient(); // http://localhost:2019; 10-second timeout
const { config, etag } = await caddy.getConfig();

// Each item is one key or array index, not a slash-separated path.
const listeners = await caddy.getConfig<string[]>([
  'apps', 'http', 'servers', 'main', 'listen',
]);
console.log(listeners.config);
```

The generic type is your assertion about the response. It does not validate the config against a Caddy schema. Caddy is extensible; this package intentionally does not claim to type every module.

## Change a specific value

```ts
const path = ['apps', 'http', 'servers', 'main', 'listen'] as const;
const current = await caddy.getConfig<string[]>(path);
if (!current.etag) throw new Error('Server did not return an ETag');

await caddy.patchConfig(path, ['127.0.0.1:8080'], {
  ifMatch: current.etag,
});
```

`If-Match` detects conflicting writes. Replay the ETag exactly, including quotes, and choose a read scope that covers your intended change. HTTP 412 means the precondition failed. There are no automatic retries or multi-request transactions. Caddy documents this concurrency API as experimental.

Methods preserve Caddy's HTTP semantics:

| Method | Effect |
| --- | --- |
| `getConfig(path?, options?)` | Read JSON and its ETag; returns `{ config, etag }` |
| `postConfig(path, value, options?)` | Create/replace an object value, or append to an array |
| `putConfig(path, value, options?)` | Create a new object value, or insert at an array index |
| `patchConfig(path, value, options?)` | Replace an existing value; not JSON Patch or Merge Patch |
| `deleteConfig(path, options?)` | Delete a value |
| `load(config, options?)` | Replace and run the entire configuration; returns `{ warnings }` |
| `adapt(source, options?)` | Convert adapter input to JSON; returns `{ result, warnings }` |

`[]` means the config root. `deleteConfig([])` unloads the entire active config; it does not exit the process. A trailing `'...'` segment uses Caddy's array-expansion operation with POST. Keys containing slashes, backslashes, percent signs, control characters, empty strings, `.` or `..` are rejected because URL decoding/normalization makes them unsafe or ambiguous. Use the nearest addressable parent to change such keys. `/id/` and non-config admin endpoints are outside this package's scope.

## Adapt or load

```ts
const source = '{\n\tadmin localhost:2019\n}\nhttp://127.0.0.1:8080 {\n\trespond "hello"\n}\n';
import type { JsonObject } from '@arloives/caddy-client';
const adapted = await caddy.adapt<JsonObject>(source); // text/caddyfile by default
console.log(adapted.warnings);

// These change the running server; choose one intentionally:
await caddy.load(adapted.result);
// Or: await caddy.load(source, { contentType: 'text/caddyfile' });
```

Use `adapt<JsonObject>(source)` when you expect a config object (import `JsonObject` from the package). Other adapters work with their installed media type, for example `{ contentType: 'application/json5' }`.

**Adaptation is not full validation.** `/adapt` parses/converts configuration without provisioning or running it. It can succeed when loading would fail. For provisioning validation without applying a config, use Caddy's separate [`caddy validate` command](https://caddyserver.com/docs/command-line#caddy-validate); this library has no invented `/validate` endpoint.

`load` is a mutation. Caddy attempts to retain the previous working config if loading fails. Pass `{ forceReload: true }` to request a reload of unchanged config. Successful text loads can return adapter warnings. The client normalizes both the bare warning array returned by Caddy 2.11 and the envelope used by newer builds. `/load` does not support `If-Match`; for conditional whole-config replacement, use `postConfig([], config, { ifMatch: rootEtag })` instead. Ensure a replacement config retains any required admin address and security settings.

## Timeouts, cancellation, and errors

```ts
import { CaddyClient, CaddyHttpError, CaddyRequestError } from '@arloives/caddy-client';

const caddy = new CaddyClient({
  baseUrl: 'http://localhost:2019',
  timeoutMs: 5_000,
  // headers: { Authorization: `Bearer ${process.env.ADMIN_TOKEN}` },
  // fetch: customFetch,
});

try {
  await caddy.getConfig([], {
    signal: AbortSignal.timeout(2_000),
    timeoutMs: 3_000, // optional per-request override
  });
} catch (error) {
  if (error instanceof CaddyHttpError) {
    console.error(error.status, error.method);
  } else if (error instanceof CaddyRequestError) {
    console.error(error.code); // timeout, aborted, network, invalid-response
  } else {
    throw error;
  }
}
```

Caddy may restart its admin listener during a reload. For tightly sequenced reload/read scripts using Node's default transport, `headers: { Connection: 'close' }` helps avoid reusing a just-closed keep-alive socket. A reload can also briefly interrupt the listener itself. Allow it to settle and retry a read to check state; do not blindly retry a mutation. The library does not add retries.

The timeout includes response-body reading. Positive integer timeouts are required. Redirects are refused. A timed-out, aborted, or disconnected mutation **may already have applied**; read the server state before deciding what to do next. Config values must be finite, acyclic JSON data; accessors are rejected and `toJSON` hooks are not executed.

HTTP exceptions expose status and method. They deliberately omit server response bodies, headers, full URLs, and underlying transport errors, all of which can contain secrets. Use your secured Caddy server logs when diagnosis needs more detail. The library does not log requests or responses. Success responses and warnings can still contain sensitive configuration: handle them accordingly.

Only absolute HTTP(S) base URLs are accepted, without embedded credentials, queries, or fragments. A trusted reverse-proxy path prefix is supported. Authentication can be supplied through headers. The client sends the admin URL's origin in the `Origin` header because Node fetch sends fetch-metadata headers that trigger Caddy's origin checks. A custom `Origin` header is preserved for trusted proxy setups; server origin protections are never disabled. Custom `fetch` implementations must honor the supplied abort signal, credentials policy, and redirect setting. Node fetch does not provide Unix-socket support here; use a suitable custom transport if needed. This is a server-side package, not a browser admin dashboard; browser CORS restrictions and exposing administrative access are outside its scope.

## Development

```sh
npm ci
npm run check             # strict types, unit/HTTP fixtures, packed consumer
CADDY_BIN=/path/to/caddy npm run test:integration
```

The integration test starts its own Caddy process on a random loopback port, uses temporary config/data directories, and cleans it up. It never connects to an existing Caddy instance. CI checks Node 22 and 24 against Caddy 2.11.4 using the checksum-verified official binary. Use a maintained Caddy release in production.

The wire behavior follows the [official API documentation](https://caddyserver.com/docs/api) and [Caddy's adapter implementation](https://github.com/caddyserver/caddy/blob/v2.11.4/caddyconfig/load.go), including the actual `/adapt` result/warnings envelope.

MIT licensed.
