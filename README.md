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

