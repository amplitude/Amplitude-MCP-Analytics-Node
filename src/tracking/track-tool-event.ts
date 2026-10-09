/**
 * Tool-scope custom event emitter — `analytics.trackToolEvent(ctx, name, props)`.
 *
 * Same contract as `trackServerEvent` plus inherited metadata from the tool-scope ctx. 
 * Caller-supplied `properties` win on collision; emit failures are swallowed.
 */
import { PrivacyConfig } from '../core/privacy.js';
import type { McpToolContext } from '../context/types.js';
import type { AmplitudeClientLike } from '../types.js';
import { getLogger } from '../utils/logger.js';
import {
  ctxToAmplitudeFieldsForTool,
  reservedFieldsToProperties,
  shouldEmit,
} from './ctx-to-properties.js';
import { redactFreeformProperties } from './redact-event-properties.js';
import type { TrackEventOptions } from './types.js';

/** Built-in PII patterns, used when a caller does not pass a resolved policy. */
const DEFAULT_PRIVACY = new PrivacyConfig({ redactPii: true });

/**
 * Emit a tool-scope custom event — same contract as {@link trackServerEvent}
 * plus the tool metadata and `extra`.
 */
export function trackToolEvent(
  amplitude: AmplitudeClientLike,
  ctx: McpToolContext,
  eventName: string,
  properties?: Record<string, unknown>,
  options?: TrackEventOptions,
): void {
  if (!shouldEmit(ctx)) return;

  try {
    const { user_id, device_id, groups, event_properties, extraProperties } =
      ctxToAmplitudeFieldsForTool(ctx);
    const privacy = options?.privacy ?? DEFAULT_PRIVACY;
    amplitude.track({
      event_type: eventName,
      user_id,
      device_id,
      groups,
      event_properties: redactFreeformProperties(
        {
          ...reservedFieldsToProperties(event_properties),
          ...(options?.dropExtraProps ? {} : extraProperties),
          ...properties,
        },
        privacy,
      ),
    });
  } catch (err) {
    getLogger(amplitude).warn(
      `trackToolEvent('${eventName}') failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
