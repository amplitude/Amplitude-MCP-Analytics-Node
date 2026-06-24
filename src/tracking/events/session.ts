/**
 * The default server-connection session events — `mcp: session initialized` and
 * `mcp: session ended`. Both apply only where a protocol session exists (stdio +
 * legacy Streamable HTTP); `instrumentServer` only calls them off the
 * `initialize` handshake / transport close, so they are never fabricated on
 * `2026-07-28+` stateless HTTP.
 */
import type { McpServerContext } from '../../context/types.js';
import type { AmplitudeClientLike } from '../../types.js';
import { EVENT_PROPERTY_KEYS as K, SESSION_ENDED, SESSION_INITIALIZED } from '../constants.js';
import { trackServerEvent } from '../track-server-event.js';

/** What the session produced over its lifetime, as observed by the wrapper. @internal */
interface SessionEndedOutcome {
  /** Wall-clock session duration (handshake → close), in milliseconds. */
  durationMs?: number;
}

/**
 * Emit `mcp: session initialized` at the `initialize` handshake. Carries only
 * the ctx-derived reserved props (client/server identity, transport, protocol,
 * auth, session/anchor); the server `ctx.extra` bag rides along downstream.
 *
 * @internal
 */
export function emitSessionInitialized(
  amplitude: AmplitudeClientLike,
  ctx: McpServerContext,
): void {
  trackServerEvent(amplitude, ctx, SESSION_INITIALIZED);
}

/**
 * Emit `mcp: session ended` when the transport closes — only for sessions that
 * emitted `mcp: session initialized` first. Adds `session duration` when known.
 *
 * @internal
 */
export function emitSessionEnded(
  amplitude: AmplitudeClientLike,
  ctx: McpServerContext,
  outcome?: SessionEndedOutcome,
): void {
  const properties: Record<string, unknown> = {};
  if (outcome?.durationMs != null) {
    properties[K.sessionDuration] = Math.round(outcome.durationMs);
  }
  trackServerEvent(amplitude, ctx, SESSION_ENDED, properties);
}
