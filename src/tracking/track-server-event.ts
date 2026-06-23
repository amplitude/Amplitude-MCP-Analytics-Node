/**
 * Server-scope custom event emitter — `analytics.trackServerEvent(ctx, name, props)`.
 *
 * Inherits every cross-cutting property from `ctx` (identity, tenant, client, server, 
 * auth, transport, etc.) so the caller only specifies the event-specific delta.
 * Caller-supplied `properties` win on collision; emit failures are swallowed 
 * (best-effort) and logged via the configured logger. Pass `{ dropExtraProps: true }` 
 * to omit the `ctx.extra` bag.
 */
import type { McpServerContext } from '../context/types.js';
import type { AmplitudeClientLike } from '../types.js';
import { getLogger } from '../utils/logger.js';
import { ctxToAmplitudeFields, reservedFieldsToProperties, shouldEmit } from './ctx-to-properties.js';
import type { TrackEventOptions } from './types.js';

/**
 * Emit a server-scope custom event, inheriting the ctx's reserved properties.
 * Property precedence (last wins): reserved < `ctx.extra` < caller `properties`.
 * Drops silently under the identity/tenant skip rule and on client error
 * (best-effort). Pass `{ dropExtraProps: true }` to omit the `ctx.extra` bag.
 */
export function trackServerEvent(
  amplitude: AmplitudeClientLike,
  ctx: McpServerContext,
  eventName: string,
  properties?: Record<string, unknown>,
  options?: TrackEventOptions,
): void {
  if (!shouldEmit(ctx)) return;

  try {
    const { user_id, device_id, groups, event_properties, extraProperties } =
      ctxToAmplitudeFields(ctx);
    amplitude.track({
      event_type: eventName,
      user_id,
      device_id,
      groups,
      event_properties: {
        ...reservedFieldsToProperties(event_properties),
        ...(options?.dropExtraProps ? {} : extraProperties),
        ...properties,
      },
    });
  } catch (err) {
    getLogger(amplitude).warn(
      `trackServerEvent('${eventName}') failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
