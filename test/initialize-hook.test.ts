/**
 * Handshake resolution against the REAL `@modelcontextprotocol/sdk`, not a fake
 * server, because the bug these cover was entirely about which SDK callback
 * fires on which message and which server instance receives it.
 *
 * The shape under test is a host that serves each request from a fresh
 * `McpServer`, which is how sessionless Streamable HTTP is deployed. There the
 * `initialize` request and the `notifications/initialized` notification land on
 * two different instances, so reading `clientInfo` at `oninitialized` (the
 * notification) always missed it.
 */
import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AmplitudeMCPAnalytics } from '../src/client.js';
import { MCPAnalyticsConfig } from '../src/config.js';
import type { ClientInfoResolver } from '../src/context/types.js';
import type { McpExtra } from '../src/core/mcp.js';
import type { AmplitudeClientLike, AmplitudeEvent } from '../src/types.js';

const CLIENT_INFO = { name: 'cursor', version: '1.2.3' };

function fakeAmplitude(sink: AmplitudeEvent[]): AmplitudeClientLike {
  return { track: (e: AmplitudeEvent) => sink.push(e), flush: () => undefined };
}

/**
 * A linked transport pair whose server side answers `handleRequest`, so
 * `resolveTransport` classifies it as `streamable-http`. Pass a `sessionId` for
 * the session-bearing case; omit it for the stateless one.
 */
function httpPair(sessionId?: string) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  (serverT as unknown as { handleRequest: () => void }).handleRequest = () => undefined;
  if (sessionId != null) serverT.sessionId = sessionId;
  return [clientT, serverT] as const;
}

function instrumented(
  events: AmplitudeEvent[],
  opts: {
    userId?: string;
    resolveClientInfo?: ClientInfoResolver;
    client?: { name?: string };
    /** Host-managed correlation session id, per `instrumentServer({ sessionId })`. */
    sessionId?: string;
    analytics?: AmplitudeMCPAnalytics;
  } = {},
) {
  const analytics =
    opts.analytics ??
    new AmplitudeMCPAnalytics({
      amplitude: fakeAmplitude(events),
      serverName: 'test-mcp',
      serverVersion: '1.0.0',
      // sessionLifecycle left at its default (true) throughout.
      config: new MCPAnalyticsConfig({}),
    });
  const server = new McpServer({ name: 'test-mcp', version: '1.0.0' });
  analytics.instrumentServer(server, {
    userId: opts.userId ?? 'user-1',
    authType: 'oauth',
    resolveClientInfo: opts.resolveClientInfo,
    client: opts.client,
    sessionId: opts.sessionId,
  });
  return { analytics, server };
}

const initializeReq = {
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: CLIENT_INFO },
};

const initializedNote = {
  jsonrpc: '2.0' as const,
  method: 'notifications/initialized',
  params: {},
};

/** Send a raw JSON-RPC message and let the server settle. */
async function send(
  clientT: InMemoryTransport,
  msg: unknown,
  options?: { authInfo?: { token: string; clientId: string; scopes: string[] } },
) {
  await clientT.send(msg as never, options as never);
  await new Promise((r) => setTimeout(r, 15));
}

const typesOf = (events: AmplitudeEvent[]) => events.map((e) => e.event_type);
const only = (events: AmplitudeEvent[], type: string) =>
  events.filter((e) => e.event_type === type);

