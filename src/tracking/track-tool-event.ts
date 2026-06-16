/**
 * Tool-scope custom event emitter — `analytics.trackToolEvent(ctx, name, props)`.
 *
 * Same contract as `trackServerEvent` plus inherited tool metadata (`tool name`,
 * `tool owner`, `tool tags`, `tool category`, `project id`, `project name`,
 * `request method`) from the tool-scope ctx. Caller-supplied `properties` win
 * on collision; emit failures are swallowed.
 */
import type { McpToolContext } from '../context/types.js';
import type { AmplitudeClientLike } from '../types.js';
import { getLogger } from '../utils/logger.js';
import { ctxToAmplitudeFieldsForTool, shouldEmit } from './ctx-to-properties.js';

/**
 * Emit a tool-scope custom event. Inherits every server-scope property from
 * `ctx` PLUS the tool metadata. Drops on the audit §2 skip rule; swallows
 * underlying client errors.
 */
export function trackToolEvent(
  amplitude: AmplitudeClientLike,
  ctx: McpToolContext,
  eventName: string,
  properties?: Record<string, unknown>,
): void {
  if (!shouldEmit(ctx)) return;

  try {
    const { user_id, device_id, groups, event_properties } = ctxToAmplitudeFieldsForTool(ctx);
    amplitude.track({
      event_type: eventName,
      user_id,
      device_id,
      groups,
      event_properties: { ...event_properties, ...properties },
    });
  } catch (err) {
    getLogger(amplitude).warn(
      `trackToolEvent('${eventName}') failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
