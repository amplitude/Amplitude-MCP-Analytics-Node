export interface MCPAnalyticsConfigOptions {
  /** Emit verbose internal logging to the console. Off by default. */
  debug?: boolean;
  /** When true, the SDK builds events normally but does not deliver them. */
  dryRun?: boolean;
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
 *   config: new MCPAnalyticsConfig({ debug: true }),
 * });
 * ```
 */
export class MCPAnalyticsConfig {
  readonly debug: boolean;
  readonly dryRun: boolean;

  constructor(options: MCPAnalyticsConfigOptions = {}) {
    this.debug = options.debug ?? false;
    this.dryRun = options.dryRun ?? false;
  }
}
