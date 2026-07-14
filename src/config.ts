/** Per-family toggles for the SDK's auto-captured (default) events — the events
 *  emitted automatically by `instrumentServer` / `instrumentTool` without an
 *  explicit `track*` call. */
export interface AutocaptureConfig {
  /**
   * Umbrella default for the server connection / capability events:
   * `[MCP] Session Initialized`, `[MCP] Session Ended`, `[MCP] Tools Listed`.
   * Overridable per sub-family via {@link sessionLifecycle} /
   * {@link toolsListed} — e.g. hosts that build one `McpServer` per HTTP
   * request typically want `{ sessionLifecycle: false, toolsListed: true }`,
   * because there a transport closes at the end of every request, not at
   * session end.
   * @default true
  */
  serverEvents?: boolean;
  /**
   * `[MCP] Session Initialized` + `[MCP] Session Ended`.
   * @default the `serverEvents` value
   */
  sessionLifecycle?: boolean;
  /**
   * `[MCP] Tools Listed`.
   * @default the `serverEvents` value
   */
  toolsListed?: boolean;
  /**
   * Tool-execution events: `[MCP] Tool Call Response` (dispatched calls) and
   * `[MCP] Tool Call Rejected` (`tools/call` requests that fail before any
   * tool callback runs).
   * @default true
   */
  toolCalls?: boolean;
}

export interface MCPAnalyticsConfigOptions {
  /** 
   * Emit verbose internal logging to the console.
   * @default false
   */
  debug?: boolean;
  /** 
   * When true, the SDK builds events normally but does not deliver them.
   * @default false
   */
  dryRun?: boolean;
  /**
   * Which events the SDK captures automatically, without an explicit `track*`
   * call. `true` (default) or `false` toggles every family at once; pass an
   * object to toggle families independently (e.g. `{ serverEvents: false }`).
   * Mirrors Amplitude's `autocapture` option.
   * @default { serverEvents: true, toolCalls: true }
   */
  autocapture?: boolean | AutocaptureConfig;
  /**
   * Whether to emit events for a fully anonymous subject — one with no supplied
   * or derivable identity AND no tenant, resolved to the per-request anonymous
   * floor. Each such request mints a fresh synthetic `device_id`, so emitting
   * them inflates unique-user/device counts with values that never recur (no
   * cross-call stitching). Left `false` by default so those events are dropped
   * rather than polluting attribution; set `true` to emit them as honest
   * aggregate-only data.
   * @default false
   */
  emitAnonymousEvent?: boolean;
}

const ALL_ON: Required<AutocaptureConfig> = {
  serverEvents: true,
  sessionLifecycle: true,
  toolsListed: true,
  toolCalls: true,
};

/** Normalize the `autocapture` option into resolved per-family flags. */
function resolveAutocapture(
  option: boolean | AutocaptureConfig | undefined,
): Required<AutocaptureConfig> {
  if (option === undefined || option === true) return { ...ALL_ON };
  if (option === false) {
    return {
      serverEvents: false,
      sessionLifecycle: false,
      toolsListed: false,
      toolCalls: false,
    };
  }

  const serverEvents = option.serverEvents ?? true;
  return {
    serverEvents,
    sessionLifecycle: option.sessionLifecycle ?? serverEvents,
    toolsListed: option.toolsListed ?? serverEvents,
    toolCalls: option.toolCalls ?? true,
  };
}

/**
 * Configuration for the Amplitude MCP Analytics SDK.
 *
 * Intentionally minimal in v0 — additional knobs (privacy, content modes,
 * event-validation, onEvent hooks) will be added as the features that need
 * them land.
 *
 * @example
 * ```typescript
 * import { AmplitudeMCPAnalytics, MCPAnalyticsConfig } from '@amplitude/mcp-analytics';
 *
 * const analytics = new AmplitudeMCPAnalytics({
 *   apiKey: process.env.AMPLITUDE_API_KEY!,
 *   serverName: 'my-mcp-server',
 *   serverVersion: '1.0.0',
 *   config: new MCPAnalyticsConfig({ autocapture: { serverEvents: false } }),
 * });
 * ```
 */
export class MCPAnalyticsConfig {
  readonly debug: boolean;
  readonly dryRun: boolean;
  /** Resolved per-family autocapture flags, normalized from the option. */
  readonly autocapture: Required<AutocaptureConfig>;
  /** Emit events for the fully anonymous, tenant-less floor. @see MCPAnalyticsConfigOptions.emitAnonymousEvent */
  readonly emitAnonymousEvent: boolean;

  constructor(options: MCPAnalyticsConfigOptions = {}) {
    this.debug = options.debug ?? false;
    this.dryRun = options.dryRun ?? false;
    this.autocapture = resolveAutocapture(options.autocapture);
    this.emitAnonymousEvent = options.emitAnonymousEvent ?? false;
  }
}
