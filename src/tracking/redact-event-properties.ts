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
import type { PrivacyConfig } from '../core/privacy.js';
import { EVENT_PROPERTY_KEYS } from './constants.js';

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
