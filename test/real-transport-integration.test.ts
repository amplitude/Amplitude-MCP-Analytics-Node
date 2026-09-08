/**
 * End-to-end over a REAL `StreamableHTTPServerTransport` on a real `node:http`
 * server, driven by a real SDK `Client`.
 *
 * Everything else in this suite either hand-rolls a server or fakes the
 * transport by duck-typing `handleRequest`/`sessionId` — `resolveTransport`
 * classifies structurally, so a fake satisfies it. That leaves the inputs our
 * resolution logic depends on asserted rather than observed:
 *
 *   - whether the transport populates `extra.requestInfo.headers` at all
 *     (`[MCP] User Agent`, `MCP-Protocol-Version`)
 *   - whether it has minted its session id by the time the `initialize`
 *     request is dispatched, which is what `[MCP] Session Initialized`'s anchor
 *     depends on
 *   - that stateless mode really does force a transport (and so a server) per
 *     request, which is the whole premise of the initialize-request hook
 *
 * These run the two deployment shapes for real instead. The stateless case is
 * the customer topology that produced the client-name bug.
 */
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { AmplitudeMCPAnalytics } from '../src/client.js';
import { MCPAnalyticsConfig } from '../src/config.js';
import type { McpExtra } from '../src/core/mcp.js';
import type { AmplitudeEvent } from '../src/types.js';

const only = (events: AmplitudeEvent[], type: string) =>
  events.filter((e) => e.event_type === type);
const propsOf = (e: AmplitudeEvent | undefined) => e?.event_properties ?? {};

interface Harness {
  url: URL;
  events: AmplitudeEvent[];
  close: () => Promise<void>;
}

/**
 * Build one instrumented `McpServer` with a single tool. Called per request in
 * the stateless harness, once in the session-bearing one.
 */
function buildServer(events: AmplitudeEvent[]): McpServer {
  const analytics = new AmplitudeMCPAnalytics({
    amplitude: { track: (e: AmplitudeEvent) => events.push(e), flush: () => undefined },
    serverName: 'real-transport-mcp',
    serverVersion: '1.0.0',
    config: new MCPAnalyticsConfig({}),
  });
  const server = new McpServer({ name: 'real-transport-mcp', version: '1.0.0' });
  server.registerTool(
    'ping',
    { description: 'ping' },
    analytics.instrumentTool(
      async (_extra: McpExtra) => ({ content: [{ type: 'text' as const, text: 'pong' }] }),
      { name: 'ping' },
    ),
  );
  analytics.instrumentServer(server, { userId: 'real-user-1', authType: 'oauth' });
  return server;
}

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ http: HttpServer; url: URL }> {
  const http = createServer(handler);
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const addr = http.address();
  if (addr == null || typeof addr === 'string') throw new Error('no port assigned');
  return { http, url: new URL(`http://127.0.0.1:${addr.port}/mcp`) };
}

/**
 * Stateless: `sessionIdGenerator: undefined`, and a fresh transport + server
 * per request — which the SDK requires, not merely permits.
 */
async function statelessHarness(): Promise<Harness> {
  const events: AmplitudeEvent[] = [];
  const { http, url } = await listen((req, res) => {
    // A stateless deployment has no per-connection stream to offer, so it
    // serves POST only and answers the optional GET/DELETE endpoints with 405.
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = buildServer(events);
    server
      .connect(transport)
      .then(() => transport.handleRequest(req, res))
      .catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
  });
  return {
    url,
    events,
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  };
}

