/**
 * Intercept the MCP server's `tools/list` request handler so the SDK can emit
 * `[MCP] Tools Listed` without the consumer changing anything.
 *
 * The high-level `McpServer` registers a single `tools/list` handler on the
 * low-level `Server` the first time a tool is registered; that closure
 * enumerates the *live* tool set at call time, so wrapping it once (at connect,
 * when every handler is present) keeps counting correctly even as tools are
 * added or removed later.
 */
import { isPromise } from '../utils/common.js';
import {
  getRequestHandlers,
  type ListToolsResult,
  type McpExtra,
  type Server,
  type ServerRequestHandler,
} from './mcp.js';

/** Marks a wrapped handler so a second install is a no-op. */
const WRAPPED = Symbol.for('amplitude.mcp.toolsListWrapped');

/** What one `tools/list` request produced — its result, or the error it threw. */
export interface ToolsListOutcome {
  result?: ListToolsResult;
  error?: unknown;
  durationMs: number;
}

/**
 * Wrap the server's registered `tools/list` handler so each request reports its
 * outcome (success or failure) to `onListed` with the request `extra`. The
 * handler's behavior is unchanged — its result/throw pass through untouched.
 * Best-effort and idempotent: a no-op if the SDK shape is unrecognized or no
 * `tools/list` handler is registered yet.
 *
 * @internal
 */
export function installToolsListHook(
  server: Server,
  onListed: (outcome: ToolsListOutcome, extra: McpExtra) => void,
): void {
  const handlers = getRequestHandlers(server);
  if (handlers == null) return;

  const original = handlers.get('tools/list');
  if (original == null || (original as ServerRequestHandler & { [WRAPPED]?: boolean })[WRAPPED]) {
    return;
  }

  const wrapped: ServerRequestHandler = (request, extra) => {
    const start = performance.now();
    const report = (outcome: { result?: ListToolsResult; error?: unknown }): void => {
      try {
        onListed({ ...outcome, durationMs: performance.now() - start }, extra);
      } catch {
        // Telemetry is best-effort — never let it break the tools/list response.
      }
    };

    let out: ReturnType<ServerRequestHandler>;
    try {
      out = original(request, extra);
    } catch (error) {
      report({ error });
      throw error;
    }
    if (isPromise(out)) {
      return out.then(
        (res) => {
          report({ result: res as ListToolsResult });
          return res;
        },
        (error) => {
          report({ error });
          throw error;
        },
      );
    }
    report({ result: out as ListToolsResult });
    return out;
  };
  (wrapped as ServerRequestHandler & { [WRAPPED]?: boolean })[WRAPPED] = true;
  handlers.set('tools/list', wrapped);
}
