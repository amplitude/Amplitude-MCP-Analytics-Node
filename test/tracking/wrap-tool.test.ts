import { describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createServerContext, getCurrentContext } from '../../src/context/index.js';
import type { McpServerContext, McpToolContext } from '../../src/context/types.js';
import type { McpExtra } from '../../src/core/mcp.js';
import { wrapTool } from '../../src/tracking/wrap-tool.js';
import type { ContextExtractor } from '../../src/tracking/types.js';
import type { AmplitudeClientLike, AmplitudeEvent } from '../../src/types.js';

function makeAmplitude(): { client: AmplitudeClientLike; tracked: AmplitudeEvent[] } {
  const tracked: AmplitudeEvent[] = [];
  return {
    tracked,
    client: {
      track: (e) => {
        tracked.push(e);
      },
      flush: () => undefined,
    },
  };
}

function resolvedExtractor(overrides: Partial<McpServerContext> = {}): ContextExtractor {
  return () =>
    createServerContext({
      server: { name: 'my-server', version: '1.0.0' },
      transport: 'streamable-http',
      identity: { userId: 'u1', resolvedFrom: 'userId' },
      tenant: { groupType: 'org id', groupValue: '36958' },
      ...overrides,
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

describe('wrapTool', () => {
  it('builds a tool-scope ctx, threads it to the handler, runs under ALS', async () => {
    const { client } = makeAmplitude();
    let received: McpToolContext | undefined;
    let ambient: McpToolContext | undefined;

    const wrapped = wrapTool(
      { amplitude: client, extractContext: resolvedExtractor() },
      { name: 'search_docs', owner: 'docs-team' },
      async (ctx: McpToolContext, _args: { q: string }, _extra: McpExtra): Promise<CallToolResult> => {
        received = ctx;
        ambient = getCurrentContext() as McpToolContext | undefined;
        return ok();
      },
    );

    await wrapped({ q: 'hi' }, mkExtra());

    expect(received?.tool.name).toBe('search_docs');
    expect(received?.tool.owner).toBe('docs-team');
    expect(received?.identity.userId).toBe('u1');
    expect(received?.tenant).toEqual({ groupType: 'org id', groupValue: '36958' });
    expect(ambient).toBe(received);
  });

  it('emits a stub `mcp: tool call response` event with success status + duration on the happy path', async () => {
    const { client, tracked } = makeAmplitude();
    const wrapped = wrapTool(
      { amplitude: client, extractContext: resolvedExtractor() },
      { name: 'search_docs' },
      async (_ctx: McpToolContext, _extra: McpExtra) => ok(),
    );

    await wrapped(mkExtra());

    const responseEvents = tracked.filter((e) => e.event_type === 'mcp: tool call response');
    expect(responseEvents).toHaveLength(1);
    expect(responseEvents[0]?.event_properties).toMatchObject({
      'tool call status': 'success',
      'tool name': 'search_docs',
    });
    expect(responseEvents[0]?.event_properties?.['tool call duration ms']).toEqual(
      expect.any(Number),
    );
  });

  it('emits a failure event and rethrows when the handler throws (best-effort applies to emit, not the handler)', async () => {
    const { client, tracked } = makeAmplitude();
    const wrapped = wrapTool(
      { amplitude: client, extractContext: resolvedExtractor() },
      { name: 'boom' },
      async (_ctx: McpToolContext, _extra: McpExtra): Promise<CallToolResult> => {
        throw new Error('kaboom');
      },
    );

    await expect(wrapped(mkExtra())).rejects.toThrow('kaboom');

    const events = tracked.filter((e) => e.event_type === 'mcp: tool call response');
    expect(events).toHaveLength(1);
    expect(events[0]?.event_properties).toMatchObject({
      'tool call status': 'error',
      'tool name': 'boom',
      'error message': 'kaboom',
      'error type': 'Error',
    });
  });

  it('preserves a synchronous handler shape (returns sync result, not a promise)', () => {
    const { client, tracked } = makeAmplitude();
    const wrapped = wrapTool(
      { amplitude: client, extractContext: resolvedExtractor() },
      { name: 'sync_tool' },
      (_ctx: McpToolContext, _extra: McpExtra): CallToolResult => ok('sync'),
    );

    const result = wrapped(mkExtra());
    expect(result).toEqual(ok('sync'));
    expect(tracked.filter((e) => e.event_type === 'mcp: tool call response')).toHaveLength(1);
  });

  it('handles synchronous throws (sync handler) by emitting failure + rethrowing', () => {
    const { client, tracked } = makeAmplitude();
    const wrapped = wrapTool(
      { amplitude: client, extractContext: resolvedExtractor() },
      { name: 'sync_throw' },
      (_ctx: McpToolContext, _extra: McpExtra): CallToolResult => {
        throw new Error('sync boom');
      },
    );

    expect(() => wrapped(mkExtra())).toThrow('sync boom');
    const events = tracked.filter((e) => e.event_type === 'mcp: tool call response');
    expect(events).toHaveLength(1);
    expect(events[0]?.event_properties?.['tool call status']).toBe('error');
    expect(events[0]?.event_properties?.['error message']).toBe('sync boom');
  });

  it('builds a fresh ctx per invocation (no state bleed across concurrent calls)', async () => {
    const { client } = makeAmplitude();
    const seen: McpToolContext[] = [];

    let invocationId = 0;
    const perInvocationExtractor: ContextExtractor = () => {
      invocationId += 1;
      return createServerContext({
        server: { name: 'my-server' },
        transport: 'streamable-http',
        identity: { userId: `u${invocationId}`, resolvedFrom: 'userId' },
      });
    };

    const wrapped = wrapTool(
      { amplitude: client, extractContext: perInvocationExtractor },
      { name: 'search_docs' },
      async (ctx: McpToolContext, _extra: McpExtra) => {
        seen.push(ctx);
        // Force ordering — both calls in flight before either resolves.
        await new Promise((r) => setTimeout(r, 5));
        return ok();
      },
    );

    await Promise.all([wrapped(mkExtra()), wrapped(mkExtra())]);

    expect(seen).toHaveLength(2);
    expect(seen[0]?.identity.userId).toBe('u1');
    expect(seen[1]?.identity.userId).toBe('u2');
    expect(seen[0]).not.toBe(seen[1]);
  });

  it('skips the stub event when the extractor yields anonymous floor (audit §2)', async () => {
    const { client, tracked } = makeAmplitude();
    const wrapped = wrapTool(
      {
        amplitude: client,
        extractContext: () =>
          createServerContext({ server: { name: 'my-server' }, transport: 'stdio' }),
      },
      { name: 'search_docs' },
      async (_ctx: McpToolContext, _extra: McpExtra) => ok(),
    );

    await wrapped(mkExtra());

    expect(tracked).toHaveLength(0);
  });

  it('reads `extra` as the last argument (MCP SDK convention)', async () => {
    const { client } = makeAmplitude();
    let extractorSaw: McpExtra | undefined;
    const extractor: ContextExtractor = (extra) => {
      extractorSaw = extra;
      return createServerContext({
        server: { name: 'my-server' },
        transport: 'streamable-http',
        identity: { userId: 'u1', resolvedFrom: 'userId' },
      });
    };

    const wrapped = wrapTool(
      { amplitude: client, extractContext: extractor },
      { name: 'search_docs' },
      async (_ctx: McpToolContext, _args: { q: string }, _extra: McpExtra) => ok(),
    );

    const passedExtra = mkExtra({ sessionId: 'sess-abc' });
    await wrapped({ q: 'hi' }, passedExtra);
    expect(extractorSaw).toBe(passedExtra);
  });
});
