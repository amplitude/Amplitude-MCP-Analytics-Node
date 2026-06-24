export const NO_SESSION = 'no-session';
export const UNKNOWN = 'unknown';

/** Default tool-execution event. */
export const TOOL_CALL_RESPONSE = '[MCP] Tool Call Response';

/**
 * Default server connection / capability events. Session lifecycle
 * events apply only where a protocol session exists — stdio and legacy
 * (`2025-11-25`) Streamable HTTP; they are never fabricated on `2026-07-28+`
 * stateless HTTP (no `initialize` handshake fires there).
 */
export const SESSION_INITIALIZED = '[MCP] Session Initialized';
export const SESSION_ENDED = '[MCP] Session Ended';
export const TOOLS_LISTED = '[MCP] Tools Listed';

/** Upper bound on `[MCP] Tool Names` emitted on `[MCP] Tools Listed`; larger
 *  lists are truncated to this many names and flagged `[MCP] Tool Names
 *  Truncated` (the `[MCP] Tool Count` always reflects the true total). */
export const TOOL_NAMES_MAX = 100;

/**
 * camelCase → wire property-name map for the default events: the reserved
 * ctx-derived fields plus the tool-call outcome keys. Every property carries the
 * `[MCP] ` prefix so MCP analytics never collide with same-named properties on
 * other Amplitude events (e.g. a native `session id`).
 */
export const EVENT_PROPERTY_KEYS = {
  // server-scope reserved fields
  sessionId: '[MCP] Session ID',
  clientName: '[MCP] Client Name',
  clientVersion: '[MCP] Client Version',
  userAgent: '[MCP] User Agent',
  serverName: '[MCP] Server Name',
  serverVersion: '[MCP] Server Version',
  transport: '[MCP] Transport',
  anchorType: '[MCP] Anchor Type',
  serverType: '[MCP] Server Type',
  protocolVersion: '[MCP] Protocol Version',
  authType: '[MCP] Auth Type',
  // tool-scope reserved fields
  toolName: '[MCP] Tool Name',
  toolOwner: '[MCP] Tool Owner',
  toolTags: '[MCP] Tool Tags',
  toolCategory: '[MCP] Tool Category',
  // tool-call outcome
  isError: '[MCP] Is Error',
  errorMessage: '[MCP] Error Message',
  errorType: '[MCP] Error Type',
  responseDuration: '[MCP] Response Duration',
  responseSize: '[MCP] Response Size',
  requestSize: '[MCP] Request Size',
  // server connection / capability outcome
  toolCount: '[MCP] Tool Count',
  toolNames: '[MCP] Tool Names',
  toolNamesTruncated: '[MCP] Tool Names Truncated',
  sessionDuration: '[MCP] Session Duration',
} as const;
