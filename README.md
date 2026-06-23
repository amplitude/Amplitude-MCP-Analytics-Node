# @amplitude/mcp-analytics

Amplitude MCP Analytics SDK — Model Context Protocol server usage tracking
for Amplitude Analytics.

> **Status:** Early preview. The MCP context object (`ctx`), its types, and
> factory helpers are available now. Transport and correlation handling (stdio
> and Streamable HTTP, across protocol revisions) is in place under the hood;
> the server-binding API, event tracking, and identity resolution land with the
> upcoming tracking releases.

## Install

```bash
pnpm add @amplitude/mcp-analytics @amplitude/analytics-node @modelcontextprotocol/sdk
```

`@amplitude/analytics-node` and `@modelcontextprotocol/sdk` are peer
dependencies — your MCP server already depends on the latter.

## Quick start

```ts
import { createMcpAnalytics } from '@amplitude/mcp-analytics';

const analytics = createMcpAnalytics({
  apiKey: process.env.AMPLITUDE_API_KEY!,
  serverName: 'my-mcp-server',
  serverVersion: '1.0.0',
});

// Or, to reuse an Amplitude client you already own:
//   createMcpAnalytics({ amplitude, serverName: '...', serverVersion: '...' })
//
// Higher-level event tracking methods are coming soon.
```

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

### Instrumentation requires a bound server

Tool instrumentation is activated by binding the SDK to your MCP server (the
server-binding API lands in an upcoming release). Until a tool's server is
bound, the instrumentation wrapper is a **no-op passthrough**: your handler runs
untouched, nothing is emitted, and no ambient context is established — the SDK
logs a one-time warning per tool rather than silently dropping events. This
keeps analytics strictly opt-in and guarantees instrumenting a tool can never
change its behavior before tracking is wired up.

## Custom event properties

Every event carries a set of **reserved** properties the SDK derives from the
context — identity, session/trace correlation, client/server identity, and (for
tool events) the tool metadata. You can attach your own properties on top of
these from two places:

- **`extra`** — an enrichment bag carried on the context. Put domain values on
  the server context (`extra` in `createServerContext`) or on a tool
  (`extra` in the tool metadata) and they ride along on the events derived from
  that context.
- **`properties`** — the per-call argument to `trackServerEvent` /
  `trackToolEvent`, for values specific to that one event.

### Precedence

When the same key appears in more than one place, precedence is fixed:

```
reserved (SDK-derived)  >  properties (per call)  >  extra (context bag)
```

- A **reserved** property always wins. A custom key that collides with one is
  **dropped and a warning is logged** — reserved properties define the event
  contract and can't be overwritten.
- A **`properties`** value overrides an **`extra`** value with the same key (the
  explicit, per-call value is the more intentional one).

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

