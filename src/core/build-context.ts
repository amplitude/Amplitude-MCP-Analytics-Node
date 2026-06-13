/**
 * Build a tool-scope `ctx` from a live MCP request (internal). Reads the SDK
 * `extra` and composes the pure {@link createToolContext}. In `core/` (not the
 * SDK-free public `context/`) because it's SDK-aware and not public.
 */
import type { Implementation } from '@modelcontextprotocol/sdk/types.js';
import { createToolContext } from '../context/factory.js';
import type { McpClientInfo, McpServerContext, McpToolContext, McpToolMeta } from '../context/types.js';
import { metaRecord, readHeader, type McpExtra } from './mcp.js';
import { resolveAnchor, resolveProtocolVersion } from './resolve.js';

/**
 * Per-request client info. The stateless path carries `clientInfo` in `_meta` on
 * every request (wins); the legacy path negotiates it once at the handshake,
 * which {@link instrumentServer} caches onto the server scope (the fallback).
 */
function resolveClientInfo(extra: McpExtra, serverCtx: McpServerContext): McpClientInfo {
  const info = metaRecord(extra)?.clientInfo;
  const metaClientInfo = info != null && typeof info === 'object' ? (info as Implementation) : undefined;
  const clientFromHandshake = serverCtx.client;
  return {
    name: metaClientInfo?.name ?? clientFromHandshake?.name,
    version: metaClientInfo?.version ?? clientFromHandshake?.version,
    userAgent: readHeader(extra, 'user-agent') ?? clientFromHandshake?.userAgent,
  };
}

/**
 * Extend the server-scope `serverCtx` with this request's fields. `transport` is
 * inherited from the server scope; `anchor`, `protocolVersion`, `traceId`, and
 * `client` are resolved per request. Identity stays floored — its resolution
 * consumes this anchor and is follow-up work.
 *
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
