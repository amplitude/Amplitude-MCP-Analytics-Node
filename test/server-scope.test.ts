import { describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AmplitudeMCPAnalytics } from '../src/client.js';
import { MCPAnalyticsConfig } from '../src/config.js';
import type { McpExtra, ServerRequestHandler } from '../src/core/mcp.js';
import type { AmplitudeEvent } from '../src/types.js';

/**
 * Per-server-instance scope (`core/server-scope.ts`): hosts that build one
 * `McpServer` per HTTP request bind `instrumentServer` per request, possibly
 * with per-request identity opts. These tests prove concurrent bindings do
 * not bleed into each other — the race that previously forced such hosts to
 * avoid `instrumentServer` opts and server-event autocapture entirely.
 */

function makeAnalytics(config?: MCPAnalyticsConfig) {
  const tracked: AmplitudeEvent[] = [];
  const amplitude = { track: (e: AmplitudeEvent) => void tracked.push(e), flush: () => undefined };
  const analytics = new AmplitudeMCPAnalytics({
    amplitude,
    serverName: 'test-mcp',
    serverVersion: '9.9.9',
    ...(config ? { config } : {}),
  });
  return { analytics, tracked };
}

/**
 * Minimal low-level-Server shape `instrumentServer` needs: a `connect`, the
 * private `_requestHandlers` map (dispatch + hooks wrap it), and the
 * handshake surface. No `server` property → it is its own low-level server.
 */
interface FakeServer {
  connect: (transport: unknown) => Promise<void>;
  _requestHandlers: Map<string, ServerRequestHandler>;
  oninitialized?: () => void;
  onclose?: () => void;
  getClientVersion: () => { name: string; version: string } | undefined;
}

function makeServer(handlers: Record<string, ServerRequestHandler> = {}): FakeServer {
  return {
    connect: async () => undefined,
    _requestHandlers: new Map(Object.entries(handlers)),
    getClientVersion: () => ({ name: 'cursor', version: '1.0.0' }),
  };
}

const httpTransport = (sessionId?: string) => ({ handleRequest: () => undefined, sessionId });

function mkExtra(partial: Record<string, unknown> = {}): McpExtra {
  return {
    signal: new AbortController().signal,
    requestId: 1,
    sendNotification: async () => undefined,
    sendRequest: async () => ({}),
    ...partial,
  } as unknown as McpExtra;
}

const ok = (text = 'ok'): CallToolResult => ({ content: [{ type: 'text', text }] });

const toolCallEvents = (tracked: AmplitudeEvent[]) =>
  tracked.filter((e) => e.event_type === '[MCP] Tool Call Response');

