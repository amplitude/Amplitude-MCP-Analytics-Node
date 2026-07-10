# Event reference

Every event `@amplitude/mcp-analytics` sends to Amplitude, with the exact
conditions under which it fires and every property it can carry. For setup and
API usage, see the [README](../README.md).

Events are delivered through the standard Amplitude Node client (`track()`), so
they land in your project like any other event. All default event names and all
SDK-derived properties carry the `[MCP] ` prefix (including the trailing space)
so they never collide with same-named events or properties sent by other
Amplitude SDKs on the same project.

## Events at a glance

| Event | Fires when | Transports | Toggle |
| -- | -- | -- | -- |
| [`[MCP] Session Initialized`](#mcp-session-initialized) | The `initialize` handshake completes | stdio, legacy Streamable HTTP | `autocapture.serverEvents` |
| [`[MCP] Session Ended`](#mcp-session-ended) | The transport closes, after an initialized session | stdio, legacy Streamable HTTP | `autocapture.serverEvents` |
| [`[MCP] Tools Listed`](#mcp-tools-listed) | A `tools/list` request is served | all | `autocapture.serverEvents` |
| [`[MCP] Tool Call Response`](#mcp-tool-call-response) | An instrumented tool call settles | all | `autocapture.toolCalls` |

"Legacy Streamable HTTP" is the `2025-11-25` protocol revision, where the
server mints a session id at the `initialize` handshake. On stateless
(`2026-07-28+`) Streamable HTTP there is no handshake, so no protocol session
exists — the session lifecycle events are **not emitted** rather than
fabricated. `[MCP] Tools Listed` and `[MCP] Tool Call Response` fire on every
transport.

All four events require `instrumentServer(server)` to have been called before
`server.connect()`. `instrumentTool` without a bound server is a no-op
passthrough: the handler runs untouched and nothing is emitted (a one-time
warning is logged).

### Emission guarantees

- **Best-effort, never throws.** A failure inside the SDK or the Amplitude
  client is swallowed and logged; it never breaks the handler, the `tools/list`
  response, or the connection. Handler exceptions are re-thrown to the MCP SDK
  *after* the failure event is emitted.
- **Aggregate-only floor, with one skip rule.** When no real identity is
  available the SDK emits under a synthetic, anchor-derived identity (see
  [Identity](#identity-on-every-event)). If an event would carry *neither* a
  resolvable identity *nor* a tenant — a fully anonymous request on stateless
  HTTP with no trace context — it is **dropped**, not emitted as noise.
- **`dryRun`** (`MCPAnalyticsConfig`) builds events normally but does not
  deliver them; `debug` logs each emission.

## Identity on every event

Alongside `event_properties`, every event carries the standard Amplitude
identity fields, resolved per request through a fixed fallback chain (first
match wins):

| Order | Source | Identity `resolvedFrom` |
| -- | -- | -- |
| 1 | `analytics.setIdentity({...})` called during the request | `explicit` |
| 2 | `resolveIdentity(authInfo)` callback (per-tool opt-in) returning a non-empty result | `authInfo` |
| 3 | Static identity from `instrumentServer(server, { userId, deviceId, tenant })` | `explicit` |
| 4 | Correlation anchor available (process / session id / trace) | `anchor` |
| 5 | Anonymous per-request floor | `anonymous` |

- **`user_id`** — the resolved user id. At level 4 it is the synthetic key
  `<anchor type>:<anchor value>` (e.g. `process:12345`,
  `session-id:8f4c…`); at level 5 it is `anonymous:<device id>`.
- **`device_id`** — the resolved device id. When you supply a `userId` without
  a `deviceId`, the SDK derives a stable device id from the anchor (a UUIDv5 of
  the anchor key) so calls in the same session/process/trace correlate. At
  level 5 it is a random UUID per request.
- **`groups`** — set to `{ [tenant.groupType]: tenant.groupValue }` when a
  tenant was provided (via `setIdentity`, `resolveIdentity`, or
  `instrumentServer` options). The tenant is carried on Amplitude `groups`,
  **not** as an event property. Via `resolveIdentity` or the `instrumentServer`
  options a tenant only takes effect alongside a `userId`/`deviceId` from the
  same source; `setIdentity` and manually built contexts can set it on its own.

Amplitude silently drops ids shorter than 5 characters; the SDK warns when a
resolved id is that short.

**Skip rule.** An event whose identity resolved to the anonymous floor (level
5) *and* that has no tenant is dropped entirely. In practice this only affects
stateless Streamable HTTP requests with no identity configured and no
`traceparent` propagated.

### Correlation anchor

The anchor is the per-request correlation key the SDK derives from the
transport. It feeds `[MCP] Anchor Type`, `[MCP] Session ID`, and the synthetic
identity floor:

| Transport | Anchor (`[MCP] Anchor Type`) | Anchor value | `[MCP] Session ID` |
| -- | -- | -- | -- |
| stdio | `process` | Server process id | `no-session` |
| Streamable HTTP, session id present (legacy) | `session-id` | The transport session id | The session id |
| Streamable HTTP, stateless, W3C `traceparent` in `_meta` | `trace` | The 32-hex trace id | `no-session` |
| Streamable HTTP, stateless, no trace context | `anonymous` | Random UUID per request | `no-session` |

A session id is never assumed or fabricated — its absence is what selects the
stateless branch.

## Shared properties

Every event — the four default events *and* custom events emitted through
`trackServerEvent` / `trackToolEvent` — carries these SDK-derived properties:

| Property | Type | Present | Value |
| -- | -- | -- | -- |
| `[MCP] Session ID` | string | always | The protocol session id when the anchor is a session id; the literal `no-session` otherwise |
| `[MCP] Client Name` | string | always | MCP client name from the handshake `clientInfo` (stdio/legacy) or per-request `_meta.clientInfo` (stateless, wins over the handshake); `unknown` when unavailable |
| `[MCP] Client Version` | string | when known | MCP client version, same sources as the name |
| `[MCP] User Agent` | string | always | Raw HTTP `User-Agent` header (Streamable HTTP); `unknown` otherwise (always `unknown` on stdio) |
| `[MCP] Server Name` | string | always | `serverName` from the client options |
| `[MCP] Server Version` | string | when set | `serverVersion` from the client options (always set when instrumented through `instrumentServer`) |
| `[MCP] Server Type` | string | when set | Server classification; only present when set on a manually built context |
| `[MCP] Transport` | string | always | `stdio` or `streamable-http`, auto-detected from the transport passed to `connect()` |
| `[MCP] Anchor Type` | string | always | `session-id`, `trace`, `process`, or `anonymous` — see [Correlation anchor](#correlation-anchor) |
| `[MCP] Protocol Version` | string | when carried | Negotiated MCP protocol revision, read per request from the `MCP-Protocol-Version` HTTP header or `_meta.protocolVersion`. Not captured on stdio or at the handshake, so the session events don't carry it |
| `[MCP] Auth Type` | string | when configured | The `authType` passed to `instrumentServer` (e.g. `oauth`); values are server-specific |

On top of these, any **`extra`** enrichment bags in scope ride along as
event properties: the server-scope bag (`extra` in `instrumentServer` options)
on every event, plus the tool-scope bag (`extra` in the tool metadata) on
tool-scope events. See [Property precedence](#property-precedence).

## `[MCP] Session Initialized`

Marks the start of a protocol session.

- **Fires when:** the MCP `initialize` handshake completes (the SDK hooks the
  server's `oninitialized`). This is also the moment the SDK captures the
  client's `clientInfo` for the session.
- **Transports:** stdio and legacy (`2025-11-25`) Streamable HTTP only — the
  stateless revision has no handshake, so the event is never fabricated there.
- **Toggle:** `autocapture.serverEvents`.
- **Identity:** resolved at the handshake from the static `instrumentServer`
  identity, else the anchor (the legacy transport's session id, or the process
  on stdio). Per-request sources (`setIdentity`, `resolveIdentity`) don't apply
  — no tool call is in flight.

**Properties:** the [shared properties](#shared-properties) and the
server-scope `extra` bag only; this event has no event-specific properties.

## `[MCP] Session Ended`

Marks the end of a protocol session.

- **Fires when:** the transport closes (the SDK chains the server's `onclose`)
  — but only when `[MCP] Session Initialized` was emitted for that connection
  first. Stateless HTTP and never-initialized connections never emit it.
- **Transports / toggle / identity:** as `[MCP] Session Initialized`; the
  event reuses the session context resolved at the handshake.

**Event-specific properties:**

| Property | Type | Present | Value |
| -- | -- | -- | -- |
| `[MCP] Session Duration` | number (ms, integer) | when known | Wall-clock time from the `initialize` handshake to transport close, rounded to the nearest millisecond |

## `[MCP] Tools Listed`

Reports each `tools/list` request the server serves, with the live tool set at
call time (tools added or removed after `connect()` are reflected).

- **Fires when:** the server's `tools/list` handler returns **or throws**. The
  handler's behavior is unchanged — its result or throw passes through
  untouched.
- **Transports:** all. On stateless HTTP the [skip rule](#emission-guarantees)
  applies per request.
- **Toggle:** `autocapture.serverEvents`.
- **Identity:** resolved per request through the full fallback chain (minus
  `setIdentity`, which needs a tool handler in flight).

**Event-specific properties:**

| Property | Type | Present | Value |
| -- | -- | -- | -- |
| `[MCP] Is Error` | boolean | always | `true` when the `tools/list` handler threw |
| `[MCP] Tool Count` | number | always | Number of tools returned. Always the **true total**, even when the names list is truncated; `0` on failure |
| `[MCP] Tool Names` | string[] | when ≥ 1 tool | The returned tool names, capped at **100** entries |
| `[MCP] Tool Names Truncated` | boolean | only when capped | `true` when more than 100 names were returned and the list was truncated; absent otherwise |
| `[MCP] Response Duration` | number (ms, integer) | always | Wall-clock duration of the `tools/list` handler |
| `[MCP] Response Size` | number (bytes) | on success, when serializable | Serialized byte size of the full `tools/list` result |
| `[MCP] Error Message` | string | on failure | Message of the classified error |
| `[MCP] Error Type` | string | on failure | Error category — see [Error classification](#error-classification) |

## `[MCP] Tool Call Response`

The default tool-execution event — one per call of a handler wrapped with
`instrumentTool`.

- **Fires when:** the wrapped handler settles: returns (sync or async), throws,
  or rejects. On failure the event is emitted **before** the error is re-thrown
  to the MCP SDK.
- **A call counts as a failure when** the handler throws/rejects, **or** it
  returns an in-band error result (`CallToolResult` with `isError: true`).
- **Transports:** all. The stateless-HTTP skip rule applies per request.
- **Toggle:** `autocapture.toolCalls`. When off, the wrapper still builds and
  provides `ctx` (so `setIdentity` and custom events keep working) but emits no
  default event.
- **Identity:** resolved per request through the full fallback chain,
  including `setIdentity` calls made inside the handler and the
  `resolveIdentity` callback passed to `instrumentTool`.

**Event-specific properties** (on top of the shared set):

| Property | Type | Present | Value |
| -- | -- | -- | -- |
| `[MCP] Tool Name` | string | always | `name` from the tool metadata |
| `[MCP] Tool Owner` | string | when set | `owner` from the tool metadata |
| `[MCP] Tool Tags` | string[] | when set, non-empty | `tags` from the tool metadata |
| `[MCP] Tool Category` | string | when set, non-empty | `category` from the tool metadata |
| `[MCP] Is Error` | boolean | always | `true` on a thrown exception or an in-band `isError` result |
| `[MCP] Response Duration` | number (ms, integer) | always | Wall-clock handler duration, rounded |
| `[MCP] Request Size` | number (bytes) | schema-taking handlers, when serializable | Serialized byte size of the tool's arguments (the handler's first parameter). Absent for handlers registered without an input schema |
| `[MCP] Response Size` | number (bytes) | when the handler returned, when serializable | Serialized byte size of the returned `CallToolResult`. Absent when the handler threw |
| `[MCP] Error Message` | string | on failure | Message of the classified error |
| `[MCP] Error Type` | string | on failure | Error category — see [Error classification](#error-classification) |

The tool-scope `extra` bag (from the tool metadata) and the server-scope bag
both ride along as additional properties. The bag is read at emit time, so a
handler may enrich `ctx.tool.extra` mid-call and the values land on this event.

**Example** (success, legacy Streamable HTTP, OAuth-resolved identity):

```json
{
  "event_type": "[MCP] Tool Call Response",
  "user_id": "user-123",
  "device_id": "1c6afb4c-6ba7-5f5d-9c2e-6a1f8d1f2ab3",
  "groups": { "org id": "456" },
  "event_properties": {
    "[MCP] Session ID": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "[MCP] Client Name": "cursor",
    "[MCP] Client Version": "0.40",
    "[MCP] User Agent": "node",
    "[MCP] Server Name": "my-mcp-server",
    "[MCP] Server Version": "1.0.0",
    "[MCP] Transport": "streamable-http",
    "[MCP] Anchor Type": "session-id",
    "[MCP] Protocol Version": "2025-11-25",
    "[MCP] Auth Type": "oauth",
    "[MCP] Tool Name": "search_docs",
    "[MCP] Tool Owner": "docs-team",
    "[MCP] Is Error": false,
    "[MCP] Response Duration": 184,
    "[MCP] Request Size": 64,
    "[MCP] Response Size": 2048,
    "feature flag": "new-ranker"
  }
}
```

## Error classification

`[MCP] Error Type` (on `[MCP] Tool Call Response` and `[MCP] Tools Listed`)
carries one of:

| Value | Meaning |
| -- | -- |
| `returned_error` | The tool returned an in-band error result (`isError: true`) — the default when no richer type was recorded |
| `thrown_exception` | The handler threw a JavaScript `Error` not matching a more specific rule |
| `timeout` | The thrown error was an `AbortError` |
| `transport_error` | The thrown error carried a Node network error code (`ECONNREFUSED`, `ECONNRESET`, `ENOTFOUND`, `ETIMEDOUT`, `EPIPE`, `EAI_AGAIN`) |
| `validation_error` | Only via `analytics.toolError()` — bad or missing input |
| `auth_error` | Only via `analytics.toolError()` — authentication/authorization failure |
| `upstream_error` | Only via `analytics.toolError()` — a dependency/upstream API failed |
| `unknown` | A non-`Error` value was thrown |

Thrown values are classified automatically. For in-band error results, the
default is `returned_error` with `[MCP] Error Message` taken from the result's
text content; to control the type, code, and message, build the result with
`analytics.toolError(ctx, { code, message, type, ... })` — the structured
error is stored on `ctx.error` and the event reports your values instead.

Only the **message** and **type** are emitted on the default events. The rest
of the structured error (`code`, `source`, `recoverable`, `fingerprint`,
privacy-safe `stackHash`, …) stays on `ctx.error`, where a custom event can
pick it up.

## Custom events

`trackServerEvent(ctx, name, properties?, options?)` and
`trackToolEvent(ctx, name, properties?, options?)` emit your own events with
the same treatment as the defaults:

- They inherit the full [shared property set](#shared-properties) (plus, for
  `trackToolEvent`, the tool-scope reserved properties) and the `extra` bags.
- The [skip rule](#emission-guarantees) and best-effort guarantee apply.
- Event names are yours verbatim — the SDK does not prefix them. Avoid the
  `[MCP] ` prefix, which is reserved for SDK-emitted names and properties.
- Pass `{ dropExtraProps: true }` to omit the `extra` bags from one event.

### Property precedence

Properties merge in a fixed order — **later sources overwrite earlier ones**:

```
reserved (SDK-derived)  <  extra (context bag)  <  properties (per call)
```

- A per-call `properties` value wins over everything, including a same-named
  reserved property.
- An `extra` value wins over a reserved property but loses to `properties`.
- On the **default events**, the SDK's own outcome values (`[MCP] Is Error`,
  `[MCP] Response Duration`, sizes, error fields, `[MCP] Session Duration`,
  `[MCP] Tool Count`, …) are passed as per-call properties, so a colliding
  `extra` key cannot overwrite them.

All reserved names carry the `[MCP] ` prefix — keep it out of your own keys
and collisions never arise.

Values are sent exactly as provided; the SDK does not escape, truncate, or
redact `extra` or `properties` values. Apply output encoding where the data is
rendered, and keep sensitive values out.

## Measurement conventions

- **Durations** (`[MCP] Response Duration`, `[MCP] Session Duration`) are
  wall-clock milliseconds, rounded to the nearest integer.
- **Sizes** (`[MCP] Request Size`, `[MCP] Response Size`) are the UTF-8 byte
  length of the value's JSON serialization — the payload semantics, not the
  bytes on the wire. Omitted when the value isn't JSON-serializable.

## Property index

Every property the SDK can emit, and where it appears. *All* = the four
default events plus custom events emitted through `trackServerEvent` /
`trackToolEvent`; *tool-scope* = `[MCP] Tool Call Response` and
`trackToolEvent` events.

| Property | Type | Appears on |
| -- | -- | -- |
| `[MCP] Anchor Type` | string | All |
| `[MCP] Auth Type` | string | All (when configured) |
| `[MCP] Client Name` | string | All |
| `[MCP] Client Version` | string | All (when known) |
| `[MCP] Error Message` | string | `Tools Listed`, `Tool Call Response` (failures) |
| `[MCP] Error Type` | string | `Tools Listed`, `Tool Call Response` (failures) |
| `[MCP] Is Error` | boolean | `Tools Listed`, `Tool Call Response` |
| `[MCP] Protocol Version` | string | All (when carried on the request) |
| `[MCP] Request Size` | number | `Tool Call Response` |
| `[MCP] Response Duration` | number | `Tools Listed`, `Tool Call Response` |
| `[MCP] Response Size` | number | `Tools Listed`, `Tool Call Response` |
| `[MCP] Server Name` | string | All |
| `[MCP] Server Type` | string | All (when set on the context) |
| `[MCP] Server Version` | string | All |
| `[MCP] Session Duration` | number | `Session Ended` |
| `[MCP] Session ID` | string | All |
| `[MCP] Tool Category` | string | Tool-scope (when set) |
| `[MCP] Tool Count` | number | `Tools Listed` |
| `[MCP] Tool Name` | string | Tool-scope |
| `[MCP] Tool Names` | string[] | `Tools Listed` |
| `[MCP] Tool Names Truncated` | boolean | `Tools Listed` (only when truncated) |
| `[MCP] Tool Owner` | string | Tool-scope (when set) |
| `[MCP] Tool Tags` | string[] | Tool-scope (when set) |
| `[MCP] Transport` | string | All |
| `[MCP] User Agent` | string | All |
