/**
 * Applies the configured {@link ErrorMessageSanitizer} to `[MCP] Error Message`.
 *
 * Every event that carries the property routes its value through here, so a
 * consumer's sanitizer cannot be bypassed by whichever code path happens to be
 * emitting — see the `sanitizeErrorMessage` config option.
 */
import type { ErrorMessageSanitizer } from '../config.js';

/**
 * Resolve the value to emit for `[MCP] Error Message`, or `undefined` to omit
 * the property.
 *
 * With no sanitizer configured the message passes through unchanged (the v0
 * default). Otherwise the property is omitted whenever the sanitizer declines
 * to produce a string — an explicit `null`, a non-string return, or a throw.
 *
 * Throwing **fails closed** rather than falling back to `message`: a sanitizer
 * exists to keep that exact value out of the event stream, so a buggy one must
 * not leak what it was installed to scrub. The throw is swallowed to preserve
 * the SDK's best-effort telemetry contract — emitting an event must never break
 * the tool response it describes.
 *
 * @internal
 */
export function sanitizeErrorMessage(
  message: string,
  sanitize: ErrorMessageSanitizer | undefined,
): string | undefined {
  if (sanitize == null) return message;

  try {
    const sanitized = sanitize(message);
    return typeof sanitized === 'string' ? sanitized : undefined;
  } catch {
    return undefined;
  }
}
