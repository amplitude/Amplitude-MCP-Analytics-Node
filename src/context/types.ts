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

/** Resolved subject identity; `anonymous` is the per-request floor (gated at
 *  emit time by `config.emitAnonymousEvent` — see `shouldEmit`). */
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
  /**
   * Protocol `clientInfo.name` (e.g. `"cursor"`).
   *
   * Through protocol revision `2025-11-25` this is carried **only** on the
   * `initialize` request, with no per-request copy, so on transports where
   * each request gets a fresh server it has to be supplied per request via
   * {@link ClientInfoResolver} or bound via `instrumentServer({ client })`.
   * Revision `2026-07-28` removes the handshake and carries client identity in
   * every request's `_meta` instead, which the SDK reads when present.
   */
  name?: string;
  version?: string;
  /** Raw HTTP `User-Agent` (streamable-http only). */
  userAgent?: string;
  /**
   * OAuth 2.0 `client_id` for the calling client, read from `extra.authInfo`.
   *
   * This identifies a client **registration**, not a product: under dynamic
   * client registration (RFC 7591) the same client gets a different id per
   * authorization server, and potentially one per install. It is therefore
   * kept off {@link name}, which stays a low-cardinality product dimension —
   * mixing opaque ids into it would make the property useless for
   * segmentation and non-comparable across servers.
   *
   * Unlike {@link name} it *is* available on every authenticated request, so
   * it is the one client identifier a sessionless server can report with no
   * host-side state, and the natural join key for mapping ids to names.
   *
   * Resolved from `extra.authInfo.clientId`, and absent on an unauthenticated
   * request. A {@link ClientInfoResolver} may supply it instead, for a host
   * whose auth does not populate `authInfo` — it is never inherited from the
   * connection, so it always describes the request it is emitted on.
   */
  oauthClientId?: string;
}

/** Inputs to {@link ClientInfoResolver}. SDK-free, like {@link IdentityResolver}. */
export interface ResolveClientInfoInput {
  /** `extra.authInfo` for this request — OAuth claims, including `clientId`. */
  authInfo?: Record<string, unknown>;
  /** Request headers (Streamable HTTP only); absent over stdio. */
  headers?: Record<string, string | string[] | undefined>;
}

/**
 * Callback that resolves MCP client info per request.
 *
 * Through protocol revision `2025-11-25` the client's `clientInfo` is carried
 * only on the `initialize` request, so a host whose transport serves each
 * request from a fresh server (sessionless Streamable HTTP, serverless) cannot
 * get the client name from the wire on a `tools/call`. This is the hook for
 * supplying it from something that *is* per-request — a token claim (an
 * authorization server learns `client_name` at client registration), or a
 * header. On revision `2026-07-28`, where every request carries client identity
 * in `_meta`, this instead acts as an override for that value.
 *
 * Return `undefined`, or an object with the fields you know, to fall through to
 * the SDK's own resolution for the rest.
 */
export type ClientInfoResolver = (input: ResolveClientInfoInput) => McpClientInfo | undefined;

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
  /**
   * Resolved from `config.emitAnonymousEvent`, stamped at context creation so
   * the emit gate ({@link import('../tracking/ctx-to-properties.js').shouldEmit})
   * can honor it without threading config through every emit path. When
   * truthy, the fully anonymous, tenant-less floor still emits.
   * @internal
   */
  emitAnonymousEvent?: boolean;
}

/**
 * Parameter-capture policy for one instrumented tool.
 *
 * Shape capture is controlled globally by `MCPAnalyticsConfig`; this policy
 * provides tool-specific exclusions, route discrimination, and derived facts.
 */
export interface ToolParamCapture {
  /** Safe enum/id-shaped parameter used to distinguish multiplexed routes. */
  routeKey?: string;
  /** Project parameters into bounded, chartable scalar facts. */
  derive?: (
    params: Record<string, unknown>,
  ) => Record<string, string | number | boolean>;
  /** Keys excluded from every parameter-capture tier for this tool. */
  never?: readonly string[];
}

/** Tool metadata the caller attaches when instrumenting a tool. */
export interface McpToolMeta {
  name: string;
  owner?: string;

  /**
   * Custom enrichment for this tool — its key/value pairs are carried on the ctx
   * and emitted as event properties on the default `[MCP] Tool Call Response`
   * event (the event's SDK-computed outcome values win on collision; avoid
   * `[MCP] `-prefixed keys, which are reserved for SDK-derived properties).
   */
  extra?: Record<string, unknown>;

  /** Parameter-capture policy for this tool. Absent means Tier 1 shape only. */
  paramCapture?: ToolParamCapture;

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
  /**
   * Host-supplied rationale for this invocation ("why the agent called this
   * tool") — set via {@link setRationale}, never sniffed from tool inputs by
   * the SDK. Emitted as the reserved `[MCP] Rationale` property on every
   * tool-scope event lowered from this ctx.
   */
  rationale?: string;
  /**
   * Transport-level HTTP status of the response to this call, emitted as the
   * reserved `[MCP] Response HTTP Status` property. Host-supplied — intended
   * for events a host emits itself for calls that failed before dispatch
   * (where the transport status actually varies). The instrumented-tool
   * wrapper never sets it: it emits when the handler settles, before the
   * response is written, and dispatched tool calls answer 200 anyway (tool
   * failures are in-band `isError` results; their HTTP class belongs on
   * `[MCP] Error HTTP Status` via {@link McpToolError.httpStatus}).
   */
  responseHttpStatus?: number;
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
