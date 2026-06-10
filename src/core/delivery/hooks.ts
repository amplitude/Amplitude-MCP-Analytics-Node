// Vendored from amplitude/Amplitude-AI-Node @ 97ea346abd0caf333a3bafbd26b74de1d545f3e7
// Source: src/client.ts (_installTrackCounter, _installTrackHook, _warnShortId).
// Adaptations:
//   - _installTrackCounter / _installTrackHook were private methods on the
//     AmplitudeAI class; here they are free functions taking (client, config)
//     so they are callable and unit-testable without instantiating the SDK.
//   - Dropped the onEventCallback path: MCPAnalyticsConfig is intentionally
//     {debug, dryRun} only, so there is no user delivery callback to compose.
//   - Log/warning prefixes re-labelled AmplitudeAI: -> AmplitudeMCPAnalytics:.
// The logger and debug-line formatting are cross-cutting utilities (delivery is
// just their first caller), so they live in src/utils/ alongside resolve-module.

import type { MCPAnalyticsConfig } from '../../config.js';
import type { AmplitudeClientLike, AmplitudeEvent } from '../../types.js';
import { formatDebugLine, formatDryRunLine } from '../../utils/debug.js';
import { type Logger, getLogger } from '../../utils/logger.js';
import type { TrackingProxy } from './proxy.js';
import { incrementUnflushedCount } from './serverless.js';

const _MIN_ID_LENGTH = 5;

const _shortIdWarned = new Set<string>();

/**
 * Warn once per (field, value) when a user_id/device_id is shorter than
 * Amplitude's 5-character minimum — the server rejects such events with
 * HTTP 400 ("Invalid id length"), which is otherwise easy to miss.
 */
function _warnShortId(event: AmplitudeEvent, logger: Logger): void {
  for (const field of ['user_id', 'device_id'] as const) {
    const val = (event as Record<string, unknown>)[field];
    if (typeof val === 'string' && val.length > 0 && val.length < _MIN_ID_LENGTH) {
      const key = `${field}:${val}`;
      if (!_shortIdWarned.has(key)) {
        _shortIdWarned.add(key);
        logger.warn(
          `AmplitudeMCPAnalytics: ${field}="${val}" is shorter than ${_MIN_ID_LENGTH} characters. Amplitude's server will reject this event with HTTP 400 ("Invalid id length"). Use a longer identifier.`,
        );
      }
    }
  }
}

/** @internal Exposed for testing only. */
export function _resetShortIdWarned(): void {
  _shortIdWarned.clear();
}

/**
 * Wrap `client.track` so every tracked event bumps the global unflushed
 * counter (and, via `onTracked`, the host client's own count-since-flush).
 * Install this BEFORE {@link installTrackHook} so the hook (which decides
 * dry-run skips) sits outermost and dry-run events are never counted.
 *
 * @param onTracked optional per-event callback — the host client uses it to
 *   maintain its own count-since-flush, which it settles in flush()/shutdown().
 *   Kept as a callback so this stays a free function and the proxy carries no
 *   lifecycle bookkeeping of its own.
 */
export function installTrackCounter(
  client: TrackingProxy,
  onTracked?: () => void,
): void {
  const originalTrack = client.track.bind(client);
  client.track = (event: AmplitudeEvent) => {
    incrementUnflushedCount();
    onTracked?.();
    return originalTrack(event);
  };
}

/**
 * Wrap `client.track` with the delivery hook: short-id warning, debug/dry-run
 * output, dry-run delivery skip, and a transport-level callback that surfaces
 * 4xx/5xx delivery failures (which the base SDK only logs at INFO).
 */
export function installTrackHook(
  client: TrackingProxy,
  config: MCPAnalyticsConfig,
): void {
  const originalTrack = client.track.bind(client);
  const debug = config.debug;
  const dryRun = config.dryRun;
  const logger = getLogger(client);
  const clientWithConfig = client as AmplitudeClientLike & {
    configuration?: { callback?: (...args: unknown[]) => void };
  };
  const existingCallback = clientWithConfig.configuration?.callback;

  // Compose a transport-level callback that fires after delivery: preserve any
  // existing callback on the Amplitude client, then surface delivery failures.
  if (clientWithConfig.configuration != null) {
    clientWithConfig.configuration.callback = (...args: unknown[]) => {
      const event = args[0];
      const statusCode = typeof args[1] === 'number' ? args[1] : 0;
      const message = args[2] == null ? null : String(args[2]);
      if (typeof existingCallback === 'function') {
        try {
          existingCallback(...args);
        } catch (e) {
          logger.debug(`Existing delivery callback raised: ${e}`);
        }
      }
      // Default delivery callback — surface failures that the base SDK only
      // logs at INFO (invisible under most configurations).
      if (statusCode >= 400) {
        const eventType =
          (event as Record<string, unknown> | null)?.event_type ?? 'unknown';
        const userId =
          (event as Record<string, unknown> | null)?.user_id ?? '';
        logger.warn(
          `AmplitudeMCPAnalytics: event delivery failed — HTTP ${statusCode} for event=${String(eventType)} user_id=${String(userId)}: ${message ?? ''}`,
        );
      }
    };
  }

  client.track = (event: AmplitudeEvent) => {
    // Short-ID warning — Amplitude server rejects user_id/device_id shorter
    // than 5 characters with HTTP 400.
    _warnShortId(event, logger);

    if (debug) {
      console.warn(formatDebugLine(event));
    }
    if (dryRun) {
      console.warn(formatDryRunLine(event));
    }
    if (!dryRun) {
      originalTrack(event);
    }
  };
}