describe('handshake client info (real MCP SDK)', () => {
  it('resolves the client name from the initialize request on a per-request server', async () => {
    const events: AmplitudeEvent[] = [];

    // Request 1: the `initialize` POST, served by instance A.
    const a = instrumented(events);
    const [clientA, serverA] = httpPair();
    await a.server.connect(serverA);
    await send(clientA, initializeReq);

    const inits = only(events, '[MCP] Session Initialized');
    expect(inits).toHaveLength(1);
    expect(inits[0]?.event_properties?.['[MCP] Client Name']).toBe('cursor');
    expect(inits[0]?.event_properties?.['[MCP] Client Version']).toBe('1.2.3');

    // Instance A is discarded, as a per-request host does.
    await serverA.close();

    // Request 2: `notifications/initialized`, served by a fresh instance B.
    const b = instrumented(events);
    const [clientB, serverB] = httpPair();
    await b.server.connect(serverB);
    await send(clientB, initializedNote);

    // Exactly one Session Initialized overall — the notification must not
    // re-emit it, or per-request hosts double-count every handshake with the
    // duplicate carrying `unknown`.
    expect(only(events, '[MCP] Session Initialized')).toHaveLength(1);
  });

  it('emits no Session Ended when the connection did not outlive the request', async () => {
    const events: AmplitudeEvent[] = [];
    const { server } = instrumented(events);
    const [clientT, serverT] = httpPair();
    await server.connect(serverT);
    await send(clientT, initializeReq);
    await serverT.close();

    expect(typesOf(events)).toContain('[MCP] Session Initialized');
    // A ~0ms "session" per handshake is noise, not a session.
    expect(only(events, '[MCP] Session Ended')).toHaveLength(0);
  });

  it('still resolves the session-id anchor and emits Session Ended when a session exists', async () => {
    const events: AmplitudeEvent[] = [];
    const { server } = instrumented(events);
    const [clientT, serverT] = httpPair('sess-1');
    await server.connect(serverT);
    await send(clientT, initializeReq);

    const inits = only(events, '[MCP] Session Initialized');
    expect(inits).toHaveLength(1);
    // The transport mints its session id before dispatching, so the anchor
    // resolves to it even though we now emit from the initialize request.
    expect(inits[0]?.event_properties?.['[MCP] Session ID']).toBe('sess-1');
    expect(inits[0]?.event_properties?.['[MCP] Anchor Type']).toBe('session-id');
    expect(inits[0]?.event_properties?.['[MCP] Client Name']).toBe('cursor');

    await serverT.close();
    const ended = only(events, '[MCP] Session Ended');
    expect(ended).toHaveLength(1);
    expect(ended[0]?.event_properties).toHaveProperty('[MCP] Session Duration');
  });

  it('emits no Session Ended for a host-managed session on a per-request server', async () => {
    const events: AmplitudeEvent[] = [];
    // `instrumentServer({ sessionId })` is documented for hosts that manage
    // sessions themselves against a fresh server per request. That produces a
    // `session-id` anchor on a transport that does NOT persist, so gating the
    // end event on the anchor would report the host's still-live session as
    // ended on every single request.
    const { server } = instrumented(events, { sessionId: 'host-managed-sess-1' });
    const [clientT, serverT] = httpPair(); // no transport session id
    await server.connect(serverT);
    await send(clientT, initializeReq);

    const inits = only(events, '[MCP] Session Initialized');
    expect(inits).toHaveLength(1);
    // The anchor still reports the host's session id — that part is correct.
    expect(inits[0]?.event_properties?.['[MCP] Session ID']).toBe('host-managed-sess-1');
    expect(inits[0]?.event_properties?.['[MCP] Anchor Type']).toBe('session-id');

    await serverT.close();
    expect(only(events, '[MCP] Session Ended')).toHaveLength(0);
  });

  it('carries the client name onto later requests when one instance serves the connection', async () => {
    const events: AmplitudeEvent[] = [];
    const { analytics, server } = instrumented(events);
    server.registerTool(
      'search',
      { description: 'search' },
      analytics.instrumentTool(async () => ({ content: [] }), { name: 'search' }),
    );
    const [clientT, serverT] = httpPair('sess-1');
    await server.connect(serverT);
    await send(clientT, initializeReq);
    await send(clientT, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'search', arguments: {} },
    });

    const calls = only(events, '[MCP] Tool Call Response');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.event_properties?.['[MCP] Client Name']).toBe('cursor');
  });
});

