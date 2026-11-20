/**
 * Real v2 transports. Each case starts a transport, drives a real client,
 * checks the events, and exits. Nothing is left listening.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
  createMcpHandler,
} from '@modelcontextprotocol/server';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { AmplitudeMCPAnalytics } from '../../src/client.js';
import type { AmplitudeEvent } from '../../src/types.js';
import { listenFetch } from './http.js';
import { connectStdio, waitForEvents } from './stdio.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
});

function analytics(events: AmplitudeEvent[]): AmplitudeMCPAnalytics {
  return new AmplitudeMCPAnalytics({
    amplitude: { track: (event: AmplitudeEvent) => events.push(event), flush: () => undefined },
    serverName: 'v2-mcp',
    serverVersion: '1.0.0',
  });
}

function typesOf(events: AmplitudeEvent[]): string[] {
  return events.map((event) => event.event_type);
}

describe('v2 stdio', () => {
  it('anchors the session to the process and emits session events', async () => {
    const session = await connectStdio('v2');
    closers.push(session.close);
    await session.client.callTool({ name: 'ping', arguments: {} });
    await session.client.close();
    const events = await waitForEvents(session.events, (found) =>
      found.some((event) => event.event_type === '[MCP] Session Ended'),
    );

    const types = typesOf(events);
    expect(types).toContain('[MCP] Session Initialized');
    expect(types).toContain('[MCP] Session Ended');
    expect(types).toContain('[MCP] Tool Call Response');
    for (const event of events) {
      expect(event.event_properties?.['[MCP] Transport']).toBe('stdio');
      expect(event.event_properties?.['[MCP] Anchor Type']).toBe('process');
    }
    expect(events[0]?.user_id?.startsWith('process:')).toBe(true);
  }, 20_000);
});

describe('v2 Streamable HTTP, legacy era', () => {
  it('keeps a session on WebStandardStreamableHTTPServerTransport', async () => {
    const events: AmplitudeEvent[] = [];
    const sdk = analytics(events);
    const server = new McpServer({ name: 'v2-mcp', version: '1.0.0' });
    server.registerTool(
      'ping',
      { description: 'ping' },
      sdk.instrumentTool(async () => ({ content: [{ type: 'text' as const, text: 'pong' }] }), { name: 'ping' }),
    );
    sdk.instrumentServer(server, { userId: 'legacy-user' });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
    });
    await server.connect(transport);

    const listening = await listenFetch((request) => transport.handleRequest(request));
    closers.push(async () => {
      await listening.close();
      await transport.close();
    });

    const client = new Client({ name: 'legacy-client', version: '3.0.0' });
    await client.connect(new StreamableHTTPClientTransport(listening.url));
    await client.callTool({ name: 'ping', arguments: {} });
    await client.close();

    const init = events.find((event) => event.event_type === '[MCP] Session Initialized');
    expect(init?.event_properties?.['[MCP] Client Name']).toBe('legacy-client');
    expect(init?.event_properties?.['[MCP] Transport']).toBe('streamable-http');
    expect(init?.event_properties?.['[MCP] Session ID']).not.toBe('no-session');
    const call = events.find((event) => event.event_type === '[MCP] Tool Call Response');
    expect(call?.event_properties?.['[MCP] Transport']).toBe('streamable-http');
    expect(call?.user_id).toBe('legacy-user');
  }, 20_000);

  it('serves createMcpHandler’s default stateless fallback', async () => {
    const events: AmplitudeEvent[] = [];
    const sdk = analytics(events);
    const handler = createMcpHandler(() => {
      const server = new McpServer({ name: 'v2-mcp', version: '1.0.0' });
      server.registerTool(
        'ping',
        { description: 'ping' },
        sdk.instrumentTool(async () => ({ content: [{ type: 'text' as const, text: 'pong' }] }), { name: 'ping' }),
      );
      sdk.instrumentServer(server, { userId: 'stateless-user' });
      return server;
    });
    const listening = await listenFetch((request) => handler.fetch(request));
    closers.push(async () => {
      await listening.close();
      await handler.close();
    });

    const client = new Client({ name: 'legacy-client', version: '3.0.0' });
    await client.connect(new StreamableHTTPClientTransport(listening.url));
    await client.callTool({ name: 'ping', arguments: {} });
    await client.close();

    const call = events.find((event) => event.event_type === '[MCP] Tool Call Response');
    expect(call?.event_properties).toMatchObject({
      '[MCP] Transport': 'streamable-http',
      '[MCP] Tool Name': 'ping',
      '[MCP] Session ID': 'no-session',
    });
    expect(call?.event_properties?.['[MCP] Anchor Type']).not.toBe('process');
    expect(call?.user_id).toBe('stateless-user');
  }, 20_000);
});

describe('v2 createMcpHandler on 2026-07-28', () => {
  it('reads the envelope, stays aggregate-capable, and does not cross-attribute', async () => {
    const events: AmplitudeEvent[] = [];
    const sdk = analytics(events);
    const resolveIdentity = (authInfo: Record<string, unknown> | undefined) => {
      const clientId = authInfo?.clientId;
      return typeof clientId === 'string' ? { userId: `user-${clientId}` } : {};
    };
    const handler = createMcpHandler(
      () => {
        const server = new McpServer({ name: 'v2-mcp', version: '1.0.0' });
        server.registerTool(
          'ping',
          { description: 'ping' },
          sdk.instrumentTool(
            async () => ({ content: [{ type: 'text' as const, text: 'pong' }] }),
            { name: 'ping' },
            { resolveIdentity },
          ),
        );
        // Server events use the server resolver; tool events use the one passed
        // to instrumentTool. A 2026-07-28 exchange has no session events, so the
        // tool resolver is what attributes the call.
        sdk.instrumentServer(server, { resolveIdentity });
        return server;
      },
      { responseMode: 'json' },
    );
    const listening = await listenFetch((request) => {
      const clientId = request.headers.get('x-oauth-client-id');
      return handler.fetch(
        request,
        clientId == null ? undefined : { authInfo: { token: 'token', clientId, scopes: [] } },
      );
    });
    closers.push(async () => {
      await listening.close();
      await handler.close();
    });

    const connect = async (clientId: string) => {
      const client = new Client(
        { name: `host-${clientId}`, version: '8.0.0' },
        { versionNegotiation: { mode: { pin: '2026-07-28' } } },
      );
      await client.connect(
        new StreamableHTTPClientTransport(listening.url, {
          requestInit: { headers: { 'x-oauth-client-id': clientId } },
        }),
      );
      return client;
    };

    const [alpha, beta] = await Promise.all([connect('alpha'), connect('beta')]);
    await Promise.all([
      alpha.callTool({ name: 'ping', arguments: {} }),
      beta.callTool({ name: 'ping', arguments: {} }),
    ]);
    await alpha.close();
    await beta.close();

    expect(typesOf(events)).not.toContain('[MCP] Session Initialized');
    expect(typesOf(events)).not.toContain('[MCP] Session Ended');

    const calls = events.filter((event) => event.event_type === '[MCP] Tool Call Response');
    expect(calls).toHaveLength(2);
    const byUser = new Map(
      calls.flatMap((event) => (event.user_id == null ? [] : [[event.user_id, event] as const])),
    );
    expect([...byUser.keys()].sort()).toEqual(['user-alpha', 'user-beta']);
    for (const [userId, event] of byUser) {
      const clientId = userId.slice('user-'.length);
      expect(event.event_properties).toMatchObject({
        '[MCP] Client Name': `host-${clientId}`,
        '[MCP] Protocol Version': '2026-07-28',
        '[MCP] Transport': 'streamable-http',
        '[MCP] OAuth Client ID': clientId,
      });
      expect(event.event_properties?.['[MCP] Anchor Type']).not.toBe('process');
    }
  }, 20_000);
});
