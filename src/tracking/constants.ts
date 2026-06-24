export const NO_SESSION = 'no-session';
export const UNKNOWN = 'unknown';

/** Default tool-execution event. */
export const TOOL_CALL_RESPONSE = 'mcp: tool call response';

/**
 * Default server connection / capability events. Session lifecycle
 * events apply only where a protocol session exists — stdio and legacy
 * (`2025-11-25`) Streamable HTTP; they are never fabricated on `2026-07-28+`
 * stateless HTTP (no `initialize` handshake fires there).
 */
export const SESSION_INITIALIZED = 'mcp: session initialized';
export const SESSION_ENDED = 'mcp: session ended';
export const TOOLS_LISTED = 'mcp: tools listed';

/** Upper bound on `tool names` emitted on `mcp: tools listed`; larger lists are
 *  truncated to this many names and flagged `tool names truncated` (the `tool
 *  count` always reflects the true total). */
export const TOOL_NAMES_MAX = 100;

/**
 * camelCase → wire property-name map for the default events: the reserved
 * ctx-derived fields plus the tool-call outcome keys.
 */
export const EVENT_PROPERTY_KEYS = {
  // server-scope reserved fields
  sessionId: '[MCP] Session ID',
  clientName: 'client name',
  clientVersion: 'client version',
  userAgent: 'user agent',
  serverName: 'server name',
  serverVersion: 'server version',
  transport: 'transport',
  anchorType: 'anchor type',
  serverType: 'server type',
  protocolVersion: 'protocol version',
  authType: 'auth type',
  // tool-scope reserved fields
  toolName: 'tool name',
  toolOwner: 'tool owner',
  toolTags: 'tool tags',
  toolCategory: 'tool category',
  // tool-call outcome
  isError: 'is error',
  errorMessage: 'error message',
  errorType: 'error type',
  responseDuration: 'response duration',
  responseSize: 'response size',
  requestSize: 'request size',
  // server connection / capability outcome
  toolCount: 'tool count',
  toolNames: 'tool names',
  toolNamesTruncated: 'tool names truncated',
  sessionDuration: 'session duration',
} as const;

