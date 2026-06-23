import { MCPAnalyticsConfig } from './config.js';
import { createServerContext } from './context/index.js';
import type { McpServerContext, McpToolContext, McpToolMeta } from './context/types.js';
import { resolveTransport } from './core/build-context.js';
import {
  TrackingProxy,
  installTrackCounter,
  installTrackHook,
  registerExitHook,
  settleUnflushedCount,
} from './core/delivery/index.js';
import type {
  CallToolResult,
  McpServerLike,
  Server,
  ToolHandler,
  ToolResult,
  Transport,
} from './core/mcp.js';
import { buildToolError, toolErrorResult, type ToolErrorInput } from './errors.js';
import { ConfigurationError } from './exceptions.js';
import { trackServerEvent } from './tracking/track-server-event.js';
import { trackToolEvent } from './tracking/track-tool-event.js';
import type { TrackEventOptions } from './tracking/types.js';
import { instrumentTool as instrumentToolFactory } from './tracking/instrument-tool.js';
import type { AmplitudeClientLike, AmplitudeEvent } from './types.js';
import { getLogger } from './utils/logger.js';
import { isBundlerEnvironment, tryRequire } from './utils/resolve-module.js';

/** Marks a server whose `connect` we've already wrapped, to stay idempotent. */
const INSTRUMENTED = Symbol.for('amplitude.mcp.instrumented');

