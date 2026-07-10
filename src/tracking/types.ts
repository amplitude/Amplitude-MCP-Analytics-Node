/**
 * Reserved field types for the event emitters. The wire property names 
 * are produced at emit time by `reservedFieldsToProperties`.
 */
import type { AnchorType, McpTransport } from '../context/types.js';

/** Reserved, SDK-derived fields shared by every event. */
export interface DefaultServerFields {
  /** `'no-session'` when the anchor is not a session id. */
  sessionId: string;
  /** `'unknown'` when absent. */
  clientName: string;
  /** `'unknown'` when absent. */
  userAgent: string;
  serverName: string;
  transport: McpTransport;
  anchorType: AnchorType;
  clientVersion?: string;
  serverVersion?: string;
  serverType?: string;
  protocolVersion?: string;
  authType?: string;
}

/** Reserved tool-scope fields — extends the server-scope set. */
export interface DefaultToolFields extends DefaultServerFields {
  toolName: string;
  toolOwner?: string;
  toolTags?: string[];
  toolCategory?: string;
  /** Host-supplied via `setRationale()`; absent unless the host opted in. */
  rationale?: string;
  /** Transport HTTP status of the response; host-supplied via
   *  `ctx.request.responseHttpStatus` (see `McpRequestInfo`). */
  responseHttpStatus?: number;
}

/** What the ctx mappers return: identity fields, typed reserved 
 * `event_properties`, and the `extra` bag. 
 */
export interface AmplitudeFields<F extends DefaultServerFields> {
  user_id?: string;
  device_id?: string;
  groups?: Record<string, string>;
  event_properties: F;
  extraProperties: Record<string, unknown>;
}

/** Options for the custom-event emitters. */
export interface TrackEventOptions {
  /** Omit the ctx `extra` bags from this event. Off by default. */
  dropExtraProps?: boolean;
}
