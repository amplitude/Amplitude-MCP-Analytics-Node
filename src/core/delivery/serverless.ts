// Vendored from amplitude/Amplitude-AI-Node @ 97ea346abd0caf333a3bafbd26b74de1d545f3e7
// Source: src/serverless.ts (isServerless + _resetServerlessCache, verbatim) and
//         src/client.ts (the _globalUnflushedCount / _registerExitHook machinery,
//         lifted out of the AmplitudeAI class into module-level functions).
// Adaptations: warning text re-prefixed AmplitudeAI: -> AmplitudeMCPAnalytics: and
//              de-LLM-ified (dropped the agent/session.run() guidance); the
//              instance-coupled counter became free functions so the delivery
//              proxy and client can drive it without holding a class reference.

/**
 * Serverless environment detection and unflushed-event exit accounting.
 *
 * `isServerless()` is used to decide whether to emit a warning when events
 * were tracked but never flushed before the runtime froze. The
 * `_globalUnflushedCount` machinery is module-level (rather than per-instance)
 * so it never holds a strong reference to a client instance — that would
 * prevent GC if the consumer forgets to call shutdown().
 */

const SERVERLESS_ENV_VARS = [
  'AWS_LAMBDA_FUNCTION_NAME', // AWS Lambda
  'VERCEL', // Vercel Functions
  'NETLIFY', // Netlify Functions
  'FUNCTION_TARGET', // Google Cloud Functions
  'WEBSITE_INSTANCE_ID', // Azure Functions
  'CF_PAGES', // Cloudflare Pages Functions
] as const;

let _cached: boolean | null = null;

/**
 * Detect whether the current process is running in a serverless environment.
 *
 * Checks well-known environment variables set by major serverless platforms.
 * Result is cached after the first call.
 */
export function isServerless(): boolean {
  if (_cached != null) return _cached;
  _cached = SERVERLESS_ENV_VARS.some(
    (v) => process.env[v] != null && process.env[v] !== '',
  );
  return _cached;
}

/** @internal Reset the cached serverless result (for testing). */
export function _resetServerlessCache(): void {
  _cached = null;
}

// Module-level counter for the unflushed-events exit warning. Kept here, not on
// the client, to avoid holding strong references to instances (which would
// prevent GC if the consumer forgets to call shutdown()).
let _globalUnflushedCount = 0;
let _exitHookRegistered = false;

/** Record that one more event has been handed to the underlying transport. */
export function incrementUnflushedCount(): void {
  _globalUnflushedCount++;
}

/**
 * Settle `count` previously-tracked events against the global counter — called
 * on flush()/shutdown() once the underlying client has taken ownership of them.
 * Clamped at zero so double-settling can never push the counter negative.
 */
export function settleUnflushedCount(count: number): void {
  _globalUnflushedCount = Math.max(0, _globalUnflushedCount - count);
}

/** @internal Exposed for testing only. */
export function getGlobalUnflushedCount(): number {
  return _globalUnflushedCount;
}

/**
 * @internal Reset the global unflushed counter (for testing). Deliberately
 * leaves the exit-hook registration guard alone so repeated construction in a
 * test suite doesn't accumulate `beforeExit` listeners.
 */
export function _resetUnflushedState(): void {
  _globalUnflushedCount = 0;
}

/**
 * Register a one-time `beforeExit` handler that warns when events were tracked
 * but never flushed in a serverless environment, where the runtime may freeze
 * before the periodic flush interval fires. Idempotent across calls.
 */
export function registerExitHook(): void {
  if (_exitHookRegistered) return;
  _exitHookRegistered = true;

  process.on('beforeExit', () => {
    if (!isServerless()) return;
    if (_globalUnflushedCount > 0) {
      console.warn(
        `⚠️  AmplitudeMCPAnalytics: ${_globalUnflushedCount} event(s) were tracked but never flushed. In serverless environments, call \`await analytics.flush()\` before your handler returns to avoid losing events.`,
      );
    }
  });
}
