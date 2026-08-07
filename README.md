# @amplitude/mcp-analytics

Amplitude MCP Analytics SDK — Model Context Protocol server usage tracking for Amplitude Analytics.

> **Status:** Preview. Server and tool instrumentation, the default event set,
> identity resolution, and custom events are available now. Transport and
> correlation handling (stdio and Streamable HTTP, across protocol revisions) is
> handled for you under the hood.

## Install

There are two ways to set up: let a coding agent do it, or follow this README manually.

**Option 1 — agent-assisted** Install the
[`instrument-mcp-server` skill](https://github.com/amplitude/builder-skills/tree/main/engineering-skills/skills/instrument-mcp-server)
(part of the [builder-skills](https://github.com/amplitude/builder-skills)
`engineering-skills` plugin) and ask your agent to instrument your MCP server —
it walks through this README for you, plus the recommended rationale and UTM
steps.

**Option 2 — manual**

```bash
pnpm add @amplitude/mcp-analytics @amplitude/analytics-node @modelcontextprotocol/sdk
```

`@amplitude/analytics-node` and `@modelcontextprotocol/sdk` are peer
dependencies — your MCP server already depends on the latter. Any
`@modelcontextprotocol/sdk` from `1.14.0` up is supported, including versions
`1.21.0`+, which changed how `McpServer` reports a failed `tools/call`; the
default events mean the same thing across that whole range.

## Quick start

```ts
import { createMcpAnalytics } from '@amplitude/mcp-analytics';

const analytics = createMcpAnalytics({
  apiKey: process.env.AMPLITUDE_API_KEY!,
  serverName: 'my-mcp-server',
  serverVersion: '1.0.0',
});

// Bind the server (enables analytics + emits connection events), then wrap your
// tool handlers. Order matters: instrumentServer() must run before connect().
analytics.instrumentServer(server, { authType: 'oauth' });

server.tool(
  'search_docs',
  schema,
  analytics.instrumentTool(
    async (args, extra) => doSearch(args), // your handler, unchanged
    { name: 'search_docs' },
  ),
);

await server.connect(transport);
```

To reuse an Amplitude client you already own, pass it instead of `apiKey`:

```ts
createMcpAnalytics({ amplitude, serverName: '...', serverVersion: '...' });
```

## Instrumenting your server

Two steps, both wrap things you already have — no handler signatures change.

**`instrumentServer(server, options?)`** binds the SDK to your MCP server. It
auto-detects the transport, captures the client/server handshake, and emits the
default connection events. Call it **before** `server.connect()` — that's when
the transport becomes available. It's idempotent and returns the same server.

**`instrumentTool(handler, meta)`** wraps a tool handler. The returned function
has the exact same shape as the one you pass in (`(args, extra)` with a schema,
`(extra)` without), so it drops straight into `server.tool(...)`. On each call it
emits `[MCP] Tool Call Response` with timing, error, and size details.

```ts
analytics.instrumentServer(server);
server.tool('search', schema, analytics.instrumentTool(
  async (args, extra) => doSearch(args),
  { name: 'search', owner: 'docs-team', extra: { 'feature flag': 'new-ranker' } },
));
```

> **`instrumentTool` requires `instrumentServer`.** If the server was never
> bound, the wrapper is a **no-op passthrough**: your handler runs untouched,
> nothing is emitted, and a one-time warning is logged. Instrumenting a tool can
> never change its behavior.

## Default events

Once a server is bound and its tools wrapped, the SDK emits these automatically:

| Event | When | Notable properties |
| -- | -- | -- |
| `[MCP] Session Initialized` | Connection handshake (stdio + legacy Streamable HTTP) | client/server identity, `[MCP] Transport`, `[MCP] Auth Type` |
| `[MCP] Session Ended` | Transport close (same transports) | `[MCP] Session Duration` |
| `[MCP] Tools Listed` | A `tools/list` request | `[MCP] Tool Count`, `[MCP] Tool Names` (capped), `[MCP] Response Duration`, `[MCP] Response Size` |
| `[MCP] Tool Call Response` | Every instrumented tool call | `[MCP] Is Error`, `[MCP] Error Message`/`[MCP] Error Code`/`[MCP] Error Type`/`[MCP] Error HTTP Status`, `[MCP] Response Duration`, `[MCP] Request Size`, `[MCP] Response Size`, `[MCP] Rationale` (opt-in, see below) |
| `[MCP] Tool Call Rejected` | A `tools/call` request that fails before any tool callback runs (unknown/disabled tool, input-schema validation) | `[MCP] Attempted Tool Name` (unvalidated input — kept off `[MCP] Tool Name`), `[MCP] Rejection Reason` (`unknown_tool`/`disabled_tool`/`schema_validation`/`unrecognized`), `[MCP] Error Message`, `[MCP] Response Duration`, `[MCP] Response Size`, `[MCP] Response HTTP Status` |

All event names and properties are prefixed `[MCP] ` so they never collide with
same-named events/properties from other Amplitude SDKs on the same project.

This table is a summary. The full reference — every property and when it's
present, identity resolution, transport nuances, and the error taxonomy —
lives in [`docs/events.md`](./docs/events.md).

Session events model a real protocol session, which only exists on stdio and
legacy (`2025-11-25`) Streamable HTTP. On stateless (`2026-07-28+`) HTTP there is
no session handshake, so `[MCP] Session Initialized` / `[MCP] Session Ended` are
**not** emitted rather than fabricated. Every event also carries the shared
context properties (identity, client/server, transport, trace correlation).

## Identity

`user_id` must match whatever you already send to Amplitude for the same user.
The SDK never guesses it from auth — you provide it, via whichever path fits:

```ts
// 1. Bound with the server. Scoped to that binding — hosts that build one
//    McpServer per request can pass per-request values safely; concurrent
//    bindings never overwrite each other.
analytics.instrumentServer(server, {
  userId: 'user-123',
  tenant: { groupType: 'org id', groupValue: '456' },
});

// 2. Per request, inside a handler (wins over everything else).
analytics.instrumentTool(async (args, extra) => {
  analytics.setIdentity({ userId: myAuth.getLoginId(extra) });
  return doWork(args);
}, { name: 'search' });

// 3. Opt-in, derived from the request's authInfo (you map the claims).
analytics.instrumentTool(handler, { name: 'search' }, {
  resolveIdentity: (authInfo) => ({ userId: authInfo?.sub as string }),
});
```

Resolution order (first match wins): `setIdentity()` → `resolveIdentity()` →
`instrumentServer` options → correlation anchor → an anonymous floor. When no
explicit identity is supplied but a correlation anchor exists (a stdio process,
a legacy session id, or a propagated W3C trace context), the SDK emits accurate
aggregate-only data under a synthetic `device_id` derived from that anchor —
never a polluting placeholder, never a fabricated user.

If there is no anchor either — the fully stateless case with no identity and no
tenant — each request would mint a brand-new random `device_id` with no
cross-call stitching, so those events are **dropped by default** rather than
inflating your user counts (see [`docs/events.md`](./docs/events.md)). Opt in to
emit them as anonymous, aggregate-only data with `emitAnonymousEvent: true`:

```ts
import { MCPAnalyticsConfig } from '@amplitude/mcp-analytics';

new MCPAnalyticsConfig({ emitAnonymousEvent: true });
```

## Rationale

Agent clients often supply a free-text rationale for a tool call ("why I'm
calling this tool"). If your server receives one — as a tool argument, in
`_meta`, a header, or however your convention works — pass it to the SDK and
it is emitted as the reserved `[MCP] Rationale` property on the tool-call
event and on every tool-scope custom event of the same invocation:

```ts
analytics.instrumentTool(async (args, extra) => {
  if (typeof args.rationale === 'string') {
    analytics.setRationale(args.rationale);
  }
  return doWork(args);
}, { name: 'search' });
```

The SDK never reads rationale out of tool inputs itself: it is content-bearing
free text, so emitting it is an explicit opt-in, and where it lives is your
convention. Callable at any depth inside an instrumented handler (like
`setIdentity`); truncated to 1000 characters; last write wins. Omitted
entirely when never set.

## Error HTTP status

When a tool call fails on a thrown error that carries an HTTP status
(`err.status` or `err.statusCode` — the common Node conventions), the
tool-call event includes `[MCP] Error HTTP Status`. This is the status of the
failure the tool hit (an upstream API response, an HTTP-shaped error), NOT the
MCP transport status — per the MCP spec, tool failures are returned in-band,
so the transport typically answers 200 even when this property is a 4xx/5xx.

For error shapes the SDK can't sniff, set it explicitly when building the
error: `analytics.toolError(ctx, { code, message, httpStatus: 502 })`.

Related but distinct: `[MCP] Response HTTP Status` is the transport-level
status of the HTTP response itself. The instrumented-tool wrapper never emits
it (dispatched tool calls answer 200; the wrapper emits before the response is
written). The default `[MCP] Tool Call Rejected` event carries it on
Streamable HTTP (protocol-level rejections answer 200 with the error in the
JSON-RPC body). For events you emit yourself, set `responseHttpStatus` on the
context's `request` info before calling `trackToolEvent`.

## Choosing what's captured

All default events are on by default. Toggle them with `autocapture` — a boolean
for everything, or an object to control families independently:

```ts
import { createMcpAnalytics, MCPAnalyticsConfig } from '@amplitude/mcp-analytics';

createMcpAnalytics({
  apiKey: process.env.AMPLITUDE_API_KEY!,
  serverName: 'my-mcp-server',
  serverVersion: '1.0.0',
  config: new MCPAnalyticsConfig({
    autocapture: { serverEvents: false }, // keep tool-call events, drop connection events
  }),
});
```

`autocapture: false` disables all default events; `{ serverEvents, toolCalls }`
toggles each family. `toolCalls` covers both `[MCP] Tool Call Response` and
`[MCP] Tool Call Rejected`. `serverEvents` can be split further with
`sessionLifecycle` (`[MCP] Session Initialized`/`Ended`) and `toolsListed`
(`[MCP] Tools Listed`) — e.g. servers built per HTTP request typically want
`{ sessionLifecycle: false, toolsListed: true }`, since their transports close
at the end of every request rather than at session end. Custom events (below)
are unaffected.

### Redacting error messages

`[MCP] Error Message` carries free text the SDK didn't compose — a failing tool's
own message, or the MCP SDK's input-validation text, which quotes the rejected
argument value. Either may contain end-user data. `sanitizeErrorMessage` rewrites
or drops it before emission, on every event that carries it:

```ts
createMcpAnalytics({
  apiKey: process.env.AMPLITUDE_API_KEY!,
  serverName: 'my-mcp-server',
  serverVersion: '1.0.0',
  config: new MCPAnalyticsConfig({
    sanitizeErrorMessage: (message) =>
      message.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '<email>'),
  }),
});
```

Return `null` to omit the property entirely. `[MCP] Error Code` and
`[MCP] Error Type` are unaffected, so failures stay segmentable. The text sent to
the client never changes. See
[Redacting `[MCP] Error Message`](docs/events.md#redacting-mcp-error-message).

## Context (`ctx`)

Every tracked event carries a per-invocation context object. You can construct
one and pass it explicitly to the tracking APIs, or expose it via
`runWithContext` so deeper call stacks can read it through `getCurrentContext()`.

```ts
import {
  createServerContext,
  createToolContext,
  runWithContext,
} from '@amplitude/mcp-analytics/context';

const serverCtx = createServerContext({
  server: { name: 'my-mcp-server', version: '1.0.0' },
  transport: 'stdio',
});

const toolCtx = createToolContext(serverCtx, { name: 'search_docs' });

runWithContext(toolCtx, () => {
  // getCurrentContext() is available here if needed
});
```

Types and helpers are also re-exported from the main entry
(`@amplitude/mcp-analytics`).

You usually don't build `ctx` by hand — `instrumentServer` / `instrumentTool`
construct and inject it for you. Reach for these factories when emitting events
outside an instrumented handler.

## Custom event properties

Every event carries a set of **reserved** properties the SDK derives from the
context — identity, session/trace correlation, client/server identity, and (for
tool events) the tool metadata. You can attach your own properties on top of
these from two places:

- **`extra`** — an enrichment bag carried on the context. Put domain values at
  the server scope (`extra` in `instrumentServer` options) or on a tool (`extra`
  in the tool metadata) and they ride along on every event derived from that
  scope — including the default events.
- **`properties`** — the per-call argument to `trackServerEvent` /
  `trackToolEvent`, for values specific to that one event.

### Precedence

When the same key appears in more than one place, the merge order is fixed —
later sources overwrite earlier ones:

```
reserved (SDK-derived)  <  extra (context bag)  <  properties (per call)
```

- A **`properties`** value wins over anything with the same key — including a
  reserved property (the explicit, per-call value is the most intentional one).
- An **`extra`** value overrides a reserved property but loses to `properties`.
- On the **default events**, the SDK's outcome values (`[MCP] Is Error`,
  `[MCP] Response Duration`, …) ride as per-call `properties`, so a colliding
  `extra` key can't overwrite them.

Reserved names all carry the `[MCP] ` prefix — avoid it in your own keys and
collisions never arise.

### Dropping the `extra` bag

`extra` properties are included by default. To omit them for a single event,
pass `{ dropExtraProps: true }`:

```ts
analytics.trackToolEvent(ctx, 'my event', { foo: 'bar' }, { dropExtraProps: true });
```

Values are sent as provided — the SDK does not escape or redact them. Apply any
output encoding where the data is rendered.

## Architecture decisions

### Separate repo from `@amplitude/ai`

MCP server analytics is a distinct product from agent analytics. Different
audience (MCP server operators vs. agent developers), different domain model
(server / session / tool invocation vs. agent / turn / message), and a
different release cadence. Keeping the repos separate lets each evolve on
its own timeline without coupling unrelated breaking changes.

### `-node` suffix

Node/TypeScript only for v1. A Python SDK may follow; the suffix leaves
room without forcing a future rename.

### Mimic `@amplitude/ai` for DX, not for the domain model

Build tooling (tsdown, vitest, biome), repo layout, constructor shape, mock
test client, subpath exports, and release pipeline all mirror Amplitude-AI-Node
so contributors moving between the two repos see familiar patterns. The
domain model — events, properties, identity, context — is MCP-native and
intentionally does not reuse agent vocabulary.

### Vendor the core, no hard dependency

A small set of shared, low-level utilities (the delivery proxy + hooks,
serverless flush accounting) is vendored from `@amplitude/ai` rather than
taken as a dependency. This keeps the two packages independent at runtime —
no shared package, no version coupling — while reusing battle-tested code.
Contributor notes on the vendoring policy live in `VENDORED.md`.

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
```

