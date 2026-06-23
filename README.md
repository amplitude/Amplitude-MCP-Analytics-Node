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

## Privacy & redaction

By default the SDK redacts personally identifiable information from the
**free-form content** of every event it emits — the properties you pass to
`trackServerEvent` / `trackToolEvent` and any host enrichment on `ctx.extra`.
The built-in patterns cover emails, phone numbers (incl. international), credit
cards, SSNs, and IPv4/IPv6 addresses; base64-encoded images are replaced with a
placeholder.

Identity and dimension fields (user id, session id, server name, etc.) are
**never** redacted — redacting them would corrupt attribution.

```ts
import { MCPAnalyticsConfig, createMcpAnalytics } from '@amplitude/mcp-analytics';

const analytics = createMcpAnalytics({
  apiKey: process.env.AMPLITUDE_API_KEY!,
  serverName: 'my-mcp-server',
  serverVersion: '1.0.0',
  config: new MCPAnalyticsConfig({
    // redactPii: true,                       // built-in PII patterns (default)
    customRedactionPatterns: [                // extra rules, applied after
      'secret-\\d+',                          //   bare string → "[REDACTED]"
      { pattern: '\\bACME-\\d+\\b', replacement: '[ticket]' },
    ],
    customRedactionFn: (text) => text.replace(/internal-\w+/g, '[hidden]'),
  }),
});
```

To turn built-in PII redaction off (e.g. you redact upstream), set
`redactPii: false`. Custom patterns and the custom function still run.

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
serverless flush accounting, privacy/PII redaction) is vendored from
`@amplitude/ai` rather than taken as a dependency. This keeps the two packages independent at runtime —
no shared package, no version coupling — while reusing battle-tested code.
Contributor notes on the vendoring policy live in `VENDORED.md`.

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
```

