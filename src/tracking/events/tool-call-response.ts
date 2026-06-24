/** The default tool-execution event — `mcp: tool call response`. */
import type { McpToolContext } from '../../context/types.js';
import type { AmplitudeClientLike } from '../../types.js';
import { EVENT_PROPERTY_KEYS as K, TOOL_CALL_RESPONSE } from '../constants.js';
import { trackToolEvent } from '../track-tool-event.js';

/** What a single tool call produced, as observed by the instrumentation wrapper. @internal */
interface ToolCallOutcome {
  /** `true` on failure — a thrown exception or an in-band `isError` result. */
  isToolError: boolean;
  /** Wall-clock handler duration, in milliseconds. */
  durationMs: number;
  /** Serialized byte size of the tool args, when computable. */
  requestSizeBytes?: number;
  /** Serialized byte size of the tool result, when computable. */
  responseSizeBytes?: number;
}

/**
 * Emit `mcp: tool call response`. Called by `instrumentTool`; the outcome props
 * ride as `trackToolEvent`'s `properties` (ctx-derived reserved props and tool
 * `extra` are added downstream). Absent outcome fields are omitted.
 *
 * @internal
 */
export function emitToolCallResponse(
  amplitude: AmplitudeClientLike,
  ctx: McpToolContext,
  outcome: ToolCallOutcome,
): void {
  const properties: Record<string, unknown> = {
    [K.isError]: outcome.isToolError,
    [K.responseDuration]: Math.round(outcome.durationMs),
  };

  if (outcome.requestSizeBytes != null) properties[K.requestSize] = outcome.requestSizeBytes;
  if (outcome.responseSizeBytes != null) properties[K.responseSize] = outcome.responseSizeBytes;

  if (ctx.error != null) {
    properties[K.errorMessage] = ctx.error.message;
    properties[K.errorType] = ctx.error.type;
  }

  trackToolEvent(amplitude, ctx, TOOL_CALL_RESPONSE, properties);
}