describe('oauth client id', () => {
  it('emits [MCP] OAuth Client ID from authInfo without touching Client Name', async () => {
    const events: AmplitudeEvent[] = [];
    const { analytics, server } = instrumented(events);
    server.registerTool(
      'search',
      { description: 'search' },
      analytics.instrumentTool(async () => ({ content: [] }), { name: 'search' }),
    );
    const [clientT, serverT] = httpPair();
    await server.connect(serverT);

    const authInfo = { token: 't', clientId: 'client-abc-123', scopes: ['read'] };
    await send(clientT, initializeReq, { authInfo });
    await send(
      clientT,
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search', arguments: {} } },
      { authInfo },
    );

    const calls = only(events, '[MCP] Tool Call Response');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.event_properties?.['[MCP] OAuth Client ID']).toBe('client-abc-123');
    // The registration id must never masquerade as the product name.
    expect(calls[0]?.event_properties?.['[MCP] Client Name']).not.toBe('client-abc-123');
  });

  it('omits the property when the request is unauthenticated', async () => {
    const events: AmplitudeEvent[] = [];
    const { server } = instrumented(events);
    const [clientT, serverT] = httpPair();
    await server.connect(serverT);
    await send(clientT, initializeReq);

    const inits = only(events, '[MCP] Session Initialized');
    expect(inits[0]?.event_properties).not.toHaveProperty('[MCP] OAuth Client ID');
  });
});

describe('server-scope fallback does not go stale', () => {
  it('does not carry a request-resolved client name or oauth id onto later requests', async () => {
    const events: AmplitudeEvent[] = [];
    // One long-lived server. The handshake request carries a resolver answer
    // and an authenticated client id; the later tool call carries neither. It
    // must fall back to the HANDSHAKE, not to the handshake request's own
    // resolved values, or one request's client identity bleeds onto the next.
    let resolverAnswer: { name: string } | undefined = { name: 'from-resolver' };
    const { analytics, server } = instrumented(events, {
      resolveClientInfo: () => resolverAnswer,
    });
    server.registerTool(
      'search',
      { description: 'search' },
      analytics.instrumentTool(async () => ({ content: [] }), { name: 'search' }),
    );
    const [clientT, serverT] = httpPair('sess-1');
    await server.connect(serverT);

    await send(clientT, initializeReq, {
      authInfo: { token: 't', clientId: 'handshake-client-id', scopes: [] },
    });
    expect(only(events, '[MCP] Session Initialized')[0]?.event_properties?.['[MCP] Client Name'])
      .toBe('from-resolver');

    // Later request: resolver declines, and no authInfo.
    resolverAnswer = undefined;
    await send(clientT, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'search', arguments: {} },
    });

    const call = only(events, '[MCP] Tool Call Response')[0];
    expect(call?.event_properties?.['[MCP] Client Name']).toBe('cursor'); // the handshake
    expect(call?.event_properties?.['[MCP] Client Name']).not.toBe('from-resolver');
    // An unauthenticated request must not inherit the earlier client id.
    expect(call?.event_properties).not.toHaveProperty('[MCP] OAuth Client ID');
  });
});

describe('rejected handshake', () => {
  it('emits no Session Initialized when the initialize request fails', async () => {
    const events: AmplitudeEvent[] = [];
    const { server } = instrumented(events);
    const [clientT, serverT] = httpPair();
    await server.connect(serverT);

    // An unsupported protocol version makes the SDK's own initialize handler
    // reject. The hook reports only after the handler settles, so a failed
    // handshake must not look like a completed session.
    await send(clientT, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: 42, capabilities: {}, clientInfo: CLIENT_INFO },
    });

    expect(only(events, '[MCP] Session Initialized')).toHaveLength(0);
    expect(only(events, '[MCP] Session Ended')).toHaveLength(0);
  });
});

describe('per-request _meta client info', () => {
  // Protocol revision 2026-07-28 removes the handshake and has clients
  // identify themselves on every request under this namespaced key. No shipped
  // SDK speaks it yet, so this pins the key we will read when one does.
  it('reads io.modelcontextprotocol/clientInfo from _meta', async () => {
    const events: AmplitudeEvent[] = [];
    const { analytics, server } = instrumented(events);
    server.registerTool(
      'search',
      { description: 'search' },
      analytics.instrumentTool(async () => ({ content: [] }), { name: 'search' }),
    );
    const [clientT, serverT] = httpPair();
    await server.connect(serverT);
    await send(clientT, initializeReq);
    await send(clientT, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'search',
        arguments: {},
        _meta: {
          'io.modelcontextprotocol/clientInfo': { name: 'vscode', version: '2.0.0' },
        },
      },
    });

    const calls = only(events, '[MCP] Tool Call Response');
    expect(calls).toHaveLength(1);
    // Per-request identity wins over the handshake's `cursor`.
    expect(calls[0]?.event_properties?.['[MCP] Client Name']).toBe('vscode');
    expect(calls[0]?.event_properties?.['[MCP] Client Version']).toBe('2.0.0');
  });
});