describe('per-server scope — instrumented tools', () => {
  it('attributes tool calls to the dispatching server, not the last-connected one', async () => {
    const { analytics, tracked } = makeAnalytics();

    const tool = analytics.instrumentTool(
      async (_extra: McpExtra) => ok(),
      { name: 'search' },
    );

    const serverA = makeServer({ 'tools/call': (_req, extra) => tool(extra) });
    const serverB = makeServer({ 'tools/call': (_req, extra) => tool(extra) });

    analytics.instrumentServer(serverA as never, {
      userId: 'alice@example.com',
      tenant: { groupType: 'org id', groupValue: 'org-a' },
    });
    analytics.instrumentServer(serverB as never, {
      userId: 'bob@example.com',
      tenant: { groupType: 'org id', groupValue: 'org-b' },
    });

    await serverA.connect(httpTransport());
    await serverB.connect(httpTransport()); // last-connected fallback now points at B

    // Dispatch through A: must attribute to alice/org-a despite B connecting later.
    await serverA._requestHandlers.get('tools/call')!({} as never, mkExtra());
    // And through B.
    await serverB._requestHandlers.get('tools/call')!({} as never, mkExtra());

    const events = toolCallEvents(tracked);
    expect(events).toHaveLength(2);
    expect(events[0]?.user_id).toBe('alice@example.com');
    expect(events[0]?.groups).toEqual({ 'org id': 'org-a' });
    expect(events[1]?.user_id).toBe('bob@example.com');
    expect(events[1]?.groups).toEqual({ 'org id': 'org-b' });
  });

  it('keeps attribution correct across interleaved concurrent dispatches', async () => {
    const { analytics, tracked } = makeAnalytics();

    let releaseA: () => void = () => undefined;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const slowTool = analytics.instrumentTool(
      async (_extra: McpExtra) => {
        await gateA; // hold A's call open while B connects and dispatches
        return ok('slow');
      },
      { name: 'slow' },
    );
    const fastTool = analytics.instrumentTool(
      async (_extra: McpExtra) => ok('fast'),
      { name: 'fast' },
    );

    const serverA = makeServer({ 'tools/call': (_req, extra) => slowTool(extra) });
    analytics.instrumentServer(serverA as never, { userId: 'alice@example.com' });
    await serverA.connect(httpTransport());

    const inFlightA = serverA._requestHandlers.get('tools/call')!({} as never, mkExtra());

    // While A's call is in flight, a second request binds + connects + runs.
    const serverB = makeServer({ 'tools/call': (_req, extra) => fastTool(extra) });
    analytics.instrumentServer(serverB as never, { userId: 'bob@example.com' });
    await serverB.connect(httpTransport());
    await serverB._requestHandlers.get('tools/call')!({} as never, mkExtra());

    releaseA();
    await inFlightA;

    const byTool = Object.fromEntries(
      toolCallEvents(tracked).map((e) => [
        e.event_properties?.['[MCP] Tool Name'],
        e.user_id,
      ]),
    );
    expect(byTool).toEqual({
      fast: 'bob@example.com',
      slow: 'alice@example.com', // NOT bob, despite B connecting mid-flight
    });
  });

  it('does not bleed a later server identity into an identity-less dispatching server', async () => {
    const { analytics, tracked } = makeAnalytics();

    // Distinct tool names so each dispatch's event is attributable to its server.
    const toolA = analytics.instrumentTool(async (_extra: McpExtra) => ok(), { name: 'search-a' });
    const toolB = analytics.instrumentTool(async (_extra: McpExtra) => ok(), { name: 'search-b' });

    // A binds with NO identity opts at all (so its scope identity is undefined);
    // B later binds with an explicit identity, moving the singleton mirror to bob.
    const serverA = makeServer({ 'tools/call': (_req, extra) => toolA(extra) });
    const serverB = makeServer({ 'tools/call': (_req, extra) => toolB(extra) });

    analytics.instrumentServer(serverA as never); // identity-less
    analytics.instrumentServer(serverB as never, { userId: 'bob@example.com' });

    await serverA.connect(httpTransport());
    await serverB.connect(httpTransport()); // singleton identity mirror now points at bob

    // Dispatch through A's own frame, then B's.
    await serverA._requestHandlers.get('tools/call')!({} as never, mkExtra());
    await serverB._requestHandlers.get('tools/call')!({} as never, mkExtra());

    const events = toolCallEvents(tracked);
    // A is anonymous with no tenant, so it degrades to NO event rather than
    // inheriting bob from the singleton mirror. Before the fix, A picked up
    // bob's identity — flipping it to non-anonymous — and emitted a second,
    // bob-attributed `search-a` event.
    expect(events.map((e) => e.event_properties?.['[MCP] Tool Name'])).toEqual(['search-b']);
    expect(events[0]?.user_id).toBe('bob@example.com');
    expect(
      events.some((e) => e.event_properties?.['[MCP] Tool Name'] === 'search-a'),
    ).toBe(false);
  });

  it('falls back to the last-connected scope for direct (non-dispatch) invocation', async () => {
    const { analytics, tracked } = makeAnalytics();

    const tool = analytics.instrumentTool(
      async (_extra: McpExtra) => ok(),
      { name: 'search' },
    );

    const serverA = makeServer();
    analytics.instrumentServer(serverA as never, { userId: 'alice@example.com' });
    await serverA.connect(httpTransport());

    await tool(mkExtra()); // no dispatch frame → last-connected fallback

    expect(toolCallEvents(tracked)[0]?.user_id).toBe('alice@example.com');
  });
});

