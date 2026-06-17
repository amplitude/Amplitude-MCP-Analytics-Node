import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { MCPAnalyticsConfig } from './config.js';
import { createServerContext, runWithContext, setIdentity as setIdentityOnCtx } from './context/index.js';
import type { IdentityResolver, McpServerContext, McpTenant, McpToolContext, McpToolMeta, SetIdentityInput } from './context/types.js';
import { buildToolContext, resolveTransport } from './core/build-context.js';
import type { ServerIdentity } from './core/identity.js';
import {
  TrackingProxy,
  installTrackCounter,
  installTrackHook,
  registerExitHook,
  settleUnflushedCount,
} from './core/delivery/index.js';
import type { McpExtra, McpServerLike, Server, ToolResult, Transport } from './core/mcp.js';
import { buildToolError, classifyError, toolErrorResult, type ToolErrorInput } from './errors.js';
import { ConfigurationError } from './exceptions.js';
import { trackServerEvent } from './tracking/track-server-event.js';
import { trackToolEvent } from './tracking/track-tool-event.js';
import type { ContextExtractor } from './tracking/types.js';
import {
  type InstrumentedToolHandler,
  wrapTool as wrapToolFactory,
} from './tracking/wrap-tool.js';
import type { AmplitudeClientLike, AmplitudeEvent } from './types.js';
import { getLogger } from './utils/logger.js';
import { isBundlerEnvironment, tryRequire } from './utils/resolve-module.js';

/** Marks a server whose `connect` we've already wrapped, to stay idempotent. */
const INSTRUMENTED = Symbol.for('amplitude.mcp.instrumented');

/**
 * Static identity for `instrumentServer()`. Intended for stdio transports or
 * single-user servers where the identity is known for the server's lifetime.
 * Server identity of the fallback chain.
 */
export interface InstrumentServerOptions {
  userId?: string;
  deviceId?: string;
  tenant?: McpTenant;
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
  /**
   * Builds a server-scope `ctx` from the MCP SDK's per-request `extra`. Called
   * on every {@link AmplitudeMCPAnalytics.wrapTool} invocation to resolve
   * identity/tenant/auth/session for that request. The host owns this — the
   * SDK doesn't bake transport extraction in (that's MCP-366).
   *
   * Defaults to the anonymous floor with the configured server identity, which
   * the audit §2 skip rule then drops; supply a real extractor to actually
   * emit events from `wrapTool`.
   */
  extractContext?: ContextExtractor;
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

  /** Server-scope context inherited by every instrumented tool ctx. Set by a
   *  forthcoming server-binding API; until then tool wrapping runs untouched.
   *  @internal */
  protected _serverCtx?: McpServerContext;

  /** Pluggable per-request server-ctx builder for {@link wrapTool}. Defaults
   *  to the anonymous floor with the configured server identity. @internal */
  protected _extractContext: ContextExtractor;

