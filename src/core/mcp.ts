/**
 * Adapter over the MCP server the host already has. v1
 * (`@modelcontextprotocol/sdk`) and v2 (`@modelcontextprotocol/server`) are
 * different packages, so nothing here imports either one: the published
 * declarations stay free of both, and a project that installed only one of
 * them still typechecks.
 *
 * The fork between the two lines stays in {@link readRequest}. Everything else
 * reads the normalized view. v1's per-request object is `extra` (`_meta`,
 * `sessionId`, `requestId`, `authInfo`, `requestInfo.headers`). v2's is `ctx`
 * (`mcpReq._meta`, `mcpReq.envelope`, `mcpReq.id`, `sessionId`,
 * `http.authInfo`, `http.req.headers` as a Web `Headers`).
 *
 * Minimum v1 release for the fields above is 1.14.0 — earliest with both
 * `_meta` and `requestInfo` (see the peer range in package.json).
 */

/**
 * A tool result this SDK builds: text content, optionally flagged as an error.
 * The index signature is what makes a value of this type assignable to the
 * MCP SDK's `CallToolResult`, which is a loose object (`[key: string]: unknown`).
 */
export interface CallToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/**
 * The slice of a tool result `instrumentTool` requires. Both lines' results
 * satisfy it; handlers may return a richer result than the text shape above.
 */
export interface ToolResultBody {
  content?: unknown;
  isError?: boolean;
}

/** An MCP tool handler's return — a tool result, sync or async. */
export type ToolResult = ToolResultBody | Promise<ToolResultBody>;

/**
 * An MCP tool handler, as registered with the server: `(args, extra)` with an
 * input schema, `(extra)` without. The last argument is the per-request
 * context — v1 `extra` or v2 `ctx`.
 */
export type ToolHandler<Args extends unknown[], R extends ToolResult> = (...args: Args) => R;

/**
 * Per-request context handed to a tool callback. Every field is optional so a
 * v1 `extra` and a v2 `ctx` are both assignable. Read the fields through
 * {@link readRequest}; call sites do not branch on which line produced the object.
 */
export interface McpExtra {
  sessionId?: string;
  requestId?: string | number;
  _meta?: object;
  authInfo?: object;
  requestInfo?: object;
  mcpReq?: object;
  http?: object;
}

/**
 * A server we can instrument: the high-level server (either line; owns a
 * low-level server as `.server`) or the low-level server itself.
 * `isConnected()` and `registerTool` exist only on the high-level server; the
 * handshake hooks (`oninitialized` / `getClientVersion`) only on the low-level
 * one.
 */
export interface McpServerLike {
  connect(transport: object): Promise<void>;
  /** Low-level server. Present on the high-level server of either line. */
  server?: McpServerLike;
  isConnected?(): boolean;
  onclose?: () => void;
  oninitialized?: () => void;
  getClientVersion?(): { name?: string; version?: string } | undefined;
  /**
   * Present on the high-level server. The two SDK lines overload this
   * differently, so the signature stays out of this type; feedback registration
   * narrows it locally.
   */
  registerTool?: unknown;
}

/**
 * Which server package this object comes from. v2 has no `.tool()` and its
 * low-level server exposes `buildContext`. Anything else, including a server
 * we cannot classify, stays on the v1 path.
 * @internal
 */
export type ServerLine = 'v1' | 'v2';

/**
 * Tell a v1 server from a v2 server without importing either package.
 * Handler hooks do not branch on this — they still wrap the private
 * request-handler map, which both lines keep.
 * @internal
 */
export function detectServerLine(server: object): ServerLine {
  if (typeof (server as { tool?: unknown }).tool === 'function') return 'v1';
  const nested = (server as { server?: unknown }).server;
  const lowLevel = nested != null && typeof nested === 'object' ? nested : server;
  return typeof (lowLevel as { buildContext?: unknown }).buildContext === 'function' ? 'v2' : 'v1';
}

/** A request handler as stored on the low-level server. @internal */
export type ServerRequestHandler = (request: unknown, extra: McpExtra) => unknown;

/**
 * The low-level server's request-handler registry. It's a private field with
 * no public accessor, so reading it (to wrap a built-in handler such as
 * `tools/list`) is an explicit, isolated escape hatch — kept here rather than
 * reached for across `core/`. Returns `undefined` if the shape ever changes.
 * v2 still keeps this map; the hooks no-op when it is absent.
 * @internal
 */
export function getRequestHandlers(
  server: object,
): Map<string, ServerRequestHandler> | undefined {
  const map = (server as { _requestHandlers?: Map<string, ServerRequestHandler> })._requestHandlers;
  return map != null && typeof map.get === 'function' ? map : undefined;
}

/**
 * An attempted tool name's state in the high-level server's registry.
 * `undefined` from {@link lookupRegisteredTool} means "could not tell".
 */
export type RegisteredToolState = 'missing' | 'disabled' | 'enabled';

/**
 * Look up an attempted `tools/call` name in the high-level server's tool
 * registry, to tell a call the server rejected apart from one that ran.
 *
 * Like {@link getRequestHandlers} this reads a private field, and is kept
 * here for that reason. Returns `undefined` when the registry cannot be read
 * at all — a low-level server (which has none) or a shape change — so callers
 * fall back to weaker evidence rather than treating "unreadable" as "missing".
 * v2's registry is the same plain object with an `enabled` flag.
 *
 * @internal
 */
