/**
 * The default server-connection session events — `[MCP] Session Initialized` and
 * `[MCP] Session Ended`.
 *
 * `instrumentServer` calls them off the `initialize` request and the transport
 * close, and their transports differ. The handshake happens on every transport
 * (stateless Streamable HTTP included — it drops the session id, not the
 * handshake), so `[MCP] Session Initialized` fires everywhere. `[MCP] Session
 * Ended` is reported only for a connection that outlived the request that
 * opened it, since a per-request "session" has no duration worth reporting.
 * Neither fabricates a protocol session: `[MCP] Session ID` stays `no-session`
 * where none exists.
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
 * Emit `[MCP] Session Initialized` at the `initialize` handshake. Carries only
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
 * Emit `[MCP] Session Ended` when the transport closes — only for sessions that
 * emitted `[MCP] Session Initialized` first. Adds `[MCP] Session Duration` when known.
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