  /** Static identity from `instrumentServer()` — server identity of the fallback chain. @internal */
  protected _serverIdentity?: ServerIdentity;

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
    this._extractContext =
      options.extractContext ??
      ((_extra) =>
        createServerContext({
          server: { name: this.serverName, version: this.serverVersion },
          // No transport assumption in the default — the audit §2 skip rule
          // will drop these events anyway (anonymous floor + no tenant).
          transport: 'stdio',
        }));

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
   * Set or override the subject identity on the current request's context.
   * Must be called inside an instrumented tool handler (or a `runWithContext`
   * block). This is the first step of the fallback chain that wins over all other
   * identity sources.
   *
   * @example Inside a tool handler (simplest):
   * ```typescript
   * server.tool('search', schema, analytics.instrumentTool('search', async (args, extra) => {
   *   analytics.setIdentity({
   *     userId: myAuth.getLoginId(),
   *     tenant: { groupType: 'org id', groupValue: myAuth.getOrgId() },
   *   });
   *   return doSearch(args);
   * }));
   * ```
   *
   * @example Inside a shared helper called from any depth:
   * ```typescript
   * function resolveAndSetIdentity() {
   *   const user = myAuth.getCurrentUser();
   *   analytics.setIdentity({ userId: user.loginId });
   * }
   * ```
   */
  setIdentity(input: SetIdentityInput): void {
    setIdentityOnCtx(input);
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
   * collision. Drops silently under the audit §2 skip rule (anonymous identity
   * AND no tenant) and on underlying client failure — never throws.
   */
  trackServerEvent(
    ctx: McpServerContext,
    eventName: string,
    properties?: Record<string, unknown>,
  ): void {
    trackServerEvent(this._amplitude, ctx, eventName, properties);
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
  ): void {
    trackToolEvent(this._amplitude, ctx, eventName, properties);
  }

  /**
   * Wrap an MCP tool handler so each invocation:
   *  - Builds a tool-scope `ctx` via the configured {@link ContextExtractor}
   *    extended with `meta`.
   *  - Runs the handler with `ctx` as its first argument, under
   *    `runWithContext(ctx)` so deep emit sites can fall back to
   *    {@link import('./context/index.js').getCurrentContext}.
   *  - Emits a stub `mcp: tool call response` event around the call (success +
   *    duration, or failure + error). The canonical emitter lands with MCP-358.
   *
   * Sync and async handlers are both supported — the wrapper preserves the
   * underlying return shape. Handler exceptions are re-thrown after the failure
   * event is emitted so the MCP SDK can surface them to the client.
   */
  wrapTool<Args extends unknown[], R extends ToolResult>(
    meta: McpToolMeta,
    handler: InstrumentedToolHandler<Args, R>,
  ): (...args: Args) => R {
    return wrapToolFactory(
      {
        amplitude: this._amplitude,
        extractContext: this._extractContext,
        serverIdentity: this._serverIdentity,
      },
      meta,
      handler,
    );
  }

  /**
   * Wrap a tool handler so each call builds the tool-scope `ctx` (extending the
   * server scope; ambient via `getCurrentContext()`) and runs the unchanged
   * handler. Returns the same handler type, so it drops into
   * `server.tool(name, schema, analytics.instrumentTool(name, handler, meta))`.
   * Until a server binding sets the server scope, the tool runs untouched.
   * Thrown exceptions are classified and stored on `ctx.error` for telemetry
   * but always re-thrown — the wrapper never swallows errors.
   *
   * @internal Not published yet — pending the default event contract.
   */
  instrumentTool<Args extends unknown[], R extends ToolResult>(
    name: string,
    handler: (...args: Args) => R,
    meta?: Omit<McpToolMeta, 'name'> & { resolveIdentity?: IdentityResolver },
  ): (...args: Args) => R {
    const toolMeta: McpToolMeta = { name, ...meta };

    const identityResolver = meta?.resolveIdentity;
    return (...callArgs: Args): R => {
      const serverCtx = this._serverCtx;
      if (serverCtx === undefined) return handler(...callArgs);

      const extra = callArgs[callArgs.length - 1] as McpExtra;
      const ctx = buildToolContext(serverCtx, toolMeta, extra, {
        resolveIdentity: identityResolver,
        serverIdentity: this._serverIdentity,
        logger: getLogger(this._amplitude),
      });

      return runWithContext(ctx, () => {
        let result: R;
        try {
          result = handler(...callArgs);
        } catch (err) {
          ctx.error = classifyError(err);
          throw err;
        }

        if (result && typeof (result as Promise<unknown>).then === 'function') {
          return (result as Promise<unknown>).catch((err: unknown) => {
            ctx.error = classifyError(err);
            throw err;
          }) as R;
        }

        return result;
      });
    };
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
  instrumentServer<S extends McpServerLike>(server: S, opts?: InstrumentServerOptions): S {
    const boundServer = server as McpServerLike & { [INSTRUMENTED]?: boolean };
    if (boundServer[INSTRUMENTED]) return server;

    if (opts != null && (opts.userId != null || opts.deviceId != null || opts.tenant != null)) {
      this._serverIdentity = {
        userId: opts.userId,
        deviceId: opts.deviceId,
        tenant: opts.tenant,
      };
    }

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
