/**
 * Intercept the MCP server's `tools/call` request handler so the SDK can emit
 * `[MCP] Tool Call Rejected` for requests that fail before any tool callback
 * runs — an unknown or disabled tool name, or input-schema validation — where
 * the MCP SDK throws and the client receives a JSON-RPC error envelope instead
 * of a tool result.
 *
 * Mirrors `tools-list-hook.ts`: the high-level `McpServer` registers a single
 * `tools/call` handler on the low-level `Server` the first time a tool is
 * registered, so wrapping it once (at connect) observes every call.
 *
 * Dispatched calls are excluded via {@link markToolCallDispatched} /
 * {@link wasToolCallDispatched}: `instrumentTool` marks every dispatch it
 * sees, and the emit site skips marked requests, so a request never lands on
 * both `[MCP] Tool Call Response` and `[MCP] Tool Call Rejected`.
 */
import { isPromise } from '../utils/common.js';
import {
  getRequestHandlers,
  type McpExtra,
  type Server,
  type ServerRequestHandler,
  type ServerResult,
} from './mcp.js';

/** Marks a wrapped handler so a second install is a no-op. */
const WRAPPED = Symbol.for('amplitude.mcp.toolCallWrapped');

/**
 * Requests that reached an `instrumentTool`-wrapped callback, keyed on the
 * per-request `extra` object (the MCP SDK passes the same object to the
 * request handler and the tool callback, and it carries `requestId`). Object
 * identity is the collision-proof form of a requestId key — concurrent
 * connections reuse raw JSON-RPC ids — and entries vanish with the request.
 */
const dispatchedCalls = new WeakSet<object>();

/** Record that a `tools/call` request reached a tool callback. @internal */
export function markToolCallDispatched(extra: unknown): void {
  if (typeof extra === 'object' && extra !== null) {
    dispatchedCalls.add(extra);
  }
}

/** Whether a `tools/call` request reached a tool callback. @internal */
export function wasToolCallDispatched(extra: unknown): boolean {
  return typeof extra === 'object' && extra !== null && dispatchedCalls.has(extra);
}

/** What one `tools/call` request produced — its result, or the error it threw. */
export interface ToolCallHookOutcome {
  /** The attempted tool name from the request params — unvalidated caller input. */
  toolName?: string;
  result?: ServerResult;
  error?: unknown;
  durationMs: number;
}

/** The attempted tool name off a raw `tools/call` request, when present. */
function readToolName(request: unknown): string | undefined {
  const name = (request as { params?: { name?: unknown } } | null)?.params?.name;
  return typeof name === 'string' ? name : undefined;
}

/**
 * Wrap the server's registered `tools/call` handler so each request reports its
 * outcome (success or failure) to `onSettled` with the request `extra`. The
 * handler's behavior is unchanged — its result/throw pass through untouched.
 * Best-effort and idempotent: a no-op if the SDK shape is unrecognized or no
 * `tools/call` handler is registered yet.
 *
 * @internal
 */
export function installToolCallHook(
  server: Server,
  onSettled: (outcome: ToolCallHookOutcome, extra: McpExtra) => void,
): void {
  const handlers = getRequestHandlers(server);
  if (handlers == null) return;

  const original = handlers.get('tools/call');
  if (original == null || (original as ServerRequestHandler & { [WRAPPED]?: boolean })[WRAPPED]) {
    return;
  }

  const wrapped: ServerRequestHandler = (request, extra) => {
    const start = performance.now();
    const toolName = readToolName(request);
    const report = (outcome: { result?: ServerResult; error?: unknown }): void => {
      try {
        onSettled({ toolName, ...outcome, durationMs: performance.now() - start }, extra);
      } catch {
        // Telemetry is best-effort — never let it break the tools/call response.
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
          report({ result: res });
          return res;
        },
        (error) => {
          report({ error });
          throw error;
        },
      );
    }
    report({ result: out });
    return out;
  };
  (wrapped as ServerRequestHandler & { [WRAPPED]?: boolean })[WRAPPED] = true;
  handlers.set('tools/call', wrapped);
}
