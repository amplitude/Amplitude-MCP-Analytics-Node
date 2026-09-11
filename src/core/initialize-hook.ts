/**
 * Intercept the MCP server's `initialize` request handler, so the SDK sees the
 * client's `clientInfo` on the request that actually carries it.
 *
 * Why not `oninitialized`: that callback fires on the `notifications/initialized`
 * **notification**, which is a separate message from the `initialize` **request**
 * that carries `clientInfo` (the SDK stores it in `_oninitialize` and exposes it
 * via `getClientVersion()`). On stdio and session-bearing Streamable HTTP one
 * server instance handles both, so reading it at `oninitialized` works. On
 * sessionless Streamable HTTP it does not: hosts serve each request from a
 * fresh transport (and so a fresh server) there, so the two messages land on
 * two different instances and the one running `oninitialized` never saw the
 * handshake. The result was `[MCP] Client Name: unknown` on every event from
 * such a server.
 *
 * Newer SDKs enforce that shape by throwing when a sessionless transport is
 * reused; 1.14.0, the floor of our peer range, permits reuse. This hook does
 * not depend on which: it reads `clientInfo` off the request that carries it
 * either way.
 *
 * Wrapping the request handler instead is transport-agnostic and needs no
 * cross-request state, which is what makes it work on per-request and
 * serverless hosts too.
 */
import { isPromise } from '../utils/common.js';
import type { Implementation } from '@modelcontextprotocol/sdk/types.js';
import {
  getRequestHandlers,
  type McpExtra,
  type Server,
  type ServerRequestHandler,
} from './mcp.js';

/** Marks a wrapped handler so a second install is a no-op. */
const WRAPPED = Symbol.for('amplitude.mcp.initializeWrapped');

/**
 * Wrap the server's registered `initialize` handler so each successful
 * handshake reports the client's `clientInfo` (when it sent any) plus the
 * request `extra`. The handler's behavior is unchanged — its result/throw pass
 * through untouched — and a failed handshake reports nothing.
 *
 * Returns `true` when the hook was installed. A `false` return means the SDK
 * shape was unrecognized and the caller should keep using its `oninitialized`
 * fallback; callers must not do both, or per-request hosts double-emit.
 *
 * @internal
 */
export function installInitializeHook(
  server: Server,
  onInitialize: (clientInfo: Implementation | undefined, extra: McpExtra) => void,
): boolean {
  const handlers = getRequestHandlers(server);
  if (handlers == null) return false;

  const original = handlers.get('initialize');
  if (original == null) return false;
  if ((original as ServerRequestHandler & { [WRAPPED]?: boolean })[WRAPPED]) return true;

  const wrapped: ServerRequestHandler = (request, extra) => {
    // Read `clientInfo` off the request before delegating: the params are the
    // only place it exists, and the handler does not echo it back.
    const params = (request as { params?: { clientInfo?: unknown } }).params;
    const info = params?.clientInfo;
    const clientInfo = info != null && typeof info === 'object'
      ? (info as Implementation)
      : undefined;

    const report = (): void => {
      try {
        onInitialize(clientInfo, extra);
      } catch {
        // Telemetry is best-effort — never let it break the handshake.
      }
    };

    // Report only after the handshake succeeds, so a rejected `initialize`
    // (unsupported params) does not look like a completed session. A throw or
    // rejection propagates untouched and reports nothing.
    const out = original(request, extra);
    if (isPromise(out)) {
      return out.then((res) => {
        report();
        return res;
      });
    }
    report();
    return out;
  };
  (wrapped as ServerRequestHandler & { [WRAPPED]?: boolean })[WRAPPED] = true;
  handlers.set('initialize', wrapped);
  return true;
}
