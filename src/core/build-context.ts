/**
 * Build a tool-scope `ctx` from a live MCP request (internal). Reads the SDK
 * `extra` and composes the pure {@link createToolContext}. In `core/` (not the
 * SDK-free public `context/`) because it's SDK-aware and not public.
 */
import type { Implementation } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { createServerContext, createToolContext } from '../context/factory.js';
import type {
  ClientInfoResolver,
  IdentityResolver,
  McpAnchor,
  McpClientInfo,
  McpServerContext,
  McpToolContext,
  McpTransport,
  McpToolMeta,
} from '../context/types.js';
import { resolveIdentityFromChain, type ServerIdentity } from './identity.js';
import { metaRecord, readHeader, type McpExtra, type Transport } from './mcp.js';
import type { Logger } from '../utils/logger.js';

/**
 * Namespaced `_meta` keys defined by protocol revision `2026-07-28`, which
 * removed the `initialize` handshake and moved per-request client identity and
 * protocol version into `_meta`. Unnamespaced spellings are still accepted as a
 * secondary source, for hosts that adopted them before the keys were
 * standardized. @internal
 */
const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo';
const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';

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
 * Per-request client info, by descending precedence:
 *
 * 1. the host's {@link ClientInfoResolver} — the only source that can carry a
 *    client *name* on a transport that serves each request from a fresh server,
 *    so it wins;
 * 2. per-request `_meta` client info — `io.modelcontextprotocol/clientInfo`
 *    (see the note below);
 * 3. the `initialize` handshake, captured onto the server scope by
 *    `instrumentServer` — only reachable when one server instance serves the
 *    whole connection;
 * 4. the `User-Agent` header, which fills `userAgent` and never `name`.
 *
 * `oauthClientId` is separate: it comes off `authInfo`, so unlike the name it is
 * present on every authenticated request whatever the transport.
 *
 * A note on the `_meta` source. Protocol revision `2026-07-28` removes the
 * `initialize` handshake outright and instead has clients identify themselves
 * on **every** request, under the namespaced `_meta` key
 * `io.modelcontextprotocol/clientInfo` — so on that revision this is the only
 * source the wire provides, and the handshake source below cannot exist. No
 * shipped SDK speaks it yet (`@modelcontextprotocol/sdk` 1.30.0 tops out at
 * `2025-11-25`, where `clientInfo` appears only in `InitializeRequest.params`),
 * so it reads as absent today. The unnamespaced `clientInfo` is accepted as a
 * secondary spelling for hosts that adopted it as a local convention before the
 * key was standardized.
 * @internal
 */
