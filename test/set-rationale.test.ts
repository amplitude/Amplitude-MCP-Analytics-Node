import { describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AmplitudeMCPAnalytics } from '../src/client.js';
import {
  createServerContext,
  createToolContext,
  getCurrentContext,
  runWithContext,
  setRationale,
} from '../src/context/index.js';
import type { McpServerContext, McpToolContext, McpTransport } from '../src/context/types.js';
import type { McpExtra } from '../src/core/mcp.js';
import type { AmplitudeEvent } from '../src/types.js';

function makeAnalytics() {
  const tracked: AmplitudeEvent[] = [];
  const amplitude = { track: (e: AmplitudeEvent) => void tracked.push(e), flush: () => undefined };
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

function mkToolCtx(): McpToolContext {
  return createToolContext(
    {
      server: { name: 'test', version: '1' },
      transport: 'streamable-http',
    },
    { name: 'search' },
    { request: { method: 'tools/call' } },
  );
}

const ok = (text = 'ok'): CallToolResult => ({ content: [{ type: 'text', text }] });

describe('setRationale', () => {
  it('throws when called outside a context scope', () => {
    expect(() => setRationale('why not')).toThrow('outside an active context scope');
  });

  it('sets the rationale on the ambient tool context', () => {
    const ctx = mkToolCtx();
    runWithContext(ctx, () => {
      setRationale('need project ids before querying');
    });
    expect(ctx.request?.rationale).toBe('need project ids before querying');
  });

  it('preserves other request fields when setting', () => {
    const ctx = mkToolCtx();
    runWithContext(ctx, () => {
      setRationale('why');
    });
    expect(ctx.request?.method).toBe('tools/call');
  });

  it('ignores empty and non-string values', () => {
    const ctx = mkToolCtx();
    runWithContext(ctx, () => {
      setRationale('');
      setRationale(undefined as unknown as string);
      setRationale(42 as unknown as string);
    });
    expect(ctx.request?.rationale).toBeUndefined();
  });

  it('truncates to 1000 characters', () => {
    const ctx = mkToolCtx();
    runWithContext(ctx, () => {
      setRationale('x'.repeat(5000));
    });
    expect(ctx.request?.rationale).toHaveLength(1000);
  });

  it('last write wins when called more than once', () => {
    const ctx = mkToolCtx();
    runWithContext(ctx, () => {
      setRationale('first');
      setRationale('second');
    });
    expect(ctx.request?.rationale).toBe('second');
  });
});

describe('setRationale — via analytics.setRationale() inside instrumentTool', () => {
  const legacyExtra = mkExtra({
    sessionId: 'sess-abc123',
    requestInfo: { headers: { 'user-agent': 'cursor/1.2.3' } },
    _meta: { clientInfo: { name: 'cursor', version: '1.2.3' } },
  });

  it('emits [MCP] Rationale on the default tool-call event', async () => {
    const { analytics, tracked } = makeAnalytics();
    bind(analytics, 'streamable-http');

    const wrapped = analytics.instrumentTool(async (_extra: McpExtra) => {
      // Identity so `shouldEmit` passes — mirrors real host wiring.
      analytics.setIdentity({ userId: 'alice@example.com' });
      analytics.setRationale('verify chart before mutation');
      return ok();
    }, { name: 'search' });

    await wrapped(legacyExtra);

    const event = tracked.find((e) => e.event_type === '[MCP] Tool Call Response');
    expect(event?.event_properties?.['[MCP] Rationale']).toBe('verify chart before mutation');
  });

  it('is inherited by tool-scope custom events of the same invocation', async () => {
    const { analytics, tracked } = makeAnalytics();
    bind(analytics, 'streamable-http');

    const wrapped = analytics.instrumentTool(async (_extra: McpExtra) => {
      analytics.setIdentity({ userId: 'alice@example.com' });
      analytics.setRationale('inherited by customs');
      const ctx = getCurrentContext() as McpToolContext;
      analytics.trackToolEvent(ctx, '[MCP] Query Tool Call', { status: 'pass' });
      return ok();
    }, { name: 'search' });

    await wrapped(legacyExtra);

    const custom = tracked.find((e) => e.event_type === '[MCP] Query Tool Call');
    expect(custom?.event_properties?.['[MCP] Rationale']).toBe('inherited by customs');
  });

  it('works from a shared helper at any async depth', async () => {
    const { analytics, tracked } = makeAnalytics();
    bind(analytics, 'streamable-http');

    async function resolveAndSetRationale() {
      analytics.setRationale('deep-call rationale');
    }

    const wrapped = analytics.instrumentTool(async (_extra: McpExtra) => {
      analytics.setIdentity({ userId: 'alice@example.com' });
      await resolveAndSetRationale();
      return ok();
    }, { name: 'search' });

    await wrapped(legacyExtra);

    const event = tracked.find((e) => e.event_type === '[MCP] Tool Call Response');
    expect(event?.event_properties?.['[MCP] Rationale']).toBe('deep-call rationale');
  });

  it('emits no [MCP] Rationale when never set (optional default)', async () => {
    const { analytics, tracked } = makeAnalytics();
    bind(analytics, 'streamable-http');

    const wrapped = analytics.instrumentTool(async (_extra: McpExtra) => {
      analytics.setIdentity({ userId: 'alice@example.com' });
      return ok();
    }, { name: 'search' });

    await wrapped(legacyExtra);

    const event = tracked.find((e) => e.event_type === '[MCP] Tool Call Response');
    expect(event?.event_properties).not.toHaveProperty('[MCP] Rationale');
  });
});
