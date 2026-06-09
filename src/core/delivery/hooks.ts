// Vendored from amplitude/Amplitude-AI-Node @ 97ea346abd0caf333a3bafbd26b74de1d545f3e7
// Source: src/client.ts (_installTrackCounter, _installTrackHook, _warnShortId),
//         src/utils/logger.ts (getLogger / Logger), and
//         src/utils/debug.ts (formatDryRunLine; the debug line is reimplemented
//         taxonomy-agnostically — see below).
// Adaptations:
//   - _installTrackCounter / _installTrackHook were private methods on the
//     AmplitudeAI class; here they are free functions taking (client, config)
//     so they are callable and unit-testable without instantiating the SDK.
//   - Dropped the onEventCallback path: MCPAnalyticsConfig is intentionally
//     {debug, dryRun} only, so there is no user delivery callback to compose.
//   - The debug line does NOT decode event properties by name (AI-Node's
//     formatDebugLine keys off the AI event taxonomy, which lives in a later
//     ticket here). It prints a generic, taxonomy-free summary instead.
//   - Log/warning prefixes re-labelled AmplitudeAI: -> AmplitudeMCPAnalytics:.
//   - getLogger / Logger inlined from utils/logger.ts (the only consumer).

import type { MCPAnalyticsConfig } from '../../config.js';
import type { AmplitudeClientLike, AmplitudeEvent } from '../../types.js';
import type { TrackingProxy } from './proxy.js';
import { incrementUnflushedCount } from './serverless.js';

const _MIN_ID_LENGTH = 5;

export interface Logger {
  debug(message: string): void;
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
}

const defaultLogger: Logger = {
  debug: () => {},
  error: (msg) => console.error(`[amplitude-mcp-analytics] ${msg}`),
  warn: (msg) => console.warn(`[amplitude-mcp-analytics] ${msg}`),
  info: () => {},
};

/**
 * Resolve a logger: prefer a `loggerProvider` exposed on the underlying
 * Amplitude client's configuration, otherwise fall back to console.
 */
export function getLogger(amplitude?: unknown): Logger {
  if (amplitude && typeof amplitude === 'object') {
    const config = (amplitude as Record<string, unknown>).configuration as
      | Record<string, unknown>
      | undefined;
    if (config?.loggerProvider && typeof config.loggerProvider === 'object') {
      return config.loggerProvider as Logger;
    }
  }
  return defaultLogger;
}

const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

/** Compact, taxonomy-agnostic one-liner for the `debug` setting. */
function formatDebugLine(event: AmplitudeEvent): string {
  const eventType = event.event_type ?? 'unknown';
  const userId = event.user_id ?? '?';
  let line = `${CYAN}[amplitude-mcp-analytics]${RESET} ${eventType} ${DIM}|${RESET} user=${userId}`;
  if (event.device_id) line += ` device=${event.device_id}`;
  const propCount = Object.keys(event.event_properties ?? {}).length;
  if (propCount > 0) line += ` ${DIM}props=${propCount}${RESET}`;
  return line;
}

/** Full JSON dump for the `dryRun` setting, so nothing is hidden. */
function formatDryRunLine(event: unknown): string {
  try {
    return JSON.stringify(event);
  } catch {
    return String(event);
  }
}

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
 * Wrap `client.track` so every tracked event bumps the per-proxy and global
 * unflushed counters. Install this BEFORE {@link installTrackHook} so the hook
 * (which decides dry-run skips) sits outermost and dry-run events are never
 * counted.
 */
export function installTrackCounter(client: TrackingProxy): void {
  const originalTrack = client.track.bind(client);
  client.track = (event: AmplitudeEvent) => {
    client.trackCountSinceFlush++;
    incrementUnflushedCount();
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