export function lookupRegisteredTool(
  server: object,
  name: string | undefined,
): RegisteredToolState | undefined {
  if (name == null) return undefined;

  const registry = (server as { _registeredTools?: Record<string, { enabled?: boolean } | undefined> })
    ._registeredTools;
  if (registry == null || typeof registry !== 'object') return undefined;

  if (!Object.prototype.hasOwnProperty.call(registry, name)) return 'missing';
  // `enabled` has been present since the SDK gained `tool.disable()`; treat an
  // absent flag as live rather than inventing a disabled state.
  return registry[name]?.enabled === false ? 'disabled' : 'enabled';
}

/** One request, with the v1/v2 field move already applied. @internal */
export interface NormalizedRequest {
  /** Caller `_meta`. On v2 this does not include the reserved envelope keys. */
  meta: Record<string, unknown> | undefined;
  /**
   * v2 `mcpReq.envelope` — the reserved `io.modelcontextprotocol/*` keys.
   * Always `undefined` on v1.
   */
  envelope: Record<string, unknown> | undefined;
  /** Non-empty string, or absent. A non-string id is dropped, not coerced. */
  sessionId: string | undefined;
  /** JSON-RPC id. v1 `requestId`, v2 `mcpReq.id`. */
  requestId: string | number | undefined;
  /** v1 `authInfo`, v2 `http.authInfo`. */
  authInfo: Record<string, unknown> | undefined;
  /**
   * Header bag for a host resolver. v1 is the transport's record (array
   * values preserved). v2 is the Web `Headers` copied to a record.
   */
  headers: Record<string, string | string[] | undefined> | undefined;
  /**
   * The request itself carried HTTP evidence (`requestInfo` on v1, `http` on
   * v2). Independent of how the transport object was classified at connect.
   */
  isHttp: boolean;
  /** Case-insensitive single-value header read. Never throws. */
  header(name: string): string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHeaders(value: unknown): value is Headers {
  return typeof globalThis.Headers === 'function' && value instanceof Headers;
}

function emptyRequest(): NormalizedRequest {
  return {
    meta: undefined,
    envelope: undefined,
    sessionId: undefined,
    requestId: undefined,
    authInfo: undefined,
    headers: undefined,
    isHttp: false,
    header: () => undefined,
  };
}

function readRequestId(value: unknown): string | number | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

function readSessionId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** First matching header. v1 arrays contribute their first entry, matching the historical read. */
function readHeaderValue(source: unknown, name: string): string | undefined {
  if (isHeaders(source)) {
    const value = source.get(name);
    return value == null ? undefined : value;
  }
  if (!isRecord(source)) return undefined;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(source)) {
    if (key.toLowerCase() !== target) continue;
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
    return undefined;
  }
  return undefined;
}

/**
 * Header record passed to a host resolver. A Web `Headers` is copied; a plain
 * record is returned as-is so a v1 array-valued header is unchanged.
 */
function headersRecord(source: unknown): Record<string, string | string[] | undefined> | undefined {
  if (isHeaders(source)) {
    const out: Record<string, string | string[] | undefined> = {};
    source.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (!isRecord(source)) return undefined;
  return source as Record<string, string | string[] | undefined>;
}

/**
 * Normalize a v1 `extra` or a v2 `ctx`. v2 is detected by an object `mcpReq`.
 * Best-effort: a throwing getter or an unrecognized value yields an empty
 * request rather than an exception. Never throws.
 * @internal
 */
export function readRequest(extraOrCtx: unknown): NormalizedRequest {
  try {
    if (!isRecord(extraOrCtx)) return emptyRequest();

    const mcpReq = isRecord(extraOrCtx.mcpReq) ? extraOrCtx.mcpReq : undefined;
    const http = mcpReq != null && isRecord(extraOrCtx.http) ? extraOrCtx.http : undefined;
    const requestInfo = mcpReq == null && isRecord(extraOrCtx.requestInfo) ? extraOrCtx.requestInfo : undefined;
    const httpReq = http != null && isRecord(http.req) ? http.req : undefined;
    const headerSource = mcpReq != null ? httpReq?.headers : requestInfo?.headers;
    const metaRaw = mcpReq != null ? mcpReq._meta : extraOrCtx._meta;
    const envelopeRaw = mcpReq != null ? mcpReq.envelope : undefined;
    const authRaw = mcpReq != null ? http?.authInfo : extraOrCtx.authInfo;

    return {
      meta: isRecord(metaRaw) ? metaRaw : undefined,
      envelope: isRecord(envelopeRaw) ? envelopeRaw : undefined,
      sessionId: readSessionId(extraOrCtx.sessionId),
      requestId: readRequestId(mcpReq != null ? mcpReq.id : extraOrCtx.requestId),
      authInfo: isRecord(authRaw) ? authRaw : undefined,
      headers: headersRecord(headerSource),
      isHttp: http != null || requestInfo != null,
      header: (name: string) => {
        try {
          return readHeaderValue(headerSource, name);
        } catch {
          return undefined;
        }
      },
    };
  } catch {
    return emptyRequest();
  }
}
