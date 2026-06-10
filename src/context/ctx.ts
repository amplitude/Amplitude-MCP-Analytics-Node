/**
 * The shared per-invocation MCP context object (`ctx`).
 *
 * `ctx` is the integration seam between every track: identity and
 * transport/anchor populate it; default events, custom events, and error
 * telemetry consume it. Every emitted event derives its shared/common
 * properties from `ctx` — no track should read transport/identity/auth state
 * directly.
 *
 * STATUS: load-bearing but NOT frozen. The field set here is the agreed
 * strawman; the producing tracks will refine it. Treat the *shape*
 * (server-scope base + tool-scope extension, factory-built with caller-wins
 * precedence) as stable; individual fields may still move.
 *
 * Threading model: explicit `ctx` is the public contract — `wrapTool` injects
 * it and the custom-event / error APIs take it as the first argument. An
 * optional `AsyncLocalStorage`-backed ambient accessor is a planned
 * convenience (see ./als.ts, deferred) — not the contract.
 */

/**
 * Which level of the identity fallback chain produced the resolved subject.
 * Recorded for debuggability — the #1 support question is "why is my event
 * missing a user id?".
 */
export type IdentityResolvedFrom = 'userId' | 'auth' | 'anchor' | 'anonymous';

/**
 * The correlation anchor used to stitch an invocation to a logical session:
 * stdio = process; legacy HTTP = session id; stateless HTTP = trace ->
 * anonymous floor. No session id is ever assumed.
 */
export type AnchorType = 'session-id' | 'trace' | 'process' | 'anonymous';

/** MCP transport. */
export type McpTransport = 'stdio' | 'streamable-http';

/**
 * Operator/tenant — *who owns the data*, distinct from the subject identity.
 * Maps to an Amplitude group, e.g. `{ groupType: 'org id', groupValue: '36958' }`.
 */
export interface McpTenant {
  groupType: string;
  groupValue: string;
}

/**
 * Resolved subject identity + how it was resolved. The fallback chain output
 * (always emits — `anonymous` is the floor, never absent).
 */
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
  name?: string;
  version?: string;
  userAgent?: string;
}

/** MCP server identity — attached to every event. */
export interface McpServerInfo {
  name: string;
  version?: string;
  type?: string;
}

/**
 * Minimal placeholder for the structured error that powers both the
 * client-facing MCP error and the telemetry event. The full typed taxonomy
 * (with hashed stacks) is owned by the error-telemetry track, which will
 * replace this shape.
 *
 * @internal not part of the stable public surface yet.
 */
export interface StructuredMcpError {
  message: string;
  type?: string;
  [key: string]: unknown;
}

/**
 * Server/connection-scope context. The base every event shares. Resolved
 * once per connection (or per request, in the stateless path).
 */
export interface McpServerContext {
  // operator / tenant (who owns the data)
  /** @public */
  tenant?: McpTenant;

  // resolved subject identity
  /** @public */
  identity: McpIdentity;

  // correlation anchor
  /** @public */
  anchor: McpAnchor;

  // protocol / transport
  /** @public */
  transport: McpTransport;
  /** From the `MCP-Protocol-Version` header (legacy) or `_meta` (stateless). @public */
  protocolVersion?: string;

  // client (dimension, not identity)
  /** @public */
  client?: McpClientInfo;

  // server
  /** @public */
  server: McpServerInfo;
}

/** Tool metadata attachable by the caller via `wrapTool`. */
export interface McpToolMeta {
  name: string;
  owner?: string;
  tags?: string[];
  category?: string;
  projectId?: string;
  projectName?: string;
  /** Free-form metadata; forward-compatible with future tool fields. */
  [key: string]: unknown;
}

/** Per-request shape/size info — feeds duration/size properties on events. */
export interface McpRequestInfo {
  method?: string;
  sizeBytes?: number;
}

/**
 * Tool-invocation-scope context. Extends the server context with the tool
 * being invoked, request info, and an error slot populated on failure.
 * This is the `ctx` handed to `wrapTool` handlers and the value the
 * tool/resource/prompt execution events derive their properties from.
 */
export interface McpToolContext extends McpServerContext {
  /** @public */
  tool: McpToolMeta;
  /** @public */
  request?: McpRequestInfo;
  /** Populated on failure; feeds error telemetry. @public */
  error?: StructuredMcpError;
}

/**
 * Inputs to {@link createServerContext}. `server` is required; everything
 * else is optional and falls back to a safe floor (anonymous identity,
 * anonymous anchor, stdio transport) so a context is always constructible.
 */
export interface CreateServerContextInput
  extends Partial<Omit<McpServerContext, 'server'>> {
  server: McpServerInfo;
}

/**
 * Build a server-scope context, filling unset fields with the always-emit
 * floor. Caller-supplied values win (caller > derived) — this factory only
 * fills what the caller left unset.
 */
export function createServerContext(input: CreateServerContextInput): McpServerContext {
  return {
    tenant: input.tenant,
    identity: input.identity ?? { resolvedFrom: 'anonymous' },
    anchor: input.anchor ?? { type: 'anonymous', value: '' },
    transport: input.transport ?? 'stdio',
    protocolVersion: input.protocolVersion,
    client: input.client,
    server: input.server,
  };
}

/**
 * Build a tool-scope context. Pass an existing server context to extend it
 * (the common path — `wrapTool` extends the connection context), or pass
 * server-context fields inline to build both at once.
 */
export function createToolContext(
  base: McpServerContext | CreateServerContextInput,
  tool: McpToolMeta,
  extra?: { request?: McpRequestInfo; error?: StructuredMcpError },
): McpToolContext {
  const server = isServerContext(base) ? base : createServerContext(base);
  return {
    ...server,
    tool,
    request: extra?.request,
    error: extra?.error,
  };
}

function isServerContext(
  base: McpServerContext | CreateServerContextInput,
): base is McpServerContext {
  // A resolved server context always has identity + anchor filled; a raw
  // factory input may not.
  return (
    'identity' in base &&
    base.identity != null &&
    'anchor' in base &&
    base.anchor != null
  );
}