/** Reserved for future identity/tenant inputs (resolution is a later track). @internal */
export interface InstrumentServerOptions {
  [key: string]: unknown;
}

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
  /** @internal */
  protected _amplitude: AmplitudeClientLike;
  /** True when this SDK created the underlying client and must shut it down
   *  (apiKey path); false when the caller owns it. @internal */
  protected _ownsClient: boolean;
  /** Events tracked since the last flush()/shutdown(); drives the serverless
   *  exit warning. @internal */
  protected _trackCountSinceFlush = 0;

  /** Server-scope context inherited by every instrumented tool ctx, set by
   *  {@link instrumentServer}. When unset, {@link instrumentTool} is a no-op 
   *  passthrough (warns once) and the handler runs untouched. @internal */
  protected _serverCtx?: McpServerContext;

  constructor(options: AmplitudeMCPAnalyticsOptions) {
    if (!options.serverName) {
      throw new ConfigurationError('AmplitudeMCPAnalytics: serverName is required');
    }
    if (!options.serverVersion) {
      throw new ConfigurationError('AmplitudeMCPAnalytics: serverVersion is required');
    }
    if (options.amplitude != null && options.apiKey != null) {
      throw new ConfigurationError(
        "Provide either 'amplitude' or 'apiKey'. If you are already using an Amplitude client, pass the it via the 'amplitude' option. Only pass the api key if you want to initialize a new Amplitude client with different api key.",
      );
    }

    let rawAmplitude: AmplitudeClientLike;
    if (options.amplitude != null) {
      rawAmplitude = options.amplitude;
      this._ownsClient = false;
    } else if (options.apiKey != null) {
      const amplitudeNode = tryRequire('@amplitude/analytics-node') as
        | (AmplitudeClientLike & { init?: (apiKey: string) => unknown })
        | null;
      if (amplitudeNode == null || typeof amplitudeNode.init !== 'function') {
        if (isBundlerEnvironment) {
          throw new ConfigurationError(
            'Could not resolve @amplitude/analytics-node (likely a bundler environment such as Turbopack or Webpack). ' +
            "Pass a pre-initialized Amplitude client via the 'amplitude' option instead.",
          );
        }
        throw new ConfigurationError(
          '@amplitude/analytics-node is required. Install it as a dependency: npm install @amplitude/analytics-node',
        );
      }
      amplitudeNode.init(options.apiKey);
      rawAmplitude = amplitudeNode;
      this._ownsClient = true;
    } else {
      throw new ConfigurationError(
        "AmplitudeMCPAnalytics: provide either an existing Amplitude instance via 'amplitude' or an API key via 'apiKey'.",
      );
    }

    this.serverName = options.serverName;
    this.serverVersion = options.serverVersion;
    this.config = options.config ?? new MCPAnalyticsConfig();

    // Wrap the raw client in a mutable proxy (it may be a frozen ES module
    // namespace) and install the delivery hooks. Order matters: the counter
    // goes on first so the track hook — which decides dry-run skips — sits
    // outermost and dry-run events are never counted as unflushed.
    const proxy = new TrackingProxy(rawAmplitude);
    installTrackCounter(proxy, () => {
      this._trackCountSinceFlush++;
    });
    installTrackHook(proxy, this.config);
    registerExitHook();
    this._amplitude = proxy;
  }

  /** @internal Low-level passthrough to the underlying Amplitude client. */
  track(event: AmplitudeEvent): void {
    this._amplitude.track(event);
  }

  /**
   * Build a structured MCP error response and store the error on `ctx` for
   * telemetry. Returns a valid `CallToolResult` with `isError: true` and a
   * client-facing message that includes the correction guidance.
   *
   * @example
   * ```typescript
   * return analytics.toolError(ctx, {
   *   code: 'missing_chart_id',
   *   message: 'No chart ID was provided.',
   *   correctionMessage: 'Search for a chart first, then retry with the chart ID.',
   *   recoverable: true,
   *   source: 'mcp_server',
   * });
   * ```
   */
  toolError(ctx: McpToolContext, input: ToolErrorInput): CallToolResult {
    const error = buildToolError(input);
    ctx.error = error;
    return toolErrorResult(error);
  }

  /**
   * Emit a server-scope custom event. Inherits identity/tenant/session/client/
   * server/auth/transport/trace from `ctx`; caller-supplied properties win on
   * collision. Drops silently when the event has neither an identity nor a
   * tenant, and on underlying client failure — never throws.
   */
  trackServerEvent(
    ctx: McpServerContext,
    eventName: string,
    properties?: Record<string, unknown>,
    options?: TrackEventOptions,
  ): void {
    trackServerEvent(this._amplitude, ctx, eventName, properties, options);
  }

  /**
   * Emit a tool-scope custom event. Same contract as {@link trackServerEvent}
   * plus the tool metadata (`tool name`, `tool owner`, `tool tags`, `tool
   * category`, `project id`, `project name`, `request method`) inherited from
   * the tool-scope `ctx`.
   */
  trackToolEvent(
    ctx: McpToolContext,
    eventName: string,
    properties?: Record<string, unknown>,
    options?: TrackEventOptions,
  ): void {
    trackToolEvent(this._amplitude, ctx, eventName, properties, options);
  }

  /**
   * Instrument an MCP tool handler — the single tool-instrumentation entry
   * point. The returned function drops into the MCP SDK's
   * `server.tool(name, schema, fn)` slot.
   *
   * On each call it builds the per-request tool-scope `ctx` (transport-aware
   * anchor, `_meta` client info, protocol version) from the server scope bound
   * by {@link instrumentServer}, runs your **unchanged** handler under
   * `runWithContext(ctx)` (so it can reach `ctx` via `getCurrentContext()` and
   * the `track*` methods take it explicitly), emits a stub
   * `mcp: tool call response` event (success + duration, or failure), and
   * classifies thrown errors onto `ctx.error`. Errors are re-thrown so the MCP
   * SDK surfaces them; the best-effort guarantee applies only to emission.
   *
   * **Requires {@link instrumentServer}.** If the server was never bound, this
   * is a no-op passthrough: the original handler runs untouched and NO event is
   * emitted (it also warns once). Analytics is opt-in via `instrumentServer`.
   *
   * @example
   * ```typescript
   * analytics.instrumentServer(server);               // enables analytics
   * server.tool('search', schema, analytics.instrumentTool(
   *   async (args, extra) => doSearch(args),          // your handler, unchanged
   *   { name: 'search', owner: 'docs-team', extra: { 'feature flag': 'new-ranker' } },
   * ));
   * ```
   *
   * @internal Not published yet — pending the public tool-instrumentation contract.
   */
  instrumentTool<Args extends unknown[], R extends ToolResult>(
    handler: ToolHandler<Args, R>,
    meta: McpToolMeta,
  ): (...args: Args) => R {
    return instrumentToolFactory(
      {
        amplitude: this._amplitude,
        // Resolved per invocation: `_serverCtx` is set late (by instrumentServer's
        // connect wrapper) and undefined until then.
        getServerCtx: () => this._serverCtx,
      },
      handler,
      meta,
    );
  }

  /**
   * Bind a server so its instrumented tools inherit a server-scope context.
   * Wraps `connect` to auto-detect the transport (fixed per connection) and set
   * `_serverCtx`, and captures the handshake `clientInfo` (legacy/stdio path).
   * Call **before** `connect` — the transport only exists then. Returns the same
   * server for chaining. Idempotent; warns and no-ops if already connected.
   *
   * @example
   * ```typescript
   * const server = new McpServer({ name: 'my-mcp', version: '1.0.0' });
   * analytics.instrumentServer(server);               // before connect
   * await server.connect(new StdioServerTransport()); // transport auto-detected
   * ```
   *
   * @internal Not published yet — pending the public server-binding contract.
   */
  instrumentServer<S extends McpServerLike>(server: S, _opts?: InstrumentServerOptions): S {
    const boundServer = server as McpServerLike & { [INSTRUMENTED]?: boolean };
    if (boundServer[INSTRUMENTED]) return server;

    // `isConnected()` is only on the high-level McpServer.
    if ('isConnected' in boundServer && boundServer.isConnected()) {
      getLogger(this._amplitude).warn(
        'instrumentServer() was called after the server connected; the transport could not be detected, so instrumented tools will run without analytics context. Call instrumentServer() before server.connect().',
      );
      return server;
    }
    boundServer[INSTRUMENTED] = true;

    // The low-level Server holding the handshake hooks: `.server` on McpServer,
    // else the object itself.
    const lowLevelServer: Server = 'server' in boundServer ? boundServer.server : boundServer;
    // Capture the current `connect` and delegate, so we compose with a
    // consumer's own connect wrapper regardless of order.
    const originalConnect = boundServer.connect.bind(boundServer);

    boundServer.connect = (transport: Transport): Promise<void> => {
      this._serverCtx = createServerContext({
        server: { name: this.serverName, version: this.serverVersion },
        transport: resolveTransport(transport),
      });
      // Capture the handshake `clientInfo` into the server scope (legacy / stdio
      // path), chaining any handler the consumer already installed.
      const existingOnInitialized = lowLevelServer.oninitialized;
      lowLevelServer.oninitialized = (): void => {
        const clientInfo = lowLevelServer.getClientVersion();
        if (clientInfo != null && this._serverCtx != null) {
          this._serverCtx.client = { ...this._serverCtx.client, name: clientInfo.name, version: clientInfo.version };
        }
        existingOnInitialized?.();
      };
      return originalConnect(transport);
    };

    return server;
  }

  flush(): unknown {
    settleUnflushedCount(this._trackCountSinceFlush);
    this._trackCountSinceFlush = 0;
    return this._amplitude.flush();
  }

  shutdown(): void {
    settleUnflushedCount(this._trackCountSinceFlush);
    this._trackCountSinceFlush = 0;
    // Only tear down the underlying client if we created it — never shut down
    // a client the caller passed in and may still be using.
    if (this._ownsClient) {
      this._amplitude.shutdown?.();
    }
  }
}

/**
 * Construct an {@link AmplitudeMCPAnalytics} client — a factory equivalent to
 * `new AmplitudeMCPAnalytics(options)`, for callers who prefer a function over
 * `new`.
 *
 * @example
 * ```typescript
 * import { createMcpAnalytics } from '@amplitude/mcp-analytics';
 *
 * const analytics = createMcpAnalytics({
 *   apiKey: process.env.AMPLITUDE_API_KEY!,
 *   serverName: 'my-mcp-server',
 *   serverVersion: '1.0.0',
 * });
 * ```
 */
export function createMcpAnalytics(
  options: AmplitudeMCPAnalyticsOptions,
): AmplitudeMCPAnalytics {
  return new AmplitudeMCPAnalytics(options);
}
