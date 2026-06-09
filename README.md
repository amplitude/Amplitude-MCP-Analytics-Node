# @amplitude/mcp-analytics

Amplitude MCP Analytics SDK — Model Context Protocol server usage tracking
for Amplitude Analytics.

> **Status:** v0 scaffold. The event taxonomy, identity model, transport
> layer, and `ctx` object are tracked in the MCP-356 milestone and not yet
> implemented in this package.

## Install

```bash
pnpm add @amplitude/mcp-analytics @amplitude/analytics-node
```

## Quick start

```ts
import { AmplitudeMCPAnalytics } from '@amplitude/mcp-analytics';

const analytics = new AmplitudeMCPAnalytics({
  apiKey: process.env.AMPLITUDE_API_KEY!,
  serverName: 'my-mcp-server',
  serverVersion: '1.0.0',
});

// Event tracking methods land in MCP-358 / MCP-363.
```

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

The small set of shared utilities (`privacy.ts`, `TrackingProxy` + delivery
hooks, serverless flush accounting) will be vendored from `@amplitude/ai`
with provenance headers pinning the source commit SHA. This keeps the two
packages independent at runtime — no shared package, no version coupling —
while reusing battle-tested code.

Re-sync process: when a vendored file changes upstream, update it here in a
single PR titled `chore: sync vendored from amplitude-ai @ <sha>`, bumping
the provenance header.

> Vendored content is pending sign-off from the `@amplitude/ai` team
> (tracked in MCP-364). This scaffold ships without vendored code; it will
> be layered in as a follow-up commit.

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
```