describe('per-server scope — server events', () => {
  it('emits [MCP] Tools Listed with the binding identity from instrumentServer opts', async () => {
    const { analytics, tracked } = makeAnalytics();

    const server = makeServer({
      'tools/list': (async () => ({
        tools: [{ name: 'a' }, { name: 'b' }],
      })) as unknown as ServerRequestHandler,
    });
    analytics.instrumentServer(server as never, {
      userId: 'alice@example.com',
      tenant: { groupType: 'org id', groupValue: 'org-a' },
    });
    await server.connect(httpTransport());

    await server._requestHandlers.get('tools/list')!({} as never, mkExtra());

    const event = tracked.find((e) => e.event_type === '[MCP] Tools Listed');
    expect(event?.user_id).toBe('alice@example.com');
    expect(event?.groups).toEqual({ 'org id': 'org-a' });
    expect(event?.event_properties?.['[MCP] Tool Count']).toBe(2);
  });

  it('emits Tools Listed but no session lifecycle with { serverEvents: false, toolsListed: true }', async () => {
    const { analytics, tracked } = makeAnalytics(
      new MCPAnalyticsConfig({
        autocapture: { serverEvents: false, toolsListed: true },
      }),
    );

    const server = makeServer({
      'tools/list': (async () => ({ tools: [{ name: 'a' }] })) as unknown as ServerRequestHandler,
    });
    analytics.instrumentServer(server as never, { userId: 'alice@example.com' });
    await server.connect(httpTransport('sess-a'));

    server.oninitialized?.(); // would emit Session Initialized if lifecycle were on
    await server._requestHandlers.get('tools/list')!({} as never, mkExtra());
    server.onclose?.();

    const types = tracked.map((e) => e.event_type);
    expect(types).toContain('[MCP] Tools Listed');
    expect(types).not.toContain('[MCP] Session Initialized');
    expect(types).not.toContain('[MCP] Session Ended');
  });

  it('emits the session lifecycle but no Tools Listed with { toolsListed: false }', async () => {
    const { analytics, tracked } = makeAnalytics(
      new MCPAnalyticsConfig({ autocapture: { toolsListed: false } }),
    );

    const server = makeServer({
      'tools/list': (async () => ({ tools: [{ name: 'a' }] })) as unknown as ServerRequestHandler,
    });
    analytics.instrumentServer(server as never, { userId: 'alice@example.com' });
    await server.connect(httpTransport('sess-a'));

    server.oninitialized?.();
    await server._requestHandlers.get('tools/list')!({} as never, mkExtra());
    server.onclose?.();

    const types = tracked.map((e) => e.event_type);
    expect(types).not.toContain('[MCP] Tools Listed');
    expect(types).toContain('[MCP] Session Initialized');
    expect(types).toContain('[MCP] Session Ended');
  });

  it('scopes the session lifecycle per server — no cross-instance bleed', async () => {
    const { analytics, tracked } = makeAnalytics();

    const serverA = makeServer();
    const serverB = makeServer();
    analytics.instrumentServer(serverA as never, { userId: 'alice@example.com' });
    analytics.instrumentServer(serverB as never, { userId: 'bob@example.com' });
    await serverA.connect(httpTransport('sess-a'));
    await serverB.connect(httpTransport()); // B never handshakes

    serverA.oninitialized?.(); // A's handshake starts A's session
    serverB.onclose?.(); // B closing must NOT emit — it has no session
    serverA.onclose?.();

    const initialized = tracked.filter((e) => e.event_type === '[MCP] Session Initialized');
    const ended = tracked.filter((e) => e.event_type === '[MCP] Session Ended');
    expect(initialized).toHaveLength(1);
    expect(initialized[0]?.user_id).toBe('alice@example.com');
    expect(ended).toHaveLength(1);
    expect(ended[0]?.user_id).toBe('alice@example.com');
    expect(ended[0]?.event_properties?.['[MCP] Session ID']).toBe('sess-a');
  });
});

