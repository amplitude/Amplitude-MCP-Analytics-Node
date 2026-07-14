/**
 * Per-instrumented-server analytics scope.
 *
 * `instrumentServer` used to keep the bound server context (and the
 * handshake state) as fields on the singleton client. That is correct for
 * the canonical topology — one long-lived `McpServer` per process/session —
 * but races in per-request-server hosts (a new `McpServer` per HTTP
 * request): concurrent requests overwrite each other's scope, so any
 * per-connection value passed to `instrumentServer` could be attributed to
 * the wrong request.
 *
 * The fix: each `instrumentServer` call owns a {@link ServerScope} object.
 * The connect-installed hooks (handshake, tools/list, close) close over it
 * directly, and {@link installServerScopeDispatch} wraps the low-level
 * server's request handlers so everything dispatched by that server —
 * including `instrumentTool`-wrapped tool callbacks — runs inside an
 * AsyncLocalStorage frame carrying the scope. `instrumentTool` resolves
 * {@link currentServerScope} first and falls back to the singleton fields,
 * which keeps direct (non-dispatch) invocation working unchanged.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { McpServerContext } from '../context/types.js';
import type { ServerIdentity } from './identity.js';
import { getRequestHandlers, type Server } from './mcp.js';

/** Marks a handler map already dispatch-wrapped, to stay idempotent. */
const SCOPE_WRAPPED = Symbol.for('amplitude.mcp.serverScopeWrapped');

/** Analytics state owned by one `instrumentServer(server)` binding. @internal */
export interface ServerScope {
  /** The server-scope ctx, set by the wrapped `connect` and resolved into
   *  its connection form at the handshake. */
  ctx?: McpServerContext;
  /** Identity from `instrumentServer` opts — per-connection safe. */
  identity?: ServerIdentity;
  /** Handshake timestamp (ms) — doubles as the "a session is active" flag
   *  for THIS server's transport. */
  sessionStartMs?: number;
}

const storage = new AsyncLocalStorage<ServerScope>();

/** Run `fn` with `scope` as the ambient server scope. @internal */
export function runWithServerScope<T>(scope: ServerScope, fn: () => T): T {
  return storage.run(scope, fn);
}

/** The ambient server scope, or `undefined` outside a dispatch frame. @internal */
export function currentServerScope(): ServerScope | undefined {
  return storage.getStore();
}

/**
 * Wrap every request handler registered on the low-level server so it runs
 * inside `scope`'s AsyncLocalStorage frame. Called from the wrapped
 * `connect` — every handler is registered by then. Handlers registered
 * after connect are not wrapped (they fall back to the singleton scope).
 * Best-effort and idempotent; a no-op if the SDK shape is unrecognized.
 *
 * @internal
 */
export function installServerScopeDispatch(server: Server, scope: ServerScope): void {
  const handlers = getRequestHandlers(server);
  if (handlers == null) return;

  const marked = handlers as typeof handlers & { [SCOPE_WRAPPED]?: boolean };
  if (marked[SCOPE_WRAPPED]) return;
  marked[SCOPE_WRAPPED] = true;

  for (const [method, handler] of handlers) {
    handlers.set(method, (request, extra) =>
      runWithServerScope(scope, () => handler(request, extra)),
    );
  }
}
