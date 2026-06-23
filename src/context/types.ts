/**
 * Type definitions for the shared per-invocation MCP context (`ctx`) — the
 * seam every event derives its shared properties from. Load-bearing but not
 * frozen: the shape (server-scope base + tool-scope extension) is stable;
 * individual fields may still move.
 *
 * Fields marked `@public` are part of the stable, semver-governed ctx contract.
 * Changing or removing a `@public` field is a breaking change. Fields without
 * that marker may still evolve before they are promoted.
 */

import type { McpToolError } from '../errors.js';

/** Which fallback level produced the resolved subject, for debuggability. */
export type IdentityResolvedFrom = 'explicit' | 'authInfo' | 'anchor' | 'anonymous';

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

/**
 * Consumer-facing input for {@link setIdentity} and the `resolveIdentity`
 * callback. All fields are optional — the SDK fills in the rest via the
 * fallback chain.
 */
export interface SetIdentityInput {
  userId?: string;
  deviceId?: string;
  tenant?: McpTenant;
}

/** Correlation anchor. */
export interface McpAnchor {
  type: AnchorType;
  value: string;
}

/**
 * Callback that resolves identity from `extra.authInfo`. For MCP servers using
 * the standard OAuth flow where `authInfo` carries the user's claims. The SDK
 * never guesses — the consumer specifies which claim maps to which field.
 */
export type IdentityResolver = (authInfo: Record<string, unknown> | undefined) => SetIdentityInput;

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
  /** Server classification; allowed values may expand in future releases. */
  type?: string;
}

/** Server/connection-scope context — the base every event shares. */
export interface McpServerContext {
  tenant?: McpTenant;
  identity: McpIdentity;
  anchor: McpAnchor;
  /** Server-scope MCP transport. @public */
  transport: McpTransport;
  /** Negotiated MCP protocol version. */
  protocolVersion?: string;
  client?: McpClientInfo;
  server: McpServerInfo;
  /** How the subject authenticated; values are server-specific (e.g. `"OAuth"`). */
  authType?: string;
  /** Mutable enrichment bag for domain values without a top-level field. @public */
  extra?: Record<string, unknown>;
}

/** Tool metadata the caller attaches when instrumenting a tool. */
export interface McpToolMeta {
  name: string;
  owner?: string;

  /**
   * Custom enrichment for this tool — its key/value pairs are carried on the ctx
   * and emitted as event properties on the default `mcp: tool call response`
   * event (reserved contract keys win on collision).
   */
  extra?: Record<string, unknown>;

  /** Free-form metadata; forward-compatible and the home for server-specific fields. */
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
  request?: McpRequestInfo;
  /** Populated on failure — classified by {@link classifyError} or {@link buildToolError}. */
  error?: McpToolError;
}
