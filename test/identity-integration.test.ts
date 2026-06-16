import { describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { AmplitudeMCPAnalytics } from '../src/client.js';
import { getCurrentContext } from '../src/context/index.js';
import type { McpToolContext } from '../src/context/types.js';
import type { McpExtra } from '../src/core/mcp.js';

function makeAnalytics() {
  const tracked: unknown[] = [];
  const amplitude = { track: (e: unknown) => void tracked.push(e), flush: () => undefined };
  const analytics = new AmplitudeMCPAnalytics({
    amplitude,
    serverName: 'test-mcp',
    serverVersion: '9.9.9',
  });

  return { analytics, tracked };
}

function makeFakeServer() {
  let connected = false;
  const lowLevel = {
    oninitialized: undefined as (() => void) | undefined,
    getClientVersion: () => undefined,
  };
  const server = {
    server: lowLevel,
    isConnected: () => connected,
    connect(_t: Transport): Promise<void> {
      connected = true;
      return Promise.resolve();
    },
  };

  return server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer;
}

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

const stdioTransport: Transport = {
  start: async () => {},
  send: async () => {},
  close: async () => {},
};

describe('instrumentServer with identity options', () => {
  it('sets server identity that flows into instrumentTool ctx', async () => {
    const { analytics } = makeAnalytics();
    const server = makeFakeServer();

    analytics.instrumentServer(server, {
      userId: 'operator@example.com',
      tenant: { groupType: 'org id', groupValue: '123' },
    });
    await server.connect(stdioTransport);

    let ctx: McpToolContext | undefined;
    const wrapped = analytics.instrumentTool('search', async (_extra: McpExtra) => {
      ctx = getCurrentContext() as McpToolContext | undefined;
      return ok();
    });

    await wrapped(mkExtra());

    expect(ctx?.identity.userId).toBe('operator@example.com');
    expect(ctx?.identity.resolvedFrom).toBe('explicit');
    expect(ctx?.tenant).toEqual({ groupType: 'org id', groupValue: '123' });
  });

  it('sets deviceId from server options', async () => {
    const { analytics } = makeAnalytics();
    const server = makeFakeServer();

    analytics.instrumentServer(server, {
      userId: 'operator',
      deviceId: 'my-static-device',
    });
    await server.connect(stdioTransport);

    let ctx: McpToolContext | undefined;
    const wrapped = analytics.instrumentTool('search', async (_extra: McpExtra) => {
      ctx = getCurrentContext() as McpToolContext | undefined;
      return ok();
    });

    await wrapped(mkExtra());

    expect(ctx?.identity.deviceId).toBe('my-static-device');
  });
});

describe('instrumentTool with resolveIdentity callback', () => {
  it('resolves identity from authInfo on the extra', async () => {
    const { analytics } = makeAnalytics();
    const server = makeFakeServer();
    analytics.instrumentServer(server);
    await server.connect(stdioTransport);

    let ctx: McpToolContext | undefined;
    const wrapped = analytics.instrumentTool(
      'search',
      async (_extra: McpExtra) => {
        ctx = getCurrentContext() as McpToolContext | undefined;
        return ok();
      },
      {
        resolveIdentity: (authInfo) => ({
          userId: authInfo?.email as string,
          tenant: { groupType: 'org id', groupValue: authInfo?.orgId as string },
        }),
      },
    );

    await wrapped(mkExtra({ authInfo: { email: 'bob@example.com', orgId: '99' } }));

    expect(ctx?.identity.userId).toBe('bob@example.com');
    expect(ctx?.identity.resolvedFrom).toBe('authInfo');
    expect(ctx?.tenant).toEqual({ groupType: 'org id', groupValue: '99' });
  });

  it('resolveIdentity wins over serverIdentity', async () => {
    const { analytics } = makeAnalytics();
    const server = makeFakeServer();
    analytics.instrumentServer(server, { userId: 'server-level' });
    await server.connect(stdioTransport);

    let ctx: McpToolContext | undefined;
    const wrapped = analytics.instrumentTool(
      'search',
      async (_extra: McpExtra) => {
        ctx = getCurrentContext() as McpToolContext | undefined;
        return ok();
      },
      {
        resolveIdentity: () => ({ userId: 'from-auth' }),
      },
    );

    await wrapped(mkExtra({ authInfo: {} }));

    expect(ctx?.identity.userId).toBe('from-auth');
    expect(ctx?.identity.resolvedFrom).toBe('authInfo');
  });

  it('falls through to serverIdentity when resolveIdentity returns empty', async () => {
    const { analytics } = makeAnalytics();
    const server = makeFakeServer();
    analytics.instrumentServer(server, { userId: 'server-level' });
    await server.connect(stdioTransport);

    let ctx: McpToolContext | undefined;
    const wrapped = analytics.instrumentTool(
      'search',
      async (_extra: McpExtra) => {
        ctx = getCurrentContext() as McpToolContext | undefined;
        return ok();
      },
      {
        resolveIdentity: () => ({}),
      },
    );

    await wrapped(mkExtra({ authInfo: {} }));

    expect(ctx?.identity.userId).toBe('server-level');
    expect(ctx?.identity.resolvedFrom).toBe('explicit');
  });

  it('setIdentity during handler overrides resolveIdentity', async () => {
    const { analytics } = makeAnalytics();
    const server = makeFakeServer();
    analytics.instrumentServer(server);
    await server.connect(stdioTransport);

    let ctx: McpToolContext | undefined;
    const wrapped = analytics.instrumentTool(
      'search',
      async (_extra: McpExtra) => {
        analytics.setIdentity({ userId: 'explicit-override' });
        ctx = getCurrentContext() as McpToolContext | undefined;
        return ok();
      },
      {
        resolveIdentity: () => ({ userId: 'from-auth' }),
      },
    );

    await wrapped(mkExtra({ authInfo: {} }));

    expect(ctx?.identity.userId).toBe('explicit-override');
    expect(ctx?.identity.resolvedFrom).toBe('explicit');
  });
});
