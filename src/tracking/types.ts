/**
 * Shared types for the custom event API (`trackServerEvent`, `trackToolEvent`,
 * `instrumentTool`). The `ctx → AmplitudeFields` shape is the seam every emit
 * site lowers through, so it lives here as a stable contract.
 */

/**
 * Internal shape `ctxToAmplitudeFields` lowers to — the parts of an
 * {@link import('../types.js').AmplitudeEvent} derived from `ctx` alone, before
 * caller-supplied properties are merged in. `event_properties` is always
 * present (possibly empty) so callers can spread without an undefined guard.
 */
export interface AmplitudeFields {
  user_id?: string;
  device_id?: string;
  groups?: Record<string, string>;
  event_properties: Record<string, unknown>;
}