describe('per-server scope — widened instrumentServer opts', () => {
  const boundOpts = {
    userId: 'alice@example.com',
    client: { name: 'Cursor', version: '2.0.0', userAgent: 'cursor/2.0.0' },
    sessionId: 'sess-host-managed',
    protocolVersion: '2025-11-25',
  };

  it('client / sessionId / protocolVersion opts flow onto tool events', async () => {
    const { analytics, tracked } = makeAnalytics();

    const tool = analytics.instrumentTool(async (_extra: McpExtra) => ok(), { name: 'search' });
    const server = makeServer({ 'tools/call': (_req, extra) => tool(extra) });
    analytics.instrumentServer(server as never, boundOpts);
    await server.connect(httpTransport()); // transport carries no session id

    await server._requestHandlers.get('tools/call')!({} as never, mkExtra());

    const props = toolCallEvents(tracked)[0]?.event_properties;
    expect(props).toMatchObject({
      '[MCP] Client Name': 'Cursor',
      '[MCP] Client Version': '2.0.0',
      '[MCP] User Agent': 'cursor/2.0.0',
      '[MCP] Session ID': 'sess-host-managed',
      '[MCP] Anchor Type': 'session-id',
      '[MCP] Protocol Version': '2025-11-25',
    });
  });

  it('per-request values still win over the bound opts', async () => {
    const { analytics, tracked } = makeAnalytics();

    const tool = analytics.instrumentTool(async (_extra: McpExtra) => ok(), { name: 'search' });
    const server = makeServer({ 'tools/call': (_req, extra) => tool(extra) });
    analytics.instrumentServer(server as never, boundOpts);
    await server.connect(httpTransport());

    await server._requestHandlers.get('tools/call')!(
      {} as never,
      mkExtra({
        sessionId: 'sess-transport',
        requestInfo: {
          headers: {
            'user-agent': 'claude/9.9',
            'mcp-protocol-version': '2026-07-28',
          },
        },
        _meta: { clientInfo: { name: 'claude', version: '9.9.0' } },
      }),
    );

    const props = toolCallEvents(tracked)[0]?.event_properties;
    expect(props).toMatchObject({
      '[MCP] Client Name': 'claude',
      '[MCP] Client Version': '9.9.0',
      '[MCP] User Agent': 'claude/9.9',
      '[MCP] Session ID': 'sess-transport',
      '[MCP] Protocol Version': '2026-07-28',
    });
  });
});

describe('per-server scope — emitAnonymousEvent config', () => {
  // A stateless HTTP request with no session id, no trace context, and no
  // identity/tenant resolves to the per-request anonymous floor.
  function dispatchAnonymous(analytics: AmplitudeMCPAnalytics) {
    const tool = analytics.instrumentTool(async (_extra: McpExtra) => ok(), { name: 'search' });
    const server = makeServer({ 'tools/call': (_req, extra) => tool(extra) });
    analytics.instrumentServer(server as never); // no identity opts
    return server
      .connect(httpTransport()) // no session id
      .then(() => server._requestHandlers.get('tools/call')!({} as never, mkExtra()));
  }

  it('drops the anonymous, tenant-less floor by default', async () => {
    const { analytics, tracked } = makeAnalytics();
    await dispatchAnonymous(analytics);
    expect(toolCallEvents(tracked)).toHaveLength(0);
  });

  it('emits the anonymous floor when emitAnonymousEvent is true', async () => {
    const { analytics, tracked } = makeAnalytics(
      new MCPAnalyticsConfig({ emitAnonymousEvent: true }),
    );
    await dispatchAnonymous(analytics);

    const events = toolCallEvents(tracked);
    expect(events).toHaveLength(1);
    // Anonymous, aggregate-only: a synthetic device id, no real user.
    expect(events[0]?.user_id).toMatch(/^anonymous:/);
    expect(events[0]?.device_id).toBeTruthy();
    expect(events[0]?.event_properties?.['[MCP] Anchor Type']).toBe('anonymous');
  });
});
