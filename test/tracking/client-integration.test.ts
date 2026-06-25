import { describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  createServerContext,
  createToolContext,
  getCurrentContext,
} from '../../src/context/index.js';
import type { McpServerContext, McpToolContext } from '../../src/context/types.js';
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
      '[MCP] Tool Name': 'search_docs',
      '[MCP] Tool Owner': 'docs-team',
      'query text': 'hi',
    });
  });

  it('exposes instrumentTool that emits the stub response event around the handler', async () => {
    const mock = new MockAmplitudeMCPAnalytics({
      serverName: 'test-server',
      serverVersion: '0.0.0',
    });
    // Bind a server scope with a tenant so the event is emitted (events with
    // neither an identity nor a tenant are dropped; identity is floored here).
    (mock as unknown as { _serverCtx?: McpServerContext })._serverCtx = createServerContext({
      server: { name: 'test-server', version: '0.0.0' },
      transport: 'streamable-http',
      tenant: { groupType: 'org id', groupValue: '36958' },
    });

    let receivedCtx: McpToolContext | undefined;
    const wrapped = mock.instrumentTool<[{ q: string }, McpExtra], Promise<CallToolResult>>(
      async (args, _extra) => {
        receivedCtx = getCurrentContext() as McpToolContext | undefined;
        return ok(args.q);
      },
      { name: 'search_docs' },
    );

    const result = await wrapped({ q: 'hi' }, mkExtra());

    expect(result).toEqual(ok('hi'));
    expect(receivedCtx?.tool.name).toBe('search_docs');

    const response = mock.getEvents('[MCP] Tool Call Response');
    expect(response).toHaveLength(1);
    expect(response[0]?.event_properties).toMatchObject({
      '[MCP] Is Error': false,
      '[MCP] Tool Name': 'search_docs',
    });
  });

  it('instrumentTool is a no-op passthrough when instrumentServer was not called', async () => {
    const mock = new MockAmplitudeMCPAnalytics({
      serverName: 'test-server',
      serverVersion: '0.0.0',
    });

    // No instrumentServer() → no server scope bound → analytics is off.
    let ran = false;
    const wrapped = mock.instrumentTool<[McpExtra], Promise<CallToolResult>>(
      async (_extra) => {
        ran = true;
        return ok();
      },
      { name: 'search_docs' },
    );

    await wrapped(mkExtra());
    expect(ran).toBe(true); // the tool still runs
    expect(mock.events).toHaveLength(0); // nothing emitted
  });
});
