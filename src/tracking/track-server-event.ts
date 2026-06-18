/**
 * Server-scope custom event emitter — `analytics.trackServerEvent(ctx, name, props)`.
 *
 * Inherits every cross-cutting property from `ctx` (identity, tenant, session,
 * client, server, auth, transport, trace) so the caller only specifies the
 * event-specific delta. Caller-supplied `properties` win on collision; emit
 * failures are swallowed (best-effort) and logged via the configured logger.
 */
import type { PrivacyConfig } from '../core/privacy.js';
import type { McpServerContext } from '../context/types.js';
import type { AmplitudeClientLike } from '../types.js';
import { getLogger } from '../utils/logger.js';
import { ctxToAmplitudeFields, shouldEmit } from './ctx-to-properties.js';

/**
 * Emit a server-scope custom event. Returns void; the SDK's delivery layer
 * (TrackingProxy + the underlying Amplitude client) handles batching/flushing.
 *
 * Drops silently when the audit §2 skip rule fires (anonymous identity AND no
 * tenant) and when the underlying client throws — custom event emission must
 * never break the host's tool response.
 */
export function trackServerEvent(
  amplitude: AmplitudeClientLike,
  ctx: McpServerContext,
  eventName: string,
  properties?: Record<string, unknown>,
  privacy?: PrivacyConfig,
): void {
  if (!shouldEmit(ctx)) return;

  try {
    const { user_id, device_id, groups, event_properties } = ctxToAmplitudeFields(ctx, privacy);
    // Caller-supplied properties are free-form content — redact before merge.
    const props =
      privacy && properties != null
        ? (privacy.redactValue(properties) as Record<string, unknown>)
        : properties;
    amplitude.track({
      event_type: eventName,
      user_id,
      device_id,
      groups,
      // Caller-supplied properties win on collision — documented precedence.
      event_properties: { ...event_properties, ...props },
    });
  } catch (err) {
    getLogger(amplitude).warn(
      `trackServerEvent('${eventName}') failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
