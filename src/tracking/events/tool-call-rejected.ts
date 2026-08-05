/** The default rejected-tool-call event — `[MCP] Tool Call Rejected`. */
import type { ErrorMessageSanitizer } from '../../config.js';
import type { RejectionReason } from '../../core/tool-call-rejection.js';
import type { McpServerContext } from '../../context/types.js';
import type { AmplitudeClientLike } from '../../types.js';
import {
  ATTEMPTED_TOOL_NAME_MAX,
  EVENT_PROPERTY_KEYS as K,
  TOOL_CALL_REJECTED,
} from '../constants.js';
import { sanitizeErrorMessage } from '../sanitize-error-message.js';
import { trackServerEvent } from '../track-server-event.js';

/** What a rejected `tools/call` request produced, as observed by the hook. @internal */
interface ToolCallRejectedOutcome {
  /** The attempted tool name from the request params — unvalidated caller input. */
  attemptedToolName?: string;
  /** Structured cause, segmentable without the message text. */
  rejectionReason?: RejectionReason;
  /** Message / code / type of the rejection error. */
  errorMessage?: string;
  errorCode?: string;
  errorType?: string;
  /** Wall-clock `tools/call` handler duration, in milliseconds. */
  durationMs?: number;
  /** Serialized byte size of the JSON-RPC error envelope sent to the client. */
  responseSizeBytes?: number;
  /** Transport-level HTTP status of the response (Streamable HTTP only). */
  responseHttpStatus?: number;
}

/**
 * Emit `[MCP] Tool Call Rejected`. Called by `instrumentServer` when a
 * `tools/call` request fails before any tool callback runs. A **server-scope**
 * event on purpose: the attempted name is unvalidated caller input
 * (hallucinated, mistyped, or since-removed tools), so it rides on
 * `[MCP] Attempted Tool Name` and never pollutes the `[MCP] Tool Name`
 * reserved key that per-tool dashboards slice on.
 *
 * @internal
 */
export function emitToolCallRejected(
  amplitude: AmplitudeClientLike,
  ctx: McpServerContext,
  outcome: ToolCallRejectedOutcome,
  sanitize?: ErrorMessageSanitizer,
): void {
  const properties: Record<string, unknown> = {
    [K.isError]: true,
  };
  if (outcome.attemptedToolName != null) {
    properties[K.attemptedToolName] = outcome.attemptedToolName.slice(0, ATTEMPTED_TOOL_NAME_MAX);
  }
  if (outcome.rejectionReason != null) properties[K.rejectionReason] = outcome.rejectionReason;
  if (outcome.errorMessage != null) {
    const message = sanitizeErrorMessage(outcome.errorMessage, sanitize);
    if (message != null) properties[K.errorMessage] = message;
  }
  if (outcome.errorCode != null) properties[K.errorCode] = outcome.errorCode;
  if (outcome.errorType != null) properties[K.errorType] = outcome.errorType;
  if (outcome.durationMs != null) properties[K.responseDuration] = Math.round(outcome.durationMs);
  if (outcome.responseSizeBytes != null) properties[K.responseSize] = outcome.responseSizeBytes;
  if (outcome.responseHttpStatus != null) {
    properties[K.responseHttpStatus] = outcome.responseHttpStatus;
  }

  trackServerEvent(amplitude, ctx, TOOL_CALL_REJECTED, properties);
}
