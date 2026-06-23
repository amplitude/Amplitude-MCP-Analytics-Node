/**
 * The tool-instrumentation wrapper — `analytics.instrumentTool(handler, meta)`.
 *
 * The handler is your native MCP tool handler, unchanged — `(args, extra)` with
 * a schema, `(extra)` without. `instrumentTool` does not alter its signature;
 * wrap your existing handler and it works as-is.
 *
 * On each call it:
 *   1. Builds the per-request context (transport-aware correlation anchor,
 *      client info, protocol version) from the scope bound by `instrumentServer`.
 *      The SDK builds the context; you never construct or pass it.
 *   2. Runs the handler with that context available via `getCurrentContext()`
 *      (the `track*` methods also accept it explicitly).
 *   3. Emits a tool-call event (success + duration, or failure) and records the
 *      error on the context. A failure is either a thrown exception OR a tool
 *      result carrying `isError: true`.
 *   4. Preserves the underlying handler's sync/async shape — a sync handler
 *      returns its sync result; an async handler returns a promise.
 *
 * If `instrumentServer` was never called, the wrapper is a no-op passthrough:
 * the handler runs untouched and nothing is emitted.
 *
 * Handler exceptions are RE-THROWN after the failure event is emitted, so the 
 * MCP SDK still surfaces them to the client; the best-effort guarantee applies 
 * only to event emission, not to the handler's return value.
 */
import { runWithContext } from '../context/als.js';
import type { IdentityResolver, McpServerContext, McpToolContext, McpToolMeta } from '../context/types.js';
import { buildToolContext } from '../core/build-context.js';
import type { ServerIdentity } from '../core/identity.js';
import { byteSize } from '../core/serialize.js';
import type { McpExtra, ToolHandler, ToolResult } from '../core/mcp.js';
import { buildToolError, classifyError, errorMessageFromResult, isErrorResult } from '../errors.js';
import type { AmplitudeClientLike } from '../types.js';
import { isPromise } from '../utils/common.js';
import { getLogger } from '../utils/logger.js';
import type { Logger } from '../utils/logger.js';
import { emitToolCallResponse } from './events/tool-call-response.js';

/**
 * Dependencies the standalone {@link instrumentTool} factory needs from the client.
 *
 * @internal Not part of the public package surface — construct a client and use
 * `AmplitudeMCPAnalytics.instrumentTool(handler, meta)` instead.
 */
export interface InstrumentToolDependencies {
  amplitude: AmplitudeClientLike;
  /**
   * The server scope bound by `instrumentServer`, or `undefined` when it was
   * never called. Resolved on *every* invocation (not captured at wrap time)
   * because the binding is late and mutable: the scope is set when
   * `instrumentServer`'s wrapped `connect()` runs — which happens *after* tools
   * are wrapped — and is mutated again at the handshake (`clientInfo`).
   *
   * When this returns `undefined`, {@link instrumentTool} is a no-op passthrough
   * (see its doc) — it does NOT fabricate a floor and emit.
   */
  getServerCtx: () => McpServerContext | undefined;
  resolveIdentity?: IdentityResolver;
  serverIdentity?: ServerIdentity;
  logger?: Logger;
}

/**
 * Build the wrapped handler for an MCP tool. The returned function has the same
 * shape as the handler you pass in, so it drops into the MCP SDK's
 * `server.tool(name, schema, fn)` slot.
 *
 * Exposed as a standalone factory (separate from the {@link
 * import('../client.js').AmplitudeMCPAnalytics} method) so it can be reused
 * without constructing a full client.
 *
 * @internal Not part of the public package surface. Consumers instrument tools
 * via `AmplitudeMCPAnalytics.instrumentTool(handler, meta)`.
 */
