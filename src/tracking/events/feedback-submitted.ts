/** The opt-in feedback event — `[MCP] Feedback Submitted`. */
import type { McpToolContext } from '../../context/types.js';
import type { AmplitudeClientLike } from '../../types.js';
import { EVENT_PROPERTY_KEYS as K, FEEDBACK_SUBMITTED } from '../constants.js';
import { trackToolEvent } from '../track-tool-event.js';

/** Fields the feedback tool resolved from one call. @internal */
export interface FeedbackSubmittedFields {
  helpful: boolean;
  reason?: string;
  solicited?: boolean;
  toolNames?: readonly string[];
  /** Whether the user supplied a comment. True even when redaction drops the text. */
  hasComment: boolean;
  /** Redacted comment text. Omitted when capture is off, or the sanitizer drops it. */
  comment?: string;
}

/**
 * Emit `[MCP] Feedback Submitted`. Outcome props ride as `trackToolEvent`'s
 * `properties`, so they win over a colliding `extra` key. The anonymous-floor
 * skip rule applies inside `trackToolEvent`.
 *
 * @internal
 */
export function emitFeedbackSubmitted(
  amplitude: AmplitudeClientLike,
  ctx: McpToolContext,
  fields: FeedbackSubmittedFields,
): void {
  const properties: Record<string, unknown> = {
    [K.feedbackHelpful]: fields.helpful,
    [K.feedbackHasComment]: fields.hasComment,
  };

  if (fields.reason != null) properties[K.feedbackReason] = fields.reason;
  if (fields.solicited != null) properties[K.feedbackSolicited] = fields.solicited;
  if (fields.toolNames != null && fields.toolNames.length > 0) {
    properties[K.feedbackToolNames] = [...fields.toolNames];
  }
  if (fields.comment != null && fields.comment.length > 0) {
    properties[K.feedbackComment] = fields.comment;
  }

  trackToolEvent(amplitude, ctx, FEEDBACK_SUBMITTED, properties);
}
