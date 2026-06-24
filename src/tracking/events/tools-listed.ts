/** The default server-capability event — `mcp: tools listed`. */
import type { McpServerContext } from '../../context/types.js';
import type { AmplitudeClientLike } from '../../types.js';
import { EVENT_PROPERTY_KEYS as K, TOOLS_LISTED, TOOL_NAMES_MAX } from '../constants.js';
import { trackServerEvent } from '../track-server-event.js';

/** What a `tools/list` request produced, as observed by the wrapper. @internal */
interface ToolsListedOutcome {
  /** `true` when the handler threw instead of returning a list. */
  isError: boolean;
  /** Number of tools the server returned (0 on failure). */
  toolCount: number;
  /** Tool names, when the list is small enough to be worth carrying. */
  toolNames?: string[];
  /** Wall-clock handler duration, in milliseconds. */
  durationMs?: number;
  /** Serialized byte size of the result, when computable. */
  responseSizeBytes?: number;
  /** Classified error message / type, when the handler threw. */
  errorMessage?: string;
  errorType?: string;
}

/**
 * Emit `mcp: tools listed`. Called by `instrumentServer` when a `tools/list`
 * request is served. 
 *
 * @internal
 */
export function emitToolsListed(
  amplitude: AmplitudeClientLike,
  ctx: McpServerContext,
  outcome: ToolsListedOutcome,
): void {
  const properties: Record<string, unknown> = {
    [K.isError]: outcome.isError,
    [K.toolCount]: outcome.toolCount,
  };
  if (outcome.toolNames != null) {
    if (outcome.toolNames.length > TOOL_NAMES_MAX) {
      properties[K.toolNames] = outcome.toolNames.slice(0, TOOL_NAMES_MAX);
      properties[K.toolNamesTruncated] = true;
    } else {
      properties[K.toolNames] = outcome.toolNames;
    }
  }
  if (outcome.durationMs != null) properties[K.responseDuration] = Math.round(outcome.durationMs);
  if (outcome.responseSizeBytes != null) properties[K.responseSize] = outcome.responseSizeBytes;
  if (outcome.errorMessage != null) properties[K.errorMessage] = outcome.errorMessage;
  if (outcome.errorType != null) properties[K.errorType] = outcome.errorType;

  trackServerEvent(amplitude, ctx, TOOLS_LISTED, properties);
}