/** Session-bearing: one transport, reused across requests by `Mcp-Session-Id`. */
async function sessionHarness(): Promise<Harness> {
  const events: AmplitudeEvent[] = [];
  let transport: StreamableHTTPServerTransport | undefined;
  const { http, url } = await listen((req, res) => {
    const start = async (): Promise<void> => {
      if (transport == null) {
        transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
        await buildServer(events).connect(transport);
      }
      await transport.handleRequest(req, res);
    };
    start().catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  return {
    url,
    events,
    close: async () => {
      await transport?.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

async function connectClient(url: URL): Promise<Client> {
  const client = new Client({ name: 'real-client', version: '4.5.6' });
  await client.connect(new StreamableHTTPClientTransport(url));
  return client;
}

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

describe('real Streamable HTTP transport — stateless', () => {
  it('resolves the real client name and reports no session, end to end', async () => {
    const h = await statelessHarness();
    cleanup.push(h.close);
    const client = await connectClient(h.url);
    await client.listTools();
    await client.callTool({ name: 'ping', arguments: {} });
    await client.close();
    await new Promise((r) => setTimeout(r, 50));

    // The handshake is a real POST served by a server instance that is then
    // discarded — the exact topology that used to report `unknown`.
    const inits = only(h.events, '[MCP] Session Initialized');
    expect(inits).toHaveLength(1);
    expect(propsOf(inits[0])['[MCP] Client Name']).toBe('real-client');
    expect(propsOf(inits[0])['[MCP] Client Version']).toBe('4.5.6');
    expect(propsOf(inits[0])['[MCP] Transport']).toBe('streamable-http');
    expect(propsOf(inits[0])['[MCP] Session ID']).toBe('no-session');

    // A transport that lives for one request reports no duration.
    expect(only(h.events, '[MCP] Session Ended')).toHaveLength(0);

    // Later requests are separate POSTs on fresh servers, so they cannot see
    // the handshake. This is the residual gap `resolveClientInfo` exists for.
    const calls = only(h.events, '[MCP] Tool Call Response');
    expect(calls).toHaveLength(1);
    expect(propsOf(calls[0])['[MCP] Tool Name']).toBe('ping');
    expect(propsOf(calls[0])['[MCP] Is Error']).toBe(false);
    expect(propsOf(calls[0])['[MCP] Session ID']).toBe('no-session');
    expect(only(h.events, '[MCP] Tools Listed')).toHaveLength(1);
  });

  it('populates User Agent and Protocol Version from real request headers', async () => {
    const h = await statelessHarness();
    cleanup.push(h.close);
    const client = await connectClient(h.url);
    await client.callTool({ name: 'ping', arguments: {} });
    await client.close();
    await new Promise((r) => setTimeout(r, 50));

    // Asserted against headers the transport actually set, not a hand-built
    // `extra.requestInfo`.
    const calls = only(h.events, '[MCP] Tool Call Response');
    expect(calls).toHaveLength(1);
    expect(propsOf(calls[0])['[MCP] User Agent']).not.toBe('unknown');
    expect(typeof propsOf(calls[0])['[MCP] User Agent']).toBe('string');
    expect(propsOf(calls[0])['[MCP] Protocol Version']).toEqual(expect.any(String));
  });
});

describe('real Streamable HTTP transport — session-bearing', () => {
  it('anchors on the transport session id and reports a session duration', async () => {
    const h = await sessionHarness();
    cleanup.push(h.close);
    const client = await connectClient(h.url);
    await client.callTool({ name: 'ping', arguments: {} });

    const inits = only(h.events, '[MCP] Session Initialized');
    expect(inits).toHaveLength(1);
    expect(propsOf(inits[0])['[MCP] Anchor Type']).toBe('session-id');
    expect(propsOf(inits[0])['[MCP] Client Name']).toBe('real-client');

    // The id must be the transport's own, present already at the handshake —
    // the timing `[MCP] Session Initialized` relies on.
    const sessionId = propsOf(inits[0])['[MCP] Session ID'];
    expect(typeof sessionId).toBe('string');
    expect(sessionId).not.toBe('no-session');

    // One instance serves the connection, so the name carries forward and the
    // whole conversation shares one session id.
    const calls = only(h.events, '[MCP] Tool Call Response');
    expect(calls).toHaveLength(1);
    expect(propsOf(calls[0])['[MCP] Session ID']).toBe(sessionId);
    expect(propsOf(calls[0])['[MCP] Client Name']).toBe('real-client');

    await client.close();
    await h.close();
    cleanup = [];
    await new Promise((r) => setTimeout(r, 50));

    const ended = only(h.events, '[MCP] Session Ended');
    expect(ended).toHaveLength(1);
    expect(propsOf(ended[0])['[MCP] Session ID']).toBe(sessionId);
    expect(propsOf(ended[0])).toHaveProperty('[MCP] Session Duration');
  });

  it('refuses to reuse a stateless transport across requests', async () => {
    // Pins the SDK constraint the initialize-request hook is designed around:
    // stateless mode is not merely compatible with a server per request, it
    // requires one. If this ever stops throwing, a host could keep one
    // instance and the handshake cache would start working by accident.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await buildServer([]).connect(transport);
    const { http, url } = await listen((req, res) => {
      transport.handleRequest(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
    cleanup.push(() => new Promise<void>((resolve) => http.close(() => resolve())));

    // A single `Client.connect()` is already more than one POST (`initialize`,
    // then `notifications/initialized`), so a reused stateless transport fails
    // before the handshake even completes.
    await expect(connectClient(url)).rejects.toThrow();
  });
});
