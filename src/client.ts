import { MCPAnalyticsConfig } from './config.js';
import type { AmplitudeClientLike, AmplitudeEvent } from './types.js';
import { isBundlerEnvironment, tryRequire } from './utils/resolve-module.js';

export interface AmplitudeMCPAnalyticsOptions {
  /** Logical name of the MCP server being instrumented. */
  serverName: string;
  /** Version string of the MCP server being instrumented. */
  serverVersion: string;
  /** Pre-constructed Amplitude client. Use this when the host app already
   *  owns an Amplitude client instance. Mutually exclusive with `apiKey`. */
  amplitude?: AmplitudeClientLike;
  /** Amplitude project API key. Mutually exclusive with `amplitude`. */
  apiKey?: string;
  /** Optional SDK configuration. */
  config?: MCPAnalyticsConfig;
}

/**
 * Main Amplitude MCP Analytics client for tracking MCP server activity.
 *
 * Construct with either an API key (which initializes a fresh
 * `@amplitude/analytics-node` client under the hood) or a pre-built
 * Amplitude client owned by the host application. The server identity
 * (`serverName`, `serverVersion`) is required and is attached to every
 * emitted event.
 *
 * @example
 * ```typescript
 * import { AmplitudeMCPAnalytics } from '@amplitude/mcp-analytics';
 *
 * const analytics = new AmplitudeMCPAnalytics({
 *   apiKey: process.env.AMPLITUDE_API_KEY!,
 *   serverName: 'my-mcp-server',
 *   serverVersion: '1.0.0',
 * });
 * ```
 *
 * @example Reusing an existing Amplitude client:
 * ```typescript
 * import * as amplitude from '@amplitude/analytics-node';
 * amplitude.init('YOUR_KEY');
 *
 * const analytics = new AmplitudeMCPAnalytics({
 *   amplitude,
 *   serverName: 'my-mcp-server',
 *   serverVersion: '1.0.0',
 * });
 * ```
 */
export class AmplitudeMCPAnalytics {
  readonly serverName: string;
  readonly serverVersion: string;
  readonly config: MCPAnalyticsConfig;
  protected _amplitude: AmplitudeClientLike;

  constructor(options: AmplitudeMCPAnalyticsOptions) {
    if (!options.serverName) {
      throw new Error('AmplitudeMCPAnalytics: serverName is required');
    }
    if (!options.serverVersion) {
      throw new Error('AmplitudeMCPAnalytics: serverVersion is required');
    }

    let rawAmplitude: AmplitudeClientLike;
    if (options.amplitude != null) {
      rawAmplitude = options.amplitude;
    } else if (options.apiKey != null) {
      const amplitudeNode = tryRequire('@amplitude/analytics-node') as
        | (AmplitudeClientLike & { init?: (apiKey: string) => unknown })
        | null;
      if (amplitudeNode == null || typeof amplitudeNode.init !== 'function') {
        if (isBundlerEnvironment) {
          throw new Error(
            'Could not resolve @amplitude/analytics-node (likely a bundler environment such as Turbopack or Webpack). ' +
            "Pass a pre-initialized Amplitude client via the 'amplitude' option instead.",
          );
        }
        throw new Error(
          '@amplitude/analytics-node is required. Install it as a dependency: npm install @amplitude/analytics-node',
        );
      }
      amplitudeNode.init(options.apiKey);
      rawAmplitude = amplitudeNode;
    } else {
      throw new Error(
        "AmplitudeMCPAnalytics: provide either an existing Amplitude instance via 'amplitude' or an API key via 'apiKey'.",
      );
    }

    this.serverName = options.serverName;
    this.serverVersion = options.serverVersion;
    this.config = options.config ?? new MCPAnalyticsConfig();
    this._amplitude = rawAmplitude;
  }

  /** @internal Low-level passthrough to the underlying Amplitude client. */
  track(event: AmplitudeEvent): void {
    this._amplitude.track(event);
  }

  flush(): unknown {
    return this._amplitude.flush();
  }

  shutdown(): void {
    this._amplitude.shutdown?.();
  }
}
