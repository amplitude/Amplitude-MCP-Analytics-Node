import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { AmplitudeMCPAnalytics } from '../src/client.js';
import type { McpServerContext } from '../src/context/types.js';

function makeAnalytics() {
  const amplitude = { track: () => undefined, flush: () => undefined };
  return new AmplitudeMCPAnalytics({ amplitude, serverName: 'test-mcp', serverVersion: '9.9.9' });
}

function serverCtxOf(analytics: AmplitudeMCPAnalytics): McpServerContext | undefined {
  return (analytics as unknown as { _serverCtx?: McpServerContext })._serverCtx;
}

/** Minimal fake of the high-level McpServer: a connect we can intercept and a
 *  low-level `.server` carrying the handshake hooks. */
function makeFakeServer(opts: { handleRequest?: boolean; clientInfo?: { name: string; version: string } } = {}) {
  let connectedTransport: unknown;
  const lowLevel: {
    oninitialized?: () => void;
    getClientVersion: () => { name: string; version: string } | undefined;
  } = {
    getClientVersion: () => opts.clientInfo,
  };
  const server = {
    server: lowLevel,
    connectCalls: [] as unknown[],
    connect(transport: unknown): Promise<void> {
      this.connectCalls.push(transport);
      connectedTransport = transport;
      return Promise.resolve();
    },
    isConnected: () => connectedTransport != null,
    /** Simulate the SDK firing the post-handshake callback. */
    fireInitialized() {
      lowLevel.oninitialized?.();
    },
  };
  return { server, lowLevel };
}

const stdioTransport = { start: async () => {}, send: async () => {}, close: async () => {} };
const httpTransport = { handleRequest: () => undefined, start: async () => {}, send: async () => {} };

describe('instrumentServer', () => {
  it('auto-detects stdio at connect and sets the server scope', async () => {
    const analytics = makeAnalytics();
    const { server } = makeFakeServer();

    expect(serverCtxOf(analytics)).toBeUndefined(); // nothing before connect
    analytics.instrumentServer(server as unknown as McpServer);
    expect(serverCtxOf(analytics)).toBeUndefined(); // transport not known until connect

    await server.connect(stdioTransport);
    const ctx = serverCtxOf(analytics);
    expect(ctx?.transport).toBe('stdio');
    expect(ctx?.server).toEqual({ name: 'test-mcp', version: '9.9.9' });
    expect(server.connectCalls).toEqual([stdioTransport]); // delegated to original
  });

  it('auto-detects streamable-http at connect', async () => {
    const analytics = makeAnalytics();
    const { server } = makeFakeServer({ handleRequest: true });
    analytics.instrumentServer(server as unknown as McpServer);
    await server.connect(httpTransport);
    expect(serverCtxOf(analytics)?.transport).toBe('streamable-http');
  });

  it('captures handshake clientInfo into the server scope (legacy / stdio path)', async () => {
    const analytics = makeAnalytics();
    const { server } = makeFakeServer({ clientInfo: { name: 'claude', version: '3.0' } });
    analytics.instrumentServer(server as unknown as McpServer);
    await server.connect(stdioTransport);

    expect(serverCtxOf(analytics)?.client).toBeUndefined(); // not until initialized
    server.fireInitialized();
    expect(serverCtxOf(analytics)?.client).toMatchObject({ name: 'claude', version: '3.0' });
  });

  it('chains an existing oninitialized rather than replacing it', async () => {
    const analytics = makeAnalytics();
    const { server, lowLevel } = makeFakeServer({ clientInfo: { name: 'claude', version: '3.0' } });
    const prior = vi.fn();
    lowLevel.oninitialized = prior;

    analytics.instrumentServer(server as unknown as McpServer);
    await server.connect(stdioTransport);
    server.fireInitialized();

    expect(prior).toHaveBeenCalledOnce();
    expect(serverCtxOf(analytics)?.client?.name).toBe('claude');
  });

  it('returns the same server and is idempotent (no double-wrap)', async () => {
    const analytics = makeAnalytics();
    const { server } = makeFakeServer();
    const returned = analytics.instrumentServer(server as unknown as McpServer);
    expect(returned).toBe(server);

    analytics.instrumentServer(server as unknown as McpServer); // second call is a no-op
    await server.connect(stdioTransport);
    expect(server.connectCalls).toHaveLength(1); // connect not wrapped twice
  });

  it('composes with a consumer-installed connect wrapper (delegates through it)', async () => {
    const analytics = makeAnalytics();
    const { server } = makeFakeServer();
    const original = server.connect.bind(server);
    const consumerWrapper = vi.fn((t: unknown) => original(t));
    server.connect = consumerWrapper as typeof server.connect;

    analytics.instrumentServer(server as unknown as McpServer); // captures the consumer wrapper as "original"
    await server.connect(stdioTransport);

    expect(consumerWrapper).toHaveBeenCalledOnce(); // our patch delegated through it
    expect(serverCtxOf(analytics)?.transport).toBe('stdio');
  });

  it('warns and no-ops when called after the server already connected', async () => {
    const analytics = makeAnalytics();
    const { server } = makeFakeServer();
    await server.connect(stdioTransport); // connect BEFORE instrument
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const returned = analytics.instrumentServer(server as unknown as McpServer);
    expect(returned).toBe(server);
    expect(serverCtxOf(analytics)).toBeUndefined(); // no scope established
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('works on a low-level Server (no .server property)', async () => {
    const analytics = makeAnalytics();
    let oninitialized: (() => void) | undefined;
    const lowLevelServer = {
      connect: (_t: unknown): Promise<void> => Promise.resolve(),
      isConnected: () => false,
      getClientVersion: () => ({ name: 'cli', version: '0.1' }),
      set oninitialized(fn: () => void) {
        oninitialized = fn;
      },
      get oninitialized() {
        return oninitialized as () => void;
      },
    };

    analytics.instrumentServer(lowLevelServer as unknown as Server);
    await lowLevelServer.connect(stdioTransport);
    expect(serverCtxOf(analytics)?.transport).toBe('stdio');
    oninitialized?.();
    expect(serverCtxOf(analytics)?.client?.name).toBe('cli');
  });
});
