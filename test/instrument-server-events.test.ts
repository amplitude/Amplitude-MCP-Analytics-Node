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

/**
 * A fuller fake than instrument-server.test.ts: it also models the low-level
 * `_requestHandlers` map (so the tools/list hook has something to wrap), the
 * `onclose` teardown hook, and a registered `tools/list` handler.
 */
function makeFakeServer(
  opts: { clientInfo?: { name: string; version: string }; toolsListThrows?: unknown } = {},
) {
  const requestHandlers = new Map<string, RequestHandler>();
  const lowLevel: {
    oninitialized?: () => void;
    onclose?: () => void;
    getClientVersion: () => { name: string; version: string } | undefined;
    _requestHandlers: Map<string, RequestHandler>;
  } = {
    getClientVersion: () => opts.clientInfo ?? { name: 'cursor', version: '0.40' },
    _requestHandlers: requestHandlers,
  };

  // Stand in for the McpServer-registered tools/list handler.
  let tools = [{ name: 'search' }, { name: 'create' }];
  requestHandlers.set('tools/list', () => {
    if (opts.toolsListThrows != null) throw opts.toolsListThrows;
    return { tools };
  });

  const server = {
    server: lowLevel,
    connect: (_t: unknown): Promise<void> => Promise.resolve(),
    isConnected: () => false,
    fireInitialized: () => lowLevel.oninitialized?.(),
    fireClose: () => lowLevel.onclose?.(),
    listTools: (extra: unknown = {}) => requestHandlers.get('tools/list')?.({}, extra),
    setTools: (next: { name: string }[]) => {
      tools = next;
    },
  };
  return { server, lowLevel };
}

const stdioTransport = { start: async () => {}, send: async () => {}, close: async () => {} };

function eventsOf(tracked: AmplitudeEvent[], type: string): AmplitudeEvent[] {
  return tracked.filter((e) => e.event_type === type);
}

describe('instrumentServer — default connection events', () => {
  it('emits `mcp: session initialized` at the handshake', async () => {
    const { analytics, tracked } = makeAnalytics();
    const { server } = makeFakeServer();
    analytics.instrumentServer(server as unknown as McpServer, { userId: 'user-1', authType: 'oauth' });
    await server.connect(stdioTransport);

    expect(eventsOf(tracked, 'mcp: session initialized')).toHaveLength(0); // not until initialized
    server.fireInitialized();

    const [init] = eventsOf(tracked, 'mcp: session initialized');
    expect(init?.user_id).toBe('user-1');
    expect(init?.event_properties).toMatchObject({
      'server name': 'test-mcp',
      'client name': 'cursor',
      transport: 'stdio',
      'auth type': 'oauth',
    });
  });

  it('emits `mcp: session ended` with a duration on transport close', async () => {
    const { analytics, tracked } = makeAnalytics();
    const { server } = makeFakeServer();
    analytics.instrumentServer(server as unknown as McpServer, { userId: 'user-1' });
    await server.connect(stdioTransport);
    server.fireInitialized();
    server.fireClose();

    const ended = eventsOf(tracked, 'mcp: session ended');
    expect(ended).toHaveLength(1);
    expect(ended[0]?.event_properties).toHaveProperty('session duration');
  });

  it('does not emit `session ended` when no session was initialized (stateless / no handshake)', async () => {
    const { analytics, tracked } = makeAnalytics();
    const { server } = makeFakeServer();
    analytics.instrumentServer(server as unknown as McpServer, { userId: 'user-1' });
    await server.connect(stdioTransport);
    server.fireClose(); // close without a prior initialize

    expect(eventsOf(tracked, 'mcp: session ended')).toHaveLength(0);
  });

  it('emits `mcp: tools listed` with the live tool count and names on a tools/list call', async () => {
    const { analytics, tracked } = makeAnalytics();
    const { server } = makeFakeServer();
    analytics.instrumentServer(server as unknown as McpServer, { userId: 'user-1' });
    await server.connect(stdioTransport);

    const result = server.listTools();
    expect(result).toEqual({ tools: [{ name: 'search' }, { name: 'create' }] }); // passthrough unchanged

    const [listed] = eventsOf(tracked, 'mcp: tools listed');
    expect(listed?.event_properties).toMatchObject({
      'tool count': 2,
      'tool names': ['search', 'create'],
    });
  });

  it('emits `mcp: tools listed` with is error when the handler throws, preserving the throw', async () => {
    const { analytics, tracked } = makeAnalytics();
    const { server } = makeFakeServer({ toolsListThrows: new Error('kaboom') });
    analytics.instrumentServer(server as unknown as McpServer, { userId: 'user-1' });
    await server.connect(stdioTransport);

    expect(() => server.listTools()).toThrow('kaboom'); // handler behavior preserved

    const [listed] = eventsOf(tracked, 'mcp: tools listed');
    expect(listed?.event_properties).toMatchObject({ 'is error': true, 'tool count': 0 });
    expect(listed?.event_properties?.['error message']).toBe('kaboom');
  });

  it('reflects tools added after connect (handler closure is live)', async () => {
    const { analytics, tracked } = makeAnalytics();
    const { server } = makeFakeServer();
    analytics.instrumentServer(server as unknown as McpServer, { userId: 'user-1' });
    await server.connect(stdioTransport);

    server.setTools([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
    server.listTools();

    const [listed] = eventsOf(tracked, 'mcp: tools listed');
    expect(listed?.event_properties?.['tool count']).toBe(3);
  });

  it('emits no connection events when autocapture.serverEvents is false', async () => {
    const { analytics, tracked } = makeAnalytics(
      new MCPAnalyticsConfig({ autocapture: { serverEvents: false } }),
    );
    const { server } = makeFakeServer();
    analytics.instrumentServer(server as unknown as McpServer, { userId: 'user-1' });
    await server.connect(stdioTransport);
    server.fireInitialized();
    server.listTools();
    server.fireClose();

    expect(tracked).toHaveLength(0);
  });

  it('emits InstrumentServerOptions.extra as properties on connection events', async () => {
    const { analytics, tracked } = makeAnalytics();
    const { server } = makeFakeServer();
    analytics.instrumentServer(server as unknown as McpServer, {
      userId: 'user-1',
      extra: { 'org url': 'acme', region: 'us' },
    });
    await server.connect(stdioTransport);
    server.fireInitialized();
    server.listTools();

    for (const type of ['mcp: session initialized', 'mcp: tools listed']) {
      const [evt] = eventsOf(tracked, type);
      expect(evt?.event_properties).toMatchObject({ 'org url': 'acme', region: 'us' });
    }
  });

  it('chains an existing onclose rather than replacing it', async () => {
    const { analytics } = makeAnalytics();
    const { server, lowLevel } = makeFakeServer();
    let priorClosed = false;
    lowLevel.onclose = () => {
      priorClosed = true;
    };
    analytics.instrumentServer(server as unknown as McpServer, { userId: 'user-1' });
    await server.connect(stdioTransport);
    server.fireInitialized();
    server.fireClose();

    expect(priorClosed).toBe(true);
  });
});
