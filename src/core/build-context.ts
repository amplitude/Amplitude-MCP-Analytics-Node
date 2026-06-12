/**
 * Build a tool-scope `ctx` from a live MCP request (internal). Reads the SDK
 * `extra` and composes the pure {@link createToolContext}. In `core/` (not the
 * SDK-free public `context/`) because it's SDK-aware and not public.
 */
import type { Implementation } from '@modelcontextprotocol/sdk/types.js';
import { createToolContext } from '../context/factory.js';
import type { McpServerContext, McpToolContext, McpToolMeta } from '../context/types.js';
import { metaRecord, readHeader, type McpExtra } from './mcp.js';

/** Client identity from the `_meta` bag (`clientInfo`); read defensively. @internal */
function clientInfoOf(extra: McpExtra): Implementation | undefined {
  const info = metaRecord(extra)?.clientInfo;
  return info != null && typeof info === 'object' ? (info as Implementation) : undefined;
}

/**
 * Extend the server-scope `serverCtx` with this request's fields. Per-request
 * fields are read from `extra`; identity and anchor are floored (resolution is
 * follow-up work).
 *
 * @internal
 */
export function buildToolContext(
  serverCtx: McpServerContext,
  meta: McpToolMeta,
  extra: McpExtra,
): McpToolContext {
  const info = clientInfoOf(extra);

  return createToolContext(
    {
      ...serverCtx,
      // Floored — anchor + identity resolution is follow-up work.
      anchor: { type: 'anonymous', value: '' },
      identity: { resolvedFrom: 'anonymous' },
      client: { name: info?.name, version: info?.version, userAgent: readHeader(extra, 'user-agent') },
    },
    meta,
    { request: { method: 'tools/call' } },
  );
}
