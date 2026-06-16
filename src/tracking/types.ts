/**
 * Shared types for the custom event API (`trackServerEvent`, `trackToolEvent`,
 * `wrapTool`). The `ctx → AmplitudeFields` shape is the seam every emit site
 * lowers through, so it lives here as a stable contract.
 */
import type { McpServerContext } from '../context/types.js';
import type { McpExtra } from '../core/mcp.js';

/**
 * Builds an {@link McpServerContext} from the MCP SDK's per-request `extra`.
 *
 * The pluggable integration seam for `wrapTool`: the host application supplies
 * an extractor that resolves identity/tenant/auth/session from `extra` (and any
 * server-owned state it has on hand). The SDK does not bake transport
 * extraction in — that's owned by a sibling track (MCP-366).
 *
 * The default (when no extractor is configured) returns the anonymous-floor
 * server ctx; the skip rule will drop the resulting event unless the host has
 * configured tenancy elsewhere.
 */
export type ContextExtractor = (extra: McpExtra) => McpServerContext;

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
