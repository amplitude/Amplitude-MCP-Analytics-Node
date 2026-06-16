/**
 * Adapter over `@modelcontextprotocol/sdk`: type aliases + safe `extra` readers.
 * We use the SDK's own types (it's a peer dependency every MCP server has).
 *
 * Minimum SDK 1.14.0 — earliest with both `_meta` and `requestInfo` on
 * `RequestHandlerExtra` (the fields read below; see the peer range in package.json).
 */
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';

/** The SDK's per-request handler `extra`, server-side. Alias for the generics. */
export type McpExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** An MCP tool handler's return — a tool result, sync or async. */
export type ToolResult = CallToolResult | Promise<CallToolResult>;

// Re-exported SDK server/transport types so the rest of `core/` reads them from
// this one adapter rather than reaching into SDK subpaths directly.
export type { McpServer, Server, Transport };

/**
 * A server we can instrument: the high-level {@link McpServer} (owns a
 * {@link Server} as `.server`) or a low-level {@link Server}. `isConnected()` is
 * only on the former; the handshake hooks (`oninitialized` / `getClientVersion`)
 * only on the latter — callers narrow with `in`.
 */
export type McpServerLike = McpServer | Server;

/**
 * The request `_meta` bag as an untyped record (open protocol set — clientInfo,
 * protocol version, `traceparent`, server-specific keys). Read a field via
 * `metaRecord(extra)?.[key]` and narrow. (`extra.sessionId`/`authInfo` are typed.)
 * 
 * @internal
 */
export function metaRecord(extra: McpExtra): Record<string, unknown> | undefined {
  return extra._meta as Record<string, unknown> | undefined;
}

/** Case-insensitive single-value HTTP header read (Streamable HTTP only). @internal */
export function readHeader(extra: McpExtra, name: string): string | undefined {
  const headers = extra.requestInfo?.headers;
  if (!headers) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name.toLowerCase()) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}