describe('resolveClientInfo', () => {
  it('supplies the client name per request and wins over the handshake', async () => {
    const events: AmplitudeEvent[] = [];
    const { analytics, server } = instrumented(events, {
      // The shape a stateless host uses: map a token claim to a client name.
      resolveClientInfo: ({ authInfo }: { authInfo?: Record<string, unknown> }) => ({
        name: authInfo?.client_name as string,
      }),
    });
    server.registerTool(
      'search',
      { description: 'search' },
      analytics.instrumentTool(async () => ({ content: [] }), { name: 'search' }),
    );
    const [clientT, serverT] = httpPair();
    await server.connect(serverT);

    const authInfo = {
      token: 't',
      clientId: 'client-abc-123',
      scopes: ['read'],
      client_name: 'claude-desktop',
    };
    await send(clientT, initializeReq, { authInfo });
    await send(
      clientT,
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search', arguments: {} } },
      { authInfo },
    );

    // Wins over the handshake's `cursor` on both events.
    expect(only(events, '[MCP] Session Initialized')[0]?.event_properties?.['[MCP] Client Name'])
      .toBe('claude-desktop');
    expect(only(events, '[MCP] Tool Call Response')[0]?.event_properties?.['[MCP] Client Name'])
      .toBe('claude-desktop');
  });

  it('falls through to the SDK sources when it returns undefined', async () => {
    const events: AmplitudeEvent[] = [];
    const { server } = instrumented(events, { resolveClientInfo: () => undefined });
    const [clientT, serverT] = httpPair();
    await server.connect(serverT);
    await send(clientT, initializeReq);

    expect(only(events, '[MCP] Session Initialized')[0]?.event_properties?.['[MCP] Client Name'])
      .toBe('cursor');
  });

  it('does not leak into a later binding on direct (non-dispatch) invocation', async () => {
    const events: AmplitudeEvent[] = [];

    // Binding A carries a resolver; binding B, on the SAME analytics client,
    // does not. Inside a dispatch frame each binding's own scope is used, so
    // the leak only shows on DIRECT invocation, where `instrumentTool` falls
    // back to the last-connected values. If the resolver is not cleared there,
    // B's call is attributed to A's client.
    const a = instrumented(events, {
      resolveClientInfo: () => ({ name: 'server-a-client' }),
    });
    const [, serverA] = httpPair();
    await a.server.connect(serverA);
    await serverA.close();

    const b = instrumented(events, { analytics: a.analytics });
    const [, serverB] = httpPair();
    await b.server.connect(serverB);

    // Called straight through, not via serverB's dispatch, and with no
    // handshake on B — so nothing but the fallback can supply a client name.
    const tool = a.analytics.instrumentTool(
      async (_extra: McpExtra) => ({ content: [] }),
      { name: 'search' },
    );
    await tool({ signal: new AbortController().signal, requestId: 1 } as unknown as McpExtra);

    const calls = only(events, '[MCP] Tool Call Response');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.event_properties?.['[MCP] Client Name']).not.toBe('server-a-client');
    expect(calls[0]?.event_properties?.['[MCP] Client Name']).toBe('unknown');
  });

  it('falls through when it throws, without breaking the handshake', async () => {
    const events: AmplitudeEvent[] = [];
    const { server } = instrumented(events, {
      resolveClientInfo: () => {
        throw new Error('boom');
      },
    });
    const [clientT, serverT] = httpPair();
    await server.connect(serverT);
    await send(clientT, initializeReq);

    expect(only(events, '[MCP] Session Initialized')[0]?.event_properties?.['[MCP] Client Name'])
      .toBe('cursor');
  });
});
