/**
 * Apply a {@link PrivacyConfig} to a merged event-property bag.
 *
 * Dimension keys (everything in {@link EVENT_PROPERTY_KEYS} except rationale
 * and error message) pass through unchanged so attribution stays intact.
 * Every other value — `extra`, caller properties, `[MCP] Rationale`,
 * `[MCP] Error Message`, and `[MCP] Param:` derived strings — is redacted.
 *
 * @internal
 */
import { PrivacyConfig } from '../core/privacy.js';
import { EVENT_PROPERTY_KEYS } from './constants.js';
import type { TrackEventOptions } from './types.js';

/** Built-in PII patterns, used when a caller does not pass a policy. */
const DEFAULT_PRIVACY = new PrivacyConfig({ redactPii: true });

/**
 * Policy for one emit. A client-supplied {@link PrivacyConfig} wins. Otherwise
 * the standalone redaction fields on `options` are compiled, defaulting to
 * built-in patterns on.
 *
 * @internal
 */
export function resolveEventPrivacy(options?: TrackEventOptions): PrivacyConfig {
  if (options?.privacy != null) return options.privacy;
  if (
    options?.redactPii === undefined &&
    options?.customRedactionPatterns == null &&
    options?.customRedactionFn == null
  ) {
    return DEFAULT_PRIVACY;
  }
  return new PrivacyConfig({
    redactPii: options.redactPii ?? true,
    customRedactionPatterns: options.customRedactionPatterns,
    customRedactionFn: options.customRedactionFn,
  });
}

const FREE_TEXT_RESERVED = new Set<string>([
  EVENT_PROPERTY_KEYS.rationale,
  EVENT_PROPERTY_KEYS.errorMessage,
]);

const DIMENSION_KEYS = new Set<string>(
  Object.values(EVENT_PROPERTY_KEYS).filter((key) => !FREE_TEXT_RESERVED.has(key)),
);

/** @internal */
export function redactFreeformProperties(
  properties: Record<string, unknown>,
  privacy: PrivacyConfig,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    out[key] = DIMENSION_KEYS.has(key) ? value : privacy.redactValue(value);
  }
  return out;
}
