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
  ListToolsResult,
  ServerNotification,
  ServerRequest,
  ServerResult,
} from '@modelcontextprotocol/sdk/types.js';

/** The SDK's per-request handler `extra`, server-side. Alias for the generics. */
export type McpExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** An MCP tool handler's return — a tool result, sync or async. */
export type ToolResult = CallToolResult | Promise<CallToolResult>;

/**
 * An MCP tool handler, as registered with `server.tool(name, schema, fn)`:
 * `(args, extra)` with an input schema, `(extra)` without.
 */
export type ToolHandler<Args extends unknown[], R extends ToolResult> = (...args: Args) => R;

/** A request handler as stored on the low-level {@link Server}: a parsed request
 *  plus `extra`, returning a server result (sync or async). */
export type ServerRequestHandler = (
  request: ServerRequest,
  extra: McpExtra,
) => ServerResult | Promise<ServerResult>;

// Re-exported SDK server/transport/result types so the rest of `core/` reads
// them from this one adapter rather than reaching into SDK subpaths directly.
export type { CallToolResult, ListToolsResult, McpServer, Server, ServerResult, Transport };

/**
 * The low-level {@link Server}'s request-handler registry. It's a private SDK
 * field with no public accessor, so reading it (to wrap a built-in handler such
 * as `tools/list`) is an explicit, isolated escape hatch — kept here in the
 * adapter rather than reached for across `core/`. Returns `undefined` if the SDK
 * shape ever changes.
 * @internal
 */
export function getRequestHandlers(
  server: Server,
): Map<string, ServerRequestHandler> | undefined {
  // `_requestHandlers` is private on `Server`, so this reaches past the public
  // type deliberately — the one place in the SDK adapter that does so.
  const map = (server as unknown as { _requestHandlers?: Map<string, ServerRequestHandler> })
    ._requestHandlers;
  return map != null && typeof map.get === 'function' ? map : undefined;
}

/**
 * An attempted tool name's state in the high-level server's registry.
 * `undefined` from {@link lookupRegisteredTool} means "could not tell".
 */
export type RegisteredToolState = 'missing' | 'disabled' | 'enabled';

/**
 * Look up an attempted `tools/call` name in the high-level {@link McpServer}'s
 * tool registry, to tell a call the server rejected apart from one that ran.
 *
 * Like {@link getRequestHandlers} this reads a private SDK field, and is kept
 * here in the adapter for that reason. Returns `undefined` when the registry
 * cannot be read at all — a low-level {@link Server} (which has none) or an SDK
 * shape change — so callers fall back to weaker evidence rather than treating
 * "unreadable" as "missing".
 *
 * @internal
 */
export function lookupRegisteredTool(
  server: McpServerLike,
  name: string | undefined,
): RegisteredToolState | undefined {
  if (name == null) return undefined;

  // `_registeredTools` is private on `McpServer`; absent on the low-level Server.
  const registry = (
    server as unknown as { _registeredTools?: Record<string, { enabled?: boolean } | undefined> }
  )._registeredTools;
  if (registry == null || typeof registry !== 'object') return undefined;

  if (!Object.prototype.hasOwnProperty.call(registry, name)) return 'missing';
  // `enabled` has been present since the SDK gained `tool.disable()`; treat an
  // absent flag as live rather than inventing a disabled state.
  return registry[name]?.enabled === false ? 'disabled' : 'enabled';
}

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
