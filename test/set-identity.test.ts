import { describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AmplitudeMCPAnalytics } from '../src/client.js';
import {
  createServerContext,
  getCurrentContext,
  runWithContext,
  setIdentity,
} from '../src/context/index.js';
import type { McpServerContext, McpToolContext, McpTransport } from '../src/context/types.js';
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

function bind(analytics: AmplitudeMCPAnalytics, transport: McpTransport = 'streamable-http') {
  (analytics as unknown as { _serverCtx?: McpServerContext })._serverCtx = createServerContext({
    server: { name: 'test-mcp', version: '9.9.9' },
    transport,
  });
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

describe('setIdentity', () => {
  it('throws when called outside a context scope', () => {
    expect(() => setIdentity({ userId: 'alice' })).toThrow('outside an active context scope');
  });

  it('overrides identity on the ambient context (userId)', () => {
    const ctx = createServerContext({
      server: { name: 'test', version: '1' },
      transport: 'stdio',
    });
    let snapshot: McpServerContext | undefined;
    runWithContext(ctx, () => {
      setIdentity({ userId: 'alice@example.com' });
      snapshot = getCurrentContext();
    });
    expect(snapshot?.identity.userId).toBe('alice@example.com');
    expect(snapshot?.identity.resolvedFrom).toBe('explicit');
  });

  it('overrides identity on the ambient context (deviceId only)', () => {
    const ctx = createServerContext({
      server: { name: 'test', version: '1' },
      transport: 'stdio',
    });
    let snapshot: McpServerContext | undefined;
    runWithContext(ctx, () => {
      setIdentity({ deviceId: 'my-device-id' });
      snapshot = getCurrentContext();
    });
    expect(snapshot?.identity.deviceId).toBe('my-device-id');
    expect(snapshot?.identity.resolvedFrom).toBe('explicit');
  });

  it('sets tenant on the ambient context', () => {
    const ctx = createServerContext({
      server: { name: 'test', version: '1' },
      transport: 'stdio',
    });
    let snapshot: McpServerContext | undefined;
    runWithContext(ctx, () => {
      setIdentity({ tenant: { groupType: 'org id', groupValue: '42' } });
      snapshot = getCurrentContext();
    });
    expect(snapshot?.tenant).toEqual({ groupType: 'org id', groupValue: '42' });
  });

  it('does not change resolvedFrom when only tenant is set', () => {
    const ctx = createServerContext({
      server: { name: 'test', version: '1' },
      transport: 'stdio',
      identity: { resolvedFrom: 'anchor', userId: 'process:1234' },
    });
    runWithContext(ctx, () => {
      setIdentity({ tenant: { groupType: 'org id', groupValue: '42' } });
    });
    expect(ctx.identity.resolvedFrom).toBe('anchor');
    expect(ctx.identity.userId).toBe('process:1234');
  });
});

describe('setIdentity — via analytics.setIdentity() inside instrumentTool', () => {
  const legacyExtra = mkExtra({
    sessionId: 'sess-abc123',
    requestInfo: { headers: { 'user-agent': 'cursor/1.2.3' } },
    _meta: { clientInfo: { name: 'cursor', version: '1.2.3' } },
  });

  it('overrides the fallback-chain identity when called during handler execution', async () => {
    const { analytics } = makeAnalytics();
    bind(analytics, 'streamable-http');

    let ctx: McpToolContext | undefined;
    const wrapped = analytics.instrumentTool('search', async (_extra: McpExtra) => {
      analytics.setIdentity({
        userId: 'alice@example.com',
        tenant: { groupType: 'org id', groupValue: '42' },
      });
      ctx = getCurrentContext() as McpToolContext | undefined;
      return ok();
    });

    await wrapped(legacyExtra);

    expect(ctx?.identity.userId).toBe('alice@example.com');
    expect(ctx?.identity.resolvedFrom).toBe('explicit');
    expect(ctx?.tenant).toEqual({ groupType: 'org id', groupValue: '42' });
  });

  it('setIdentity from a shared helper at any async depth works', async () => {
    const { analytics } = makeAnalytics();
    bind(analytics, 'streamable-http');

    async function resolveAndSetIdentity() {
      analytics.setIdentity({ userId: 'deep-call@example.com' });
    }

    let ctx: McpToolContext | undefined;
    const wrapped = analytics.instrumentTool('search', async (_extra: McpExtra) => {
      await resolveAndSetIdentity();
      ctx = getCurrentContext() as McpToolContext | undefined;
      return ok();
    });

    await wrapped(legacyExtra);
    expect(ctx?.identity.userId).toBe('deep-call@example.com');
    expect(ctx?.identity.resolvedFrom).toBe('explicit');
  });
});
