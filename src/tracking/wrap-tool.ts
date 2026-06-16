/**
 * Higher-order wrapper for MCP tool handlers — `analytics.wrapTool(meta, handler)`.
 *
 * At invocation time:
 *   1. Reads the SDK's `extra` (the last handler arg) and runs the configured
 *      {@link ContextExtractor} to resolve the server-scope ctx.
 *   2. Extends it with the caller-supplied tool metadata into a tool-scope ctx.
 *   3. Runs the handler under `runWithContext(ctx)` so emit sites deep in the
 *      call stack can fall back to {@link import('../context/index.js').getCurrentContext}.
 *   4. Emits a stub `mcp: tool call response` event around the call (success +
 *      duration, or failure + error). The canonical emitter lands with MCP-358.
 *   5. Preserves the underlying handler's sync/async shape — a sync handler
 *      returns its sync result; an async handler returns a promise.
 *
 * Handler exceptions are RE-THROWN after the failure event is emitted: the
 * host's tool response must surface the error to the MCP SDK. The "best-effort"
 * guarantee applies only to event emission, not to the handler return value.
 */
import { runWithContext } from '../context/als.js';
import { createToolContext } from '../context/factory.js';
import type { IdentityResolver, McpToolContext, McpToolMeta } from '../context/types.js';
import { resolveIdentityFromChain, type ServerIdentity } from '../core/identity.js';
import type { McpExtra, ToolResult } from '../core/mcp.js';
import type { AmplitudeClientLike } from '../types.js';
import { trackToolEvent } from './track-tool-event.js';
import type { ContextExtractor } from './types.js';

/** Dependencies the standalone {@link wrapTool} factory needs from the client. */
export interface WrapToolDependencies {
  amplitude: AmplitudeClientLike;
  extractContext: ContextExtractor;
  resolveIdentity?: IdentityResolver;
  serverIdentity?: ServerIdentity;
}

/**
 * Handler signature for an instrumented tool. Receives the tool-scope `ctx` as
 * the first argument; remaining args are forwarded from the MCP SDK
 * (`(args, extra)` with a schema, `(extra)` without).
 */
export type InstrumentedToolHandler<Args extends unknown[], R extends ToolResult> = (
  ctx: McpToolContext,
  ...args: Args
) => R;

/**
 * Build a wrapper for an MCP tool handler. The returned function is shaped to
 * drop into the MCP SDK's `server.tool(name, schema, fn)` slot.
 *
 * Exposed as a standalone factory (separate from the {@link
 * import('../client.js').AmplitudeMCPAnalytics} method) so the default-event
 * tracks (MCP-358) and tests can reuse it without the full client.
 */
export function wrapTool<Args extends unknown[], R extends ToolResult>(
  deps: WrapToolDependencies,
  meta: McpToolMeta,
  handler: InstrumentedToolHandler<Args, R>,
): (...args: Args) => R {
  return (...callArgs: Args): R => {
    const startMs = performance.now();
    const extra = callArgs[callArgs.length - 1] as McpExtra | undefined;
    const safeExtra = extra ?? ({} as McpExtra);
    const serverCtx = deps.extractContext(safeExtra);

    let identity = serverCtx.identity;
    let tenant = serverCtx.tenant;
    if (identity.resolvedFrom === 'anonymous') {
      const authInfo = (safeExtra as Record<string, unknown>).authInfo as
        | Record<string, unknown>
        | undefined;

      const resolved = resolveIdentityFromChain({
        resolveIdentity: deps.resolveIdentity,
        authInfo,
        serverIdentity: deps.serverIdentity,
        anchor: serverCtx.anchor,
      });

      identity = resolved.identity;
      tenant = resolved.tenant ?? tenant;
    }

    const ctx = createToolContext(
      { ...serverCtx, identity, tenant },
      meta,
      { request: { method: 'tools/call' } },
    );

    let result: R;
    try {
      result = runWithContext(ctx, () => handler(ctx, ...callArgs));
    } catch (err) {
      // Synchronous throw — emit failure, rethrow so the SDK surfaces it.
      emitToolCallResponseStub(deps.amplitude, ctx, {
        status: 'error',
        durationMs: performance.now() - startMs,
        error: err,
      });
      throw err;
    }

    // Async handler — hook into the promise to capture the real duration and
    // outcome without forcing all callers to be async.
    if (isPromise(result)) {
      const tracked = result.then(
        (value) => {
          emitToolCallResponseStub(deps.amplitude, ctx, {
            status: 'success',
            durationMs: performance.now() - startMs,
          });
          return value;
        },
        (err) => {
          emitToolCallResponseStub(deps.amplitude, ctx, {
            status: 'error',
            durationMs: performance.now() - startMs,
            error: err,
          });
          throw err;
        },
      );
      return tracked as R;
    }

    emitToolCallResponseStub(deps.amplitude, ctx, {
      status: 'success',
      durationMs: performance.now() - startMs,
    });
    return result;
  };
}

/**
 * Stub emitter for the default tool-execution event. Lives here, behind a
 * `TODO(MCP-358)` comment, so `wrapTool` is testable today; MCP-358 replaces
 * the body with the canonical `mcp: tool call response` shape and removes this
 * helper.
 */
function emitToolCallResponseStub(
  amplitude: AmplitudeClientLike,
  ctx: McpToolContext,
  outcome:
    | { status: 'success'; durationMs: number }
    | { status: 'error'; durationMs: number; error: unknown },
): void {
  // TODO(MCP-358): Replace this stub with the canonical default-event emitter.
  // The property names below are placeholders; MCP-358 owns the contract.
  const properties: Record<string, unknown> = {
    'tool call status': outcome.status,
    'tool call duration ms': Math.round(outcome.durationMs),
  };
  if (outcome.status === 'error') {
    // TODO(MCP-360): Replace with the canonical StructuredMcpError mapping.
    const err = outcome.error;
    properties['error message'] = err instanceof Error ? err.message : String(err);
    properties['error type'] = err instanceof Error ? err.name : 'unknown';
  }
  trackToolEvent(amplitude, ctx, 'mcp: tool call response', properties);
}

function isPromise(value: unknown): value is Promise<unknown> {
  return (
    value != null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}