export function instrumentTool<Args extends unknown[], R extends ToolResult>(
  deps: InstrumentToolDependencies,
  handler: ToolHandler<Args, R>,
  meta: McpToolMeta,
): (...args: Args) => R {
  let warnedUnbound = false;

  return (...callArgs: Args): R => {
    const serverCtx = deps.getServerCtx();

    // No instrumentServer() binding → analytics is off: run the original handler
    // untouched, emit nothing, and establish no ambient context. Warn once per
    // tool so a missing instrumentServer() doesn't silently drop every event.
    if (serverCtx === undefined) {
      if (!warnedUnbound) {
        warnedUnbound = true;
        getLogger(deps.amplitude).warn(
          `AmplitudeMCPAnalytics: instrumentTool('${meta.name}') ran without instrumentServer(); analytics is disabled for this tool. Call instrumentServer(server) before connect() to enable tracking.`,
        );
      }
      return handler(...callArgs);
    }

    const startMs = performance.now();
    const extra = (callArgs[callArgs.length - 1] ?? {}) as McpExtra;
    const ctx = buildToolContext(serverCtx, meta, extra, {
      resolveIdentity: deps.resolveIdentity,
      serverIdentity: deps.serverIdentity,
      logger: deps.logger,
    });

    let result: R;
    try {
      result = runWithContext(ctx, () => handler(...callArgs));
    } catch (err) {
      // Synchronous throw — record the failure, then rethrow so the SDK surfaces
      // it. The wrapper owns the rethrow; the recorder only emits telemetry.
      recordToolCall({
        ctx,
        thrown: err,
        amplitude: deps.amplitude,
        durationMs: performance.now() - startMs,
        callArgs,
      });
      throw err;
    }

    // Async handler — hook into the promise to capture the real duration and
    // outcome without forcing all callers to be async.
    if (isPromise(result)) {
      const tracked = result.then(
        (value) => {
          recordToolCall({
            ctx,
            returned: value,
            amplitude: deps.amplitude,
            durationMs: performance.now() - startMs,
            callArgs,
          });
          return value;
        },
        (err) => {
          recordToolCall({
            ctx,
            thrown: err,
            amplitude: deps.amplitude,
            durationMs: performance.now() - startMs,
            callArgs,
          });
          throw err;
        },
      );
      return tracked as R;
    }

    recordToolCall({
      ctx,
      returned: result,
      amplitude: deps.amplitude,
      durationMs: performance.now() - startMs,
      callArgs,
    });
    return result;
  };
}

/**
 * The single point `instrumentTool` funnels every tool call through. It resolves
 * the call status, classifies any error onto `ctx.error`, then emits the default
 * event.
 *
 * A call is considered a failure when:
 *   - a thrown exception (protocol-level error), classified via {@link classifyError};
 *   - a returned result carrying `isError: true` (tool-execution error reported in-band — the SDK does not throw it), classified as `returned_error`.
 * @internal
 */
function recordToolCall<Args extends unknown[]>(params: {
  ctx: McpToolContext;
  amplitude: AmplitudeClientLike;
  durationMs: number;
  /** The handler's call args — request body (`args[0]`) + `extra`. */
  callArgs: Args;
  thrown?: unknown;
  returned?: unknown;
}): void {
  const { ctx, amplitude, durationMs, callArgs } = params;
  let isToolError = false;

  if ('thrown' in params) {
    ctx.error = classifyError(params.thrown);
    isToolError = true;
  } else if ('returned' in params && isErrorResult(params.returned)) {
    ctx.error = ctx.error != null
      // preserve the pre-existing error context (e.g. when constructed by `analytics.toolError(ctx, input)`)
      ? ctx.error
      : buildToolError({
        code: 'returned_error',
        message: errorMessageFromResult(params.returned) ?? 'Tool returned an error result',
      });
    isToolError = true;
  }

  // Custom fields ride on `ctx.tool.extra` and are resolved downstream.
  emitToolCallResponse(amplitude, ctx, {
    isToolError,
    durationMs,
    requestSizeBytes: byteSize(callArgs.length > 1 ? callArgs[0] : undefined),
    responseSizeBytes: 'returned' in params ? byteSize(params.returned) : undefined,
  });
}
