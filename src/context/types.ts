/**
 * Type definitions for the shared per-invocation MCP context (`ctx`) — the
 * seam every event derives its shared properties from. Load-bearing but not
 * frozen: the shape (server-scope base + tool-scope extension) is stable;
 * individual fields may still move.
 */

/** Which fallback level produced the resolved subject, for debuggability. */
export type IdentityResolvedFrom = 'userId' | 'auth' | 'anchor' | 'anonymous';

/**
 * Correlation-anchor source: stdio = process; legacy HTTP = session id;
 * stateless HTTP = trace -> anonymous floor. No session id is ever assumed.
 */
export type AnchorType = 'session-id' | 'trace' | 'process' | 'anonymous';

/** MCP transport. */
export type McpTransport = 'stdio' | 'streamable-http';

/** Operator/tenant — who owns the data. Maps to an Amplitude group. */
export interface McpTenant {
  groupType: string;
  groupValue: string;
}

/** Resolved subject identity (always emits; `anonymous` is the floor). */
export interface McpIdentity {
  userId?: string;
  deviceId?: string;
  resolvedFrom: IdentityResolvedFrom;
}

/** Correlation anchor. */
export interface McpAnchor {
  type: AnchorType;
  value: string;
}

/** MCP client info — a dimension, NOT identity. */
export interface McpClientInfo {
  /** Protocol `clientInfo.name` from the handshake / `_meta` (e.g. `"cursor"`). */
  name?: string;
  version?: string;
  /** Raw HTTP `User-Agent` (streamable-http only). */
  userAgent?: string;
}

/** MCP server identity — attached to every event. */
export interface McpServerInfo {
  name: string;
  version?: string;
  /** Server type for parity; value range TBD by the event-contract audit. */
  type?: string;
}

/** Server/connection-scope context — the base every event shares. */
export interface McpServerContext {
  /** @public */
  tenant?: McpTenant;
  /** @public */
  identity: McpIdentity;
  /** @public */
  anchor: McpAnchor;
  /** Request trace id (distributed tracing) as a distinct property; independent
   *  of `anchor`, though equal to `anchor.value` when `anchor.type` is `trace`. @public */
  traceId?: string;
  /** @public */
  transport: McpTransport;
  /** Negotiated MCP protocol version. @public */
  protocolVersion?: string;
  /** @public */
  client?: McpClientInfo;
  /** @public */
  server: McpServerInfo;
  /** How the subject authenticated; values are server-specific (e.g. `"OAuth"`). @public */
  authType?: string;
  /** Mutable enrichment bag for domain values without a top-level field. @public */
  extra?: Record<string, unknown>;
}

/** Tool metadata the caller attaches when instrumenting a tool. */
export interface McpToolMeta {
  name: string;
  owner?: string;

  /** Free-form metadata; forward-compatible and the home for server-specific
   *  fields (e.g. Amplitude's project id/name). */
  [key: string]: unknown;
}

/**
 * MCP protocol JSON-RPC method names (server-agnostic). Curated to the
 * execution requests this tool-scope context describes; widening is
 * non-breaking.
 */
export type McpRequestMethod =
  | 'tools/call'
  | 'tools/list'
  | 'resources/read'
  | 'resources/list'
  | 'prompts/get'
  | 'prompts/list';

/** Per-request shape/size info — feeds duration/size properties on events. */
export interface McpRequestInfo {
  method?: McpRequestMethod;
  sizeBytes?: number;
}

/**
 * Tool-invocation-scope context — extends the server context with the tool,
 * request info, and an error slot. Handed to instrumented tool handlers.
 */
export interface McpToolContext extends McpServerContext {
  /** @public */
  tool: McpToolMeta;
  /** @public */
  request?: McpRequestInfo;
  /** Populated on failure; shape TBD. @public */
  error?: unknown;
}
