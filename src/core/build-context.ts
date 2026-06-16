/**
 * Build a tool-scope `ctx` from a live MCP request (internal). Reads the SDK
 * `extra` and composes the pure {@link createToolContext}. In `core/` (not the
 * SDK-free public `context/`) because it's SDK-aware and not public.
 */
import type { Implementation } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { createToolContext } from '../context/factory.js';
import type {
  McpAnchor,
  McpClientInfo,
  McpServerContext,
  McpToolContext,
  McpTransport,
  McpToolMeta
} from '../context/types.js';
import { metaRecord, readHeader, type McpExtra, type Transport } from './mcp.js';

/**
 * Classify the transport passed to `server.connect()` (server-scope). Probes for
 * `handleRequest` structurally — only `StreamableHTTPServerTransport` has it,
 * and it is not on the SDK `Transport` interface. Anything else is `stdio`.
 * @internal
 */
export function resolveTransport(transport: Transport): McpTransport {
  if ('handleRequest' in transport && typeof transport.handleRequest === 'function') {
    return 'streamable-http';
  }
  return 'stdio';
}

/**
 * Per-request client info. The stateless path carries `clientInfo` in `_meta` on
 * every request (wins); the legacy path negotiates it once at the handshake,
 * which {@link instrumentServer} caches onto the server scope (the fallback).
 * @internal
 */
function resolveClientInfo(extra: McpExtra, serverCtx: McpServerContext): McpClientInfo {
  const info = metaRecord(extra)?.clientInfo;
  const metaClientInfo = info != null && typeof info === 'object'
    ? (info as Implementation)
    : undefined;
  const clientFromHandshake = serverCtx.client;
  return {
    name: metaClientInfo?.name ?? clientFromHandshake?.name,
    version: metaClientInfo?.version ?? clientFromHandshake?.version,
    userAgent: readHeader(extra, 'user-agent') ?? clientFromHandshake?.userAgent,
  };
}

/**
 * Negotiated protocol version for one request: the `MCP-Protocol-Version` header
 * (legacy + stateless HTTP), else `_meta.protocolVersion` (stateless). Undefined
 * over stdio (carried at the handshake). @internal
 */
function resolveProtocolVersion(extra: McpExtra): string | undefined {
  const fromHeader = readHeader(extra, 'mcp-protocol-version');
  if (fromHeader != null) return fromHeader;
  const fromMeta = metaRecord(extra)?.protocolVersion;
  return typeof fromMeta === 'string' ? fromMeta : undefined;
}

/**
 * Parse the trace-id (2nd field, 32 hex chars) from the W3C `traceparent` in
 * `_meta`: `version-traceid-parentid-flags`. Undefined if absent, malformed, or
 * all-zero. @internal
 */
function parseTraceId(traceparent: string | undefined): string | undefined {
  if (traceparent == null) return undefined;
  const parts = traceparent.trim().split('-');
  if (parts.length < 4) return undefined;
  const traceId = parts[1];
  if (traceId == null || !/^[0-9a-f]{32}$/i.test(traceId)) return undefined;
  if (/^0{32}$/.test(traceId)) return undefined;
  return traceId.toLowerCase();
}

/**
 * Per-request correlation anchor, by transport:
 * - **stdio** → process lifetime.
 * - **streamable-http, legacy** (session id present) → the session id.
 * - **streamable-http, stateless** (no session id) → W3C trace context if
 *   propagated, else an anonymous per-request floor (aggregate-only, no
 *   stitching).
 *
 * A session id is never assumed — its absence selects the stateless branch.
 * @internal
 */
function resolveAnchor(transport: McpTransport, extra: McpExtra): McpAnchor {
  if (transport === 'stdio') {
    return { type: 'process', value: String(process.pid) };
  }

  // Streamable HTTP — legacy if a session id was minted, else stateless.
  const sessionId = extra.sessionId;
  if (typeof sessionId === 'string' && sessionId.length > 0) {
    return { type: 'session-id', value: sessionId };
  }

  // Stateless: prefer propagated trace context, else an anonymous floor.
  const tp = metaRecord(extra)?.traceparent;
  const traceId = parseTraceId(typeof tp === 'string' ? tp : undefined);
  if (traceId != null) {
    return { type: 'trace', value: traceId };
  }

  // Anonymous per-request floor.
  return { type: 'anonymous', value: randomUUID() };
}

/**
 * Extend the server-scope `serverCtx` with this request's fields. `transport` is
 * inherited from the server scope; per-request fields are are resolved per request.
 * Identity stays floored — its resolution consumes this anchor and is follow-up work.
 * @internal
 */
export function buildToolContext(
  serverCtx: McpServerContext,
  meta: McpToolMeta,
  extra: McpExtra,
): McpToolContext {
  const resolvedAnchor = resolveAnchor(serverCtx.transport, extra);

  return createToolContext(
    {
      ...serverCtx,
      anchor: resolvedAnchor,
      traceId: resolvedAnchor.type === 'trace' ? resolvedAnchor.value : serverCtx.traceId,
      protocolVersion: resolveProtocolVersion(extra) ?? serverCtx.protocolVersion,
      // Floored — identity resolution (which consumes the anchor) is follow-up work.
      identity: { resolvedFrom: 'anonymous' },
      client: resolveClientInfo(extra, serverCtx),
    },
    meta,
    { request: { method: 'tools/call' } },
  );
}
