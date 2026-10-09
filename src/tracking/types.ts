/**
 * Reserved field types for the event emitters. The wire property names 
 * are produced at emit time by `reservedFieldsToProperties`.
 */
import type { PrivacyConfig } from '../core/privacy.js';
import type {
  AnchorType,
  McpEpisodeAnchorConfidence,
  McpEpisodeAnchorType,
  McpTransport,
} from '../context/types.js';

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
  /** OAuth `client_id` from `extra.authInfo`; absent when unauthenticated. */
  oauthClientId?: string;
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
  conversationId?: string;
  runId?: string;
  turnId?: string;
  /** Host subject id, such as ChatGPT `openai/subject`. Not an Amplitude `user_id`. */
  subjectId?: string;
  episodeAnchorType?: McpEpisodeAnchorType;
  episodeAnchorConfidence?: McpEpisodeAnchorConfidence;
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
  /**
   * Built-in PII patterns for this call. Default `true`.
   *
   * Applies to the standalone `trackServerEvent` / `trackToolEvent` functions.
   * `AmplitudeMCPAnalytics.trackServerEvent` and `trackToolEvent` always use
   * the client's `MCPAnalyticsConfig` instead.
   * @default true
   */
  redactPii?: boolean;
  /**
   * Extra redaction rules for this call, applied after the built-in patterns.
   * Same shape as `MCPAnalyticsConfig.customRedactionPatterns`. Standalone
   * functions only; the client methods use the client's config.
   */
  customRedactionPatterns?: Array<string | { pattern: string; replacement: string }>;
  /**
   * Final redaction pass for this call. Standalone functions only; the client
   * methods use the client's config.
   */
  customRedactionFn?: (text: string) => string;
  /**
   * Resolved redaction policy. Supplied by the client from
   * `MCPAnalyticsConfig`. When set, the public redaction fields on this
   * options object are ignored.
   * @internal
   */
  privacy?: PrivacyConfig;
}