function resolveRequestClientInfo(
  extra: McpExtra,
  serverCtx: McpServerContext,
  authInfo: Record<string, unknown> | undefined,
  resolveClientInfo: ClientInfoResolver | undefined,
  logger: Logger | undefined,
): McpClientInfo {
  let fromHost: McpClientInfo | undefined;
  if (resolveClientInfo != null) {
    try {
      fromHost =
        resolveClientInfo({
          authInfo,
          headers: extra.requestInfo?.headers as
            | Record<string, string | string[] | undefined>
            | undefined,
        }) ?? undefined;
    } catch (err) {
      logger?.warn(
        `resolveClientInfo callback threw: ${err instanceof Error ? err.message : String(err)} — falling back to the SDK's own client resolution.`,
      );
    }
  }

  const meta = metaRecord(extra);
  const info = meta?.[META_CLIENT_INFO] ?? meta?.clientInfo;
  const metaClientInfo = info != null && typeof info === 'object'
    ? (info as Implementation)
    : undefined;
  const clientFromHandshake = serverCtx.client;
  const clientIdFromAuth =
    typeof authInfo?.clientId === 'string' && authInfo.clientId.length > 0
      ? authInfo.clientId
      : undefined;

  return {
    name: fromHost?.name ?? metaClientInfo?.name ?? clientFromHandshake?.name,
    version: fromHost?.version ?? metaClientInfo?.version ?? clientFromHandshake?.version,
    userAgent:
      fromHost?.userAgent ?? readHeader(extra, 'user-agent') ?? clientFromHandshake?.userAgent,
    oauthClientId:
      fromHost?.oauthClientId ?? clientIdFromAuth ?? clientFromHandshake?.oauthClientId,
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
  const meta = metaRecord(extra);
  const fromMeta = meta?.[META_PROTOCOL_VERSION] ?? meta?.protocolVersion;
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
 * - **streamable-http, host-managed sessions** — a session-id anchor bound
 *   via `instrumentServer({ sessionId })` when the transport carries none.
 * - **streamable-http, stateless** (no session id anywhere) → W3C trace
 *   context if propagated, else an anonymous per-request floor
 *   (aggregate-only, no stitching).
 *
 * A session id is never assumed — its absence selects the stateless branch.
 * @internal
 */
let processAnchor: { pid: number; value: string } | undefined;

/**
 * The stdio anchor value for this process: the pid plus a per-process random
 * token, minted once and reused for the process lifetime.
 *
 * The pid **alone** is not a safe anchor value. It is a small integer recycled
 * per machine, so two unrelated servers on two different hosts that happened to
 * draw the same pid produced the same anchor key — and the anchor key is used
 * verbatim as `user_id` (`process:<pid>`) as well as hashed into `device_id`.
 * Distinct installations silently merged into one Amplitude user. The random
 * suffix makes the value globally unique while keeping the pid readable in
 * logs; process-lifetime correlation is unchanged.
 * @internal
 */
function processAnchorValue(): string {
  if (processAnchor?.pid !== process.pid) {
    processAnchor = { pid: process.pid, value: `${process.pid}-${randomUUID().replace(/-/g, '')}` };
  }

  return processAnchor.value;
}

function resolveAnchor(
  transport: McpTransport,
  extra: McpExtra,
  boundAnchor?: McpAnchor,
): McpAnchor {
  if (transport === 'stdio') {
    return { type: 'process', value: processAnchorValue() };
  }

  // Streamable HTTP — legacy if a session id was minted, else stateless.
  const sessionId = extra.sessionId;
  if (typeof sessionId === 'string' && sessionId.length > 0) {
    return { type: 'session-id', value: sessionId };
  }

  // Host-managed session bound on the server scope (per-request servers
  // whose session ids live in the host's own store, not on the transport).
  if (boundAnchor?.type === 'session-id' && boundAnchor.value.length > 0) {
    return boundAnchor;
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

/** Options for identity resolution in {@link buildServerContext} / {@link buildToolContext}. */
export interface BuildContextOpts {
  resolveIdentity?: IdentityResolver;
  /** Host callback for per-request client info — see {@link ClientInfoResolver}. */
  resolveClientInfo?: ClientInfoResolver;
  serverIdentity?: ServerIdentity;
  logger?: Logger;
}

/**
 * Extend the server-scope `serverCtx` with one request's resolved fields
 * (anchor, identity, protocol version, client info), without adding any tool
 * scope. Used by the per-request server events (e.g. `tools/list`). `transport`
 * is inherited from the server scope.
 * @internal
 */
export function buildServerContext(
  serverCtx: McpServerContext,
  extra: McpExtra,
  opts?: BuildContextOpts,
): McpServerContext {
  const resolvedAnchor = resolveAnchor(serverCtx.transport, extra, serverCtx.anchor);

  const authInfo = (extra as Record<string, unknown>).authInfo as
    | Record<string, unknown>
    | undefined;

  const resolved = resolveIdentityFromChain({
    resolveIdentity: opts?.resolveIdentity,
    authInfo,
    serverIdentity: opts?.serverIdentity,
    anchor: resolvedAnchor,
    logger: opts?.logger,
  });

  return createServerContext({
    ...serverCtx,
    anchor: resolvedAnchor,
    protocolVersion: resolveProtocolVersion(extra) ?? serverCtx.protocolVersion,
    identity: resolved.identity,
    tenant: resolved.tenant ?? serverCtx.tenant,
    client: resolveRequestClientInfo(
      extra,
      serverCtx,
      authInfo,
      opts?.resolveClientInfo,
      opts?.logger,
    ),
  });
}

/**
 * Extend the server-scope `serverCtx` with this request's fields. `transport` is
 * inherited from the server scope; per-request fields are resolved per request.
 * Identity is resolved via the fallback chain.
 * @internal
 */
export function buildToolContext(
  serverCtx: McpServerContext,
  meta: McpToolMeta,
  extra: McpExtra,
  opts?: BuildContextOpts,
): McpToolContext {
  return createToolContext(
    buildServerContext(serverCtx, extra, opts),
    meta,
    { request: { method: 'tools/call' } },
  );
}
