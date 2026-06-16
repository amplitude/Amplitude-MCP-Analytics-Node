import { describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createServerContext, createToolContext } from '../../src/context/index.js';
import type { McpToolContext } from '../../src/context/types.js';
import type { McpExtra } from '../../src/core/mcp.js';
import { MockAmplitudeMCPAnalytics } from '../../src/testing.js';

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

describe('AmplitudeMCPAnalytics — custom event API', () => {
  it('exposes trackServerEvent that emits through the underlying client', () => {
    const mock = new MockAmplitudeMCPAnalytics({
      serverName: 'test-server',
      serverVersion: '0.0.0',
    });
    const ctx = createServerContext({
      server: { name: 'test-server', version: '0.0.0' },
      transport: 'streamable-http',
      identity: { userId: 'u1', resolvedFrom: 'explicit' },
    });

    mock.trackServerEvent(ctx, 'mcp: custom event', { foo: 'bar' });

    expect(mock.events).toHaveLength(1);
    expect(mock.events[0]?.event_type).toBe('mcp: custom event');
    expect(mock.events[0]?.user_id).toBe('u1');
    expect(mock.events[0]?.event_properties?.foo).toBe('bar');
  });

  it('exposes trackToolEvent that inherits tool metadata', () => {
    const mock = new MockAmplitudeMCPAnalytics({
      serverName: 'test-server',
      serverVersion: '0.0.0',
    });
    const ctx = createToolContext(
      {
        server: { name: 'test-server' },
        transport: 'streamable-http',
        identity: { userId: 'u1', resolvedFrom: 'explicit' },
      },
      { name: 'search_docs', owner: 'docs-team' },
    );

    mock.trackToolEvent(ctx, 'mcp: tool query', { 'query text': 'hi' });

    expect(mock.events).toHaveLength(1);
    expect(mock.events[0]?.event_properties).toMatchObject({
      'tool name': 'search_docs',
      'tool owner': 'docs-team',
      'query text': 'hi',
    });
  });

  it('exposes wrapTool that emits the stub response event around the handler', async () => {
    const mock = new MockAmplitudeMCPAnalytics({
      serverName: 'test-server',
      serverVersion: '0.0.0',
      extractContext: () =>
        createServerContext({
          server: { name: 'test-server', version: '0.0.0' },
          transport: 'streamable-http',
          identity: { userId: 'u1', resolvedFrom: 'explicit' },
        }),
    });

    let receivedCtx: McpToolContext | undefined;
    const wrapped = mock.wrapTool<[{ q: string }, McpExtra], Promise<CallToolResult>>(
      { name: 'search_docs' },
      async (ctx, args, _extra) => {
        receivedCtx = ctx;
        return ok(args.q);
      },
    );

    const result = await wrapped({ q: 'hi' }, mkExtra());

    expect(result).toEqual(ok('hi'));
    expect(receivedCtx?.tool.name).toBe('search_docs');
    expect(receivedCtx?.identity.userId).toBe('u1');

    const response = mock.getEvents('mcp: tool call response');
    expect(response).toHaveLength(1);
    expect(response[0]?.event_properties).toMatchObject({
      'tool call status': 'success',
      'tool name': 'search_docs',
    });
  });

  it('wrapTool with the default extractor emits nothing (anonymous floor → skip rule)', async () => {
    const mock = new MockAmplitudeMCPAnalytics({
      serverName: 'test-server',
      serverVersion: '0.0.0',
    });

    const wrapped = mock.wrapTool<[McpExtra], Promise<CallToolResult>>(
      { name: 'search_docs' },
      async (_ctx, _extra) => ok(),
    );

    await wrapped(mkExtra());
    expect(mock.events).toHaveLength(0);
  });
});
