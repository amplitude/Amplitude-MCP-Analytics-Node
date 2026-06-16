import { describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AmplitudeMCPAnalytics } from '../src/client.js';
import { createServerContext, getCurrentContext } from '../src/context/index.js';
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

/** Set the server-scope ctx. */
function bind(analytics: AmplitudeMCPAnalytics, transport: McpTransport = 'streamable-http') {
  (analytics as unknown as { _serverCtx?: McpServerContext })._serverCtx = createServerContext({
    server: { name: 'test-mcp', version: '9.9.9' },
    transport,
  });
}

/** Build a full MCP `extra` from the few fields a test cares about. */
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

/** Legacy Streamable HTTP request: session id + HTTP request info present. */
const legacyExtra = mkExtra({
  sessionId: 'sess-abc123',
  requestInfo: { headers: { 'user-agent': 'cursor/1.2.3' } },
  _meta: { clientInfo: { name: 'cursor', version: '1.2.3' } },
});

describe('instrumentTool', () => {
  it('wraps the handler transparently (native args + result pass through)', async () => {
    const { analytics, tracked } = makeAnalytics();
    bind(analytics);
    let received: unknown;
    const handler = async (args: { q: string }, _extra: McpExtra): Promise<CallToolResult> => {
      received = args;
      return ok(args.q);
    };

    const wrapped = analytics.instrumentTool('search_docs', handler, { owner: 'docs' });
    const result = await wrapped({ q: 'hello' }, legacyExtra);

    expect(received).toEqual({ q: 'hello' });
    expect(result).toEqual(ok('hello'));
    expect(tracked).toHaveLength(0); // no emission in the scaffold
  });

  it('builds a ctx (extending server scope) and exposes it via getCurrentContext()', async () => {
    const { analytics } = makeAnalytics();
    bind(analytics, 'streamable-http');
    let ctx: McpToolContext | undefined;
    const wrapped = analytics.instrumentTool('search_docs', async (_extra: McpExtra) => {
      ctx = getCurrentContext() as McpToolContext | undefined;
      return ok();
    });

    await wrapped(legacyExtra);
    expect(ctx?.tool.name).toBe('search_docs');
    expect(ctx?.transport).toBe('streamable-http'); // inherited from server scope
    expect(ctx?.client?.name).toBe('cursor'); // per-request, from _meta.clientInfo
    expect(ctx?.anchor).toEqual({ type: 'session-id', value: 'sess-abc123' }); // legacy HTTP
    expect(ctx?.identity.resolvedFrom).toBe('anchor');
    expect(ctx?.identity.userId).toBe('session-id:sess-abc123');
  });

  it('carries caller-supplied tool metadata onto ctx', async () => {
    const { analytics } = makeAnalytics();
    bind(analytics);
    let ctx: McpToolContext | undefined;
    const wrapped = analytics.instrumentTool(
      'search_docs',
      async (_extra: McpExtra) => {
        ctx = getCurrentContext() as McpToolContext | undefined;
        return ok();
      },
      { owner: 'docs-team', tags: ['search'] },
    );

    await wrapped(legacyExtra);
    expect(ctx?.tool).toMatchObject({ name: 'search_docs', owner: 'docs-team', tags: ['search'] });
  });

  it('lets handler errors propagate untouched', async () => {
    const { analytics } = makeAnalytics();
    bind(analytics);
    const wrapped = analytics.instrumentTool('boom', async (_extra: McpExtra): Promise<CallToolResult> => {
      throw new Error('kaboom');
    });

    await expect(wrapped(legacyExtra)).rejects.toThrow('kaboom');
  });

  it('runs the tool untouched when no server scope is bound', async () => {
    const { analytics, tracked } = makeAnalytics(); // not bound
    let ran = false;
    let sawCtx: McpToolContext | undefined = undefined;
    const wrapped = analytics.instrumentTool('t', async (_extra: McpExtra) => {
      ran = true;
      sawCtx = getCurrentContext() as McpToolContext | undefined;
      return ok('done');
    });

    const result = await wrapped(legacyExtra);
    expect(ran).toBe(true);
    expect(result).toEqual(ok('done'));
    expect(sawCtx).toBeUndefined(); // no ctx established without a server binding
    expect(tracked).toHaveLength(0);
  });
});
