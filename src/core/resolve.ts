/**
 * Internal request→ctx resolvers: given the live SDK `extra` (plus the
 * server-scope transport), each resolves one ctx field. `buildToolContext` is
 * the sole consumer. Identity resolution (which consumes the anchor) lands here
 * as an additional resolver in a later track.
 *
 * Transport/protocol seam — "legacy-complete, stateless-ready": the legacy path
 * (`2025-11-25`, all current traffic) is live. The stateless (`2026-07-28+`)
 * path is coded and fixture-tested but never taken in prod — the branch points
 * are structural (the stateless branches are only reached without a session id /
 * with `_meta` the legacy SDK never sends), so it activates on its own once the
 * SDK speaks the stateless transport.
 *
 * @internal
 */
import { randomUUID } from 'node:crypto';
import type { McpAnchor, McpTransport } from '../context/types.js';
import { metaRecord, readHeader, type McpExtra, type Transport } from './mcp.js';

/**
 * Classify the transport passed to `server.connect()` (server-scope). The param
 * is the SDK's `Transport` — exactly what `connect` accepts, i.e. any transport
 * implementation. The concrete transport classes implement that interface; only
 * `StreamableHTTPServerTransport` adds a `handleRequest` method (not on the
 * `Transport` interface), which we probe at runtime (structural, not `instanceof`
 * — we never value-import the concrete classes, keeping the peer range wide and
 * dodging the dual-package hazard). Anything else is `stdio` (no session-id
 * assumption). @internal
 */
export function resolveTransport(transport: Transport): McpTransport {
  if ('handleRequest' in transport && typeof transport.handleRequest === 'function') {
    return 'streamable-http';
  }
  return 'stdio';
}

/**
 * Negotiated protocol version for one request: the `MCP-Protocol-Version` header
 * (legacy + stateless HTTP), else `_meta.protocolVersion` (stateless). Undefined
 * over stdio (carried at the handshake). @internal
 */
export function resolveProtocolVersion(extra: McpExtra): string | undefined {
  const header = readHeader(extra, 'mcp-protocol-version');
  if (header != null) return header;
  const versionFromMeta = metaRecord(extra)?.protocolVersion;
  return typeof versionFromMeta === 'string' ? versionFromMeta : undefined;
}

/**
 * Parse the trace-id (2nd field, 32 hex chars) from the W3C `traceparent` in
 * `_meta`: `version-traceid-parentid-flags`. Undefined if absent, malformed, or
 * all-zero. @internal
 */
export function parseTraceId(traceparent: string | undefined): string | undefined {
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
export function resolveAnchor(transport: McpTransport, extra: McpExtra): McpAnchor {
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
  return { type: 'anonymous', value: randomUUID() };
}
