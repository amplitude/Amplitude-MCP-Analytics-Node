import { MCPAnalyticsConfig } from './config.js';
import {
  createServerContext,
  setIdentity as setIdentityOnCtx,
  setRationale as setRationaleOnCtx,
} from './context/index.js';
import type { IdentityResolver, McpServerContext, McpTenant, McpToolContext, McpToolMeta, SetIdentityInput } from './context/types.js';
import { buildServerContext, resolveTransport } from './core/build-context.js';
import {
  TrackingProxy,
  installTrackCounter,
  installTrackHook,
  registerExitHook,
  settleUnflushedCount,
} from './core/delivery/index.js';
import type {
  CallToolResult,
  McpExtra,
  McpServerLike,
  Server,
  ToolHandler,
  ToolResult,
  Transport,
} from './core/mcp.js';
import { byteSize } from './core/serialize.js';
import { installToolsListHook } from './core/tools-list-hook.js';
import { buildToolError, classifyError, toolErrorResult, type ToolErrorInput } from './errors.js';
import { ConfigurationError } from './exceptions.js';
import {
  emitSessionEnded,
  emitSessionInitialized,
  emitToolsListed,
} from './tracking/events/index.js';
import { trackServerEvent } from './tracking/track-server-event.js';
import { trackToolEvent } from './tracking/track-tool-event.js';
import type { TrackEventOptions } from './tracking/types.js';
import { instrumentTool as instrumentToolFactory } from './tracking/instrument-tool.js';
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
  /** How subjects authenticate to this server (e.g. `'oauth'`). Emitted as
   *  `[MCP] Auth Type` on every event derived from the server scope. */
  authType?: string;
  /**
   * Custom enrichment attached to the server scope. These key/value pairs are
   * emitted as event properties on every event derived from this server —
   * including the default connection events (`[MCP] Session Initialized` /
   * `[MCP] Session Ended` / `[MCP] Tools Listed`). On collision the SDK's
   * per-event outcome values win; avoid `[MCP] `-prefixed keys, which are
   * reserved for SDK-derived properties.
   */
  extra?: Record<string, unknown>;
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

  /** Server-scope context, set by {@link instrumentServer}. Every per-request 
   *  ctx is built from it and inherits the server info, and the server-scope 
   *  events read it directly. When unset, {@link instrumentTool} is a no-op 
   *  passthrough (warns once) and the handler runs untouched. @internal */
  protected _serverCtx?: McpServerContext;

  /** Static identity from `instrumentServer(server, opts)`. @internal */
  protected _serverIdentity?: { userId?: string; deviceId?: string; tenant?: McpTenant };

  /** Handshake timestamp (ms) — set only on the session-bearing transports
   *  (stdio + legacy HTTP, which handshake), `undefined` on stateless HTTP. 
   *  Also serves as the "a session is active" flag. @internal */
  protected _sessionStartMs?: number;

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
   * Set or override the subject identity on the current request's context.
   * Must be called inside an instrumented tool handler (or a `runWithContext`
   * block). This is the first step of the fallback chain that wins over all other
   * identity sources.
   *
   * @example Inside a tool handler (simplest):
   * ```typescript
   * server.tool('search', schema, analytics.instrumentTool(
   *   async (args, extra) => {
   *     analytics.setIdentity({
   *       userId: myAuth.getLoginId(),
   *       tenant: { groupType: 'org id', groupValue: myAuth.getOrgId() },
   *     });
   *     return doSearch(args);
   *   },
   *   { name: 'search' },
   * ));
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
   * Set the rationale ("why the agent called this tool") for the current tool
   * invocation. Must be called inside an instrumented tool handler (or a
   * `runWithContext` block), at any call depth. Emitted as the reserved
   * `[MCP] Rationale` property on the default `[MCP] Tool Call Response`
   * event and on every tool-scope custom event of the same invocation.
   *
   * The SDK never reads rationale out of tool inputs itself — where it lives
   * (a tool argument, `_meta`, a header, a derived value) is your convention,
   * and rationale is content-bearing free text, so emitting it is an explicit
   * opt-in. Truncated to 1000 characters; last write wins.
   *
   * @example
   * ```typescript
   * server.tool('search', schema, analytics.instrumentTool(
   *   async (args, extra) => {
   *     if (typeof args.rationale === 'string') {
   *       analytics.setRationale(args.rationale);
   *     }
   *     return doSearch(args);
   *   },
   *   { name: 'search' },
   * ));
   * ```
   */
  setRationale(rationale: string): void {
    setRationaleOnCtx(rationale);
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
   * the `track*` methods take it explicitly), emits a
   * `[MCP] Tool Call Response` event (success + duration, or failure), and
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
   */
  instrumentTool<Args extends unknown[], R extends ToolResult>(
    handler: ToolHandler<Args, R>,
    meta: McpToolMeta,
    opts?: { resolveIdentity?: IdentityResolver },
  ): (...args: Args) => R {
    return instrumentToolFactory(
      {
        amplitude: this._amplitude,
        getServerCtx: () => this._serverCtx,
        resolveIdentity: opts?.resolveIdentity,
        serverIdentity: this._serverIdentity,
        trackToolCalls: this.config.autocapture.toolCalls,
        logger: getLogger(this._amplitude),
      },
      handler,
      meta,
    );
  }

  /**
   * Bind a server so its instrumented tools inherit a server-scope context and
   * the SDK emits the default connection events (`[MCP] Session Initialized` /
   * `[MCP] Session Ended` / `[MCP] Tools Listed`). Wraps `connect` to auto-detect
   * the transport (fixed per connection), captures the handshake `clientInfo`,
   * and emits the lifecycle events at the points it controls. Call **before**
   * `connect` — the transport only exists then. Returns the same server for
   * chaining. Idempotent; warns and no-ops if already connected.
   *
   * @example
   * ```typescript
   * const server = new McpServer({ name: 'my-mcp', version: '1.0.0' });
   * analytics.instrumentServer(server, { authType: 'oauth' }); // before connect
   * await server.connect(new StdioServerTransport());          // transport auto-detected
   * ```
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
        authType: opts?.authType,
        extra: opts?.extra,
      });

      // Default server connection / capability events (opt-out via config).
      if (this.config.autocapture.serverEvents) {
        // `tools/list` → `[MCP] Tools Listed`. Wrap now: every handler is
        // registered by connect time, so the live tool set is counted per call.
        installToolsListHook(lowLevelServer, ({ result, error, durationMs }, extra) => {
          if (this._serverCtx == null) return;
          const ctx = buildServerContext(this._serverCtx, extra, {
            serverIdentity: this._serverIdentity,
            logger: getLogger(this._amplitude),
          });
          const tools = result?.tools ?? [];
          const names = tools
            .map((t) => t.name)
            .filter((n): n is string => typeof n === 'string');
          const toolError = error != null ? classifyError(error) : undefined;
          emitToolsListed(this._amplitude, ctx, {
            isError: error != null,
            toolCount: tools.length,
            toolNames: names.length > 0 ? names : undefined,
            durationMs,
            responseSizeBytes: result != null ? byteSize(result) : undefined,
            errorMessage: toolError?.message,
            errorType: toolError?.type,
          });
        });

        // `[MCP] Session Ended` on transport close — only when a session was
        // initialized (gates out stateless HTTP, which never handshakes).
        const existingOnClose = lowLevelServer.onclose;
        lowLevelServer.onclose = (): void => {
          if (this._sessionStartMs != null && this._serverCtx != null) {
            emitSessionEnded(this._amplitude, this._serverCtx, {
              durationMs: performance.now() - this._sessionStartMs,
            });
            this._sessionStartMs = undefined;
          }
          existingOnClose?.();
        };
      }

      // Capture the handshake `clientInfo` into the server scope (legacy / stdio
      // path), chaining any handler the consumer already installed.
      const existingOnInitialized = lowLevelServer.oninitialized;
      lowLevelServer.oninitialized = (): void => {
        const clientInfo = lowLevelServer.getClientVersion();
        if (clientInfo != null && this._serverCtx != null) {
          this._serverCtx.client = { ...this._serverCtx.client, name: clientInfo.name, version: clientInfo.version };
        }

        // `[MCP] Session Initialized` — the handshake only fires on the
        // session-bearing transports (stdio + legacy HTTP), so this is never
        // emitted on `2026-07-28+` stateless HTTP. Resolve the floored server ctx
        // into its connection form (real anchor/identity) once, in place;
        // per-request builds still override these per call. No request `extra` at
        // the handshake; carry the transport session id (legacy HTTP) so the
        // anchor resolves to it, else stdio → process.
        if (this.config.autocapture.serverEvents && this._serverCtx != null) {
          const sessionId = (transport as { sessionId?: string }).sessionId;
          this._serverCtx = buildServerContext(
            this._serverCtx,
            { sessionId } as unknown as McpExtra,
            { serverIdentity: this._serverIdentity, logger: getLogger(this._amplitude) },
          );
          this._sessionStartMs = performance.now();
          emitSessionInitialized(this._amplitude, this._serverCtx);
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
