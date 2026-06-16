/**
 * Ambient access to the current MCP context via `AsyncLocalStorage`.
 *
 * Threading model: explicit `ctx` is the public contract — the SDK's
 * tool-instrumentation API injects it and the custom-event / error APIs take
 * it as an argument. This ambient accessor is an optional *convenience* for
 * emit sites deep in a call stack that can't easily thread `ctx`, or for hosts
 * that already use AsyncLocalStorage. It is NOT the contract — prefer explicit
 * `ctx`.
 *
 * Ambient is the fallback, not the default: the store is lost across async
 * boundaries that escape the `runWithContext` scope, is harder to test, and
 * has serverless pitfalls. When in doubt, pass `ctx`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { McpServerContext, SetIdentityInput } from './types.js';

const storage = new AsyncLocalStorage<McpServerContext>();

/**
 * Run `fn` with `ctx` as the ambient context, including any async work awaited
 * within `fn`. Returns whatever `fn` returns. A tool-scope context is accepted
 * (it extends the server scope).
 */
export function runWithContext<T>(ctx: McpServerContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * The ambient context for the current async scope, or `undefined` outside any
 * {@link runWithContext} scope. Surfaces the server scope; for tool-scope
 * fields, prefer the explicitly-passed `ctx`.
 */
export function getCurrentContext(): McpServerContext | undefined {
  return storage.getStore();
}

/**
 * Set or override the identity on the current request's ambient context.
 * Must be called inside a {@link runWithContext} scope (e.g. inside an
 * instrumented tool handler). Throws if called outside a context scope.
 *
 * This is the primary integration point for consumers who resolve identity
 * in custom auth middleware or inside the handler itself.
 */
export function setIdentity(input: SetIdentityInput): void {
  const ctx = storage.getStore();
  if (ctx == null) {
    throw new Error(
      'setIdentity() called outside an active context scope. ' +
      'Call it inside an instrumented tool handler or a runWithContext() block.',
    );
  }

  if (input.userId != null || input.deviceId != null) {
    ctx.identity = {
      ...ctx.identity,
      ...(input.userId != null ? { userId: input.userId } : {}),
      ...(input.deviceId != null ? { deviceId: input.deviceId } : {}),
      resolvedFrom: 'explicit',
    };
  }

  if (input.tenant != null) ctx.tenant = input.tenant;
}
