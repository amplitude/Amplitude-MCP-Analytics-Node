import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { AmplitudeMCPAnalytics } from '../src/client.js';
import { MCPAnalyticsConfig } from '../src/config.js';
import type { AmplitudeEvent } from '../src/types.js';

function makeAnalytics(config?: MCPAnalyticsConfig) {
  const tracked: AmplitudeEvent[] = [];
  const amplitude = { track: (e: AmplitudeEvent) => tracked.push(e), flush: () => undefined };
  const analytics = new AmplitudeMCPAnalytics({
    amplitude,
    serverName: 'test-mcp',
    serverVersion: '9.9.9',
    config,
  });
  return { analytics, tracked };
}

type RequestHandler = (request: unknown, extra: unknown) => unknown;
type ToolCallback = (args: Record<string, unknown>, extra: unknown) => unknown;

/**
 * Fake server modeling the MCP SDK's `tools/call` dispatch semantics: an
 * unknown tool name throws (→ JSON-RPC error envelope, no callback runs),
 * while a callback that throws is converted into an in-band `isError` result.
 * The same `extra` object flows from the request handler into the callback,
 * exactly as `Protocol._onrequest` → `McpServer`'s CallTool handler does.
 */
function makeFakeServer(opts: { throwAfterDispatch?: boolean } = {}) {
  const requestHandlers = new Map<string, RequestHandler>();
  const tools = new Map<string, ToolCallback>();
  const lowLevel = {
    getClientVersion: () => ({ name: 'cursor', version: '0.40' }),
    _requestHandlers: requestHandlers,
  };

  requestHandlers.set('tools/call', async (request: unknown, extra: unknown) => {
    const params = (request as { params?: { name?: string; arguments?: Record<string, unknown> } })
      .params;
    const name = params?.name ?? '';
    const callback = tools.get(name);
    if (callback == null) {
      throw Object.assign(new Error(`Tool ${name} not found`), { code: -32602 });
    }
    let result: unknown;
    try {
      result = await callback(params?.arguments ?? {}, extra);
    } catch (error) {
      result = {
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
    }
    if (opts.throwAfterDispatch) {
      // Models the SDK's post-callback output-schema validation throw.
      throw Object.assign(new Error(`Invalid structured content for tool ${name}`), {
        code: -32602,
      });
    }
    return result;
  });

  const server = {
    server: lowLevel,
    connect: (_t: unknown): Promise<void> => Promise.resolve(),
    isConnected: () => false,
    registerTool: (name: string, callback: ToolCallback) => tools.set(name, callback),
    callTool: (name: string, args: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
      requestHandlers.get('tools/call')?.(
        { method: 'tools/call', params: { name, arguments: args } },
        { requestId: 1, ...extra },
      ),
  };
  return { server };
}

const stdioTransport = { start: async () => {}, send: async () => {}, close: async () => {} };
const httpTransport = {
  start: async () => {},
  send: async () => {},
  close: async () => {},
  handleRequest: async () => {},
};

function eventsOf(tracked: AmplitudeEvent[], type: string): AmplitudeEvent[] {
  return tracked.filter((e) => e.event_type === type);
}

const okResult = { content: [{ type: 'text' as const, text: 'ok' }] };

describe('instrumentServer — [MCP] Tool Call Rejected', () => {
  it('emits for an unknown tool (rejected before any callback), preserving the throw', async () => {
    const { analytics, tracked } = makeAnalytics();
    const { server } = makeFakeServer();
    analytics.instrumentServer(server as unknown as McpServer, { userId: 'user-1' });
    await server.connect(stdioTransport);

    await expect(server.callTool('made_up_tool')).rejects.toThrow('Tool made_up_tool not found');

    const [rejected] = eventsOf(tracked, '[MCP] Tool Call Rejected');
    expect(rejected?.user_id).toBe('user-1');
    expect(rejected?.event_properties).toMatchObject({
      '[MCP] Attempted Tool Name': 'made_up_tool',
      '[MCP] Error Message': 'Tool made_up_tool not found',
      '[MCP] Is Error': true,
    });
    expect(rejected?.event_properties?.['[MCP] Response Duration']).toBeTypeOf('number');
    expect(rejected?.event_properties?.['[MCP] Response Size']).toBeTypeOf('number');
    expect(eventsOf(tracked, '[MCP] Tool Call Response')).toHaveLength(0);
  });

  it('does not emit for a dispatched instrumented tool that succeeds', async () => {
    const { analytics, tracked } = makeAnalytics();
    const { server } = makeFakeServer();
    analytics.instrumentServer(server as unknown as McpServer, { userId: 'user-1' });
    server.registerTool(
      'search',
      analytics.instrumentTool(async () => okResult, { name: 'search' }) as ToolCallback,
    );
    await server.connect(stdioTransport);

    await expect(server.callTool('search')).resolves.toEqual(okResult);

    expect(eventsOf(tracked, '[MCP] Tool Call Rejected')).toHaveLength(0);
    expect(eventsOf(tracked, '[MCP] Tool Call Response')).toHaveLength(1);
  });

  it('does not emit for a dispatched instrumented tool that throws — the wrapper owns it', async () => {
    const { analytics, tracked } = makeAnalytics();
    const { server } = makeFakeServer();
    analytics.instrumentServer(server as unknown as McpServer, { userId: 'user-1' });
    server.registerTool(
      'search',
      analytics.instrumentTool(
        async () => {
          throw new Error('upstream exploded');
        },
        { name: 'search' },
      ) as ToolCallback,
    );
    await server.connect(stdioTransport);

    // The MCP SDK converts the callback throw into an in-band isError result.
    const result = (await server.callTool('search')) as { isError?: boolean };
    expect(result?.isError).toBe(true);

    expect(eventsOf(tracked, '[MCP] Tool Call Rejected')).toHaveLength(0);
    const [response] = eventsOf(tracked, '[MCP] Tool Call Response');
    expect(response?.event_properties).toMatchObject({ '[MCP] Is Error': true });
  });

  it('does not emit when the handler throws after the callback ran (output-schema shape)', async () => {
    const { analytics, tracked } = makeAnalytics();
    const { server } = makeFakeServer({ throwAfterDispatch: true });
    analytics.instrumentServer(server as unknown as McpServer, { userId: 'user-1' });
    server.registerTool(
      'search',
      analytics.instrumentTool(async () => okResult, { name: 'search' }) as ToolCallback,
    );
    await server.connect(stdioTransport);

    await expect(server.callTool('search')).rejects.toThrow('Invalid structured content');

    // Dispatched: the wrapper already reported it on `[MCP] Tool Call Response`.
    expect(eventsOf(tracked, '[MCP] Tool Call Rejected')).toHaveLength(0);
    expect(eventsOf(tracked, '[MCP] Tool Call Response')).toHaveLength(1);
  });

  it('does not emit for an uninstrumented tool returning an in-band isError result', async () => {
    const { analytics, tracked } = makeAnalytics();
    const { server } = makeFakeServer();
    analytics.instrumentServer(server as unknown as McpServer, { userId: 'user-1' });
    server.registerTool('legacy', () => ({ ...okResult, isError: true }));
    await server.connect(stdioTransport);

    const result = (await server.callTool('legacy')) as { isError?: boolean };
    expect(result?.isError).toBe(true); // passthrough unchanged

    // The tool executed — an isError result is not a rejection.
    expect(eventsOf(tracked, '[MCP] Tool Call Rejected')).toHaveLength(0);
  });

  it('carries [MCP] Response HTTP Status 200 on streamable HTTP and omits it on stdio', async () => {
    for (const [transport, expected] of [
      [httpTransport, 200],
      [stdioTransport, undefined],
    ] as const) {
      const { analytics, tracked } = makeAnalytics();
      const { server } = makeFakeServer();
      analytics.instrumentServer(server as unknown as McpServer, { userId: 'user-1' });
      await server.connect(transport);

      await expect(server.callTool('nope')).rejects.toThrow();

      const [rejected] = eventsOf(tracked, '[MCP] Tool Call Rejected');
      expect(rejected?.event_properties?.['[MCP] Response HTTP Status']).toBe(expected);
    }
  });

  it('truncates an oversized attempted tool name', async () => {
    const { analytics, tracked } = makeAnalytics();
    const { server } = makeFakeServer();
    analytics.instrumentServer(server as unknown as McpServer, { userId: 'user-1' });
    await server.connect(stdioTransport);

    await expect(server.callTool('x'.repeat(500))).rejects.toThrow();

    const [rejected] = eventsOf(tracked, '[MCP] Tool Call Rejected');
    expect(rejected?.event_properties?.['[MCP] Attempted Tool Name']).toBe('x'.repeat(200));
  });

  it('emits nothing when autocapture.toolCalls is false', async () => {
    const { analytics, tracked } = makeAnalytics(
      new MCPAnalyticsConfig({ autocapture: { toolCalls: false } }),
    );
    const { server } = makeFakeServer();
    analytics.instrumentServer(server as unknown as McpServer, { userId: 'user-1' });
    await server.connect(stdioTransport);

    await expect(server.callTool('made_up_tool')).rejects.toThrow();

    expect(eventsOf(tracked, '[MCP] Tool Call Rejected')).toHaveLength(0);
  });
});
