export const NO_SESSION = 'no-session';
export const UNKNOWN = 'unknown';

/** Default tool-execution event. */
export const TOOL_CALL_RESPONSE = 'mcp: tool call response';

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
  toolErrorMessage: 'tool error message',
  errorType: 'tool error type',
  responseDuration: 'response duration',
  responseSize: 'response size',
  requestSize: 'request size',
} as const;

