import { describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createServerContext, getCurrentContext } from '../../src/context/index.js';
import type { McpServerContext, McpToolContext } from '../../src/context/types.js';
import type { McpExtra } from '../../src/core/mcp.js';
import { instrumentTool } from '../../src/tracking/instrument-tool.js';
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

/**
 * A bound server scope carrying a tenant, so the event is emitted (events with
 * neither an identity nor a tenant are dropped). Identity stays floored to
 * anonymous — `buildToolContext` floors it regardless of source.
 */
function boundCtx(overrides: Partial<McpServerContext> = {}): McpServerContext {
  return createServerContext({
    server: { name: 'my-server', version: '1.0.0' },
    transport: 'streamable-http',
    tenant: { groupType: 'org id', groupValue: '36958' },
    ...overrides,
  });
}

function mkDeps(
  client: AmplitudeClientLike,
  getServerCtx: () => McpServerContext | undefined,
) {
  return { amplitude: client, getServerCtx };
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

/** Legacy Streamable HTTP request: session id + per-request client info. */
const legacyExtra = mkExtra({
  sessionId: 'sess-abc123',
  requestInfo: { headers: { 'user-agent': 'cursor/1.2.3' } },
  _meta: { clientInfo: { name: 'cursor', version: '1.2.3' } },
});

const ok = (text = 'ok'): CallToolResult => ({ content: [{ type: 'text', text }] });

describe('instrumentTool', () => {
  it('wraps the native handler unchanged, runs it under ALS, exposes ctx via getCurrentContext()', async () => {
    const { client } = makeAmplitude();
    let received: unknown;
    let ctx: McpToolContext | undefined;

    const wrapped = instrumentTool(
      mkDeps(client, () => boundCtx()),
      async (args: { q: string }, _extra: McpExtra): Promise<CallToolResult> => {
        received = args; // native args pass through untouched
        ctx = getCurrentContext() as McpToolContext | undefined;
        return ok();
      },
      { name: 'search_docs', owner: 'docs-team' },
    );

    await wrapped({ q: 'hi' }, legacyExtra);

    expect(received).toEqual({ q: 'hi' });
    expect(ctx?.tool.name).toBe('search_docs');
    expect(ctx?.tool.owner).toBe('docs-team');
    expect(ctx?.tenant).toEqual({ groupType: 'org id', groupValue: '36958' });
  });

  it('resolves the per-request anchor + client info from `extra` (rich path)', async () => {
    const { client } = makeAmplitude();
    let ctx: McpToolContext | undefined;

    const wrapped = instrumentTool(
      mkDeps(client, () => boundCtx()),
      async (_extra: McpExtra) => {
        ctx = getCurrentContext() as McpToolContext | undefined;
        return ok();
      },
      { name: 'search_docs' },
    );

    await wrapped(legacyExtra);

    expect(ctx?.anchor).toEqual({ type: 'session-id', value: 'sess-abc123' });
    expect(ctx?.client?.name).toBe('cursor'); // per-request, from _meta.clientInfo
    expect(ctx?.transport).toBe('streamable-http'); // inherited from server scope
    expect(ctx?.identity.resolvedFrom).toBe('anonymous'); // identity resolution is a later track
  });

  it('emits a stub `mcp: tool call response` event with success status + duration', async () => {
    const { client, tracked } = makeAmplitude();
    const wrapped = instrumentTool(
      mkDeps(client, () => boundCtx()),
      async (_extra: McpExtra) => ok(),
      { name: 'search_docs' },
    );

    await wrapped(legacyExtra);

    const events = tracked.filter((e) => e.event_type === 'mcp: tool call response');
    expect(events).toHaveLength(1);
    expect(events[0]?.event_properties).toMatchObject({
      'tool call status': 'success',
      'tool name': 'search_docs',
    });
    expect(events[0]?.event_properties?.['tool call duration ms']).toEqual(expect.any(Number));
  });

  it('treats an `isError: true` result as a failure (MCP in-band error channel)', async () => {
    const { client, tracked } = makeAmplitude();
    let ctx: McpToolContext | undefined;
    const wrapped = instrumentTool(
      mkDeps(client, () => boundCtx()),
      async (_extra: McpExtra): Promise<CallToolResult> => {
        ctx = getCurrentContext() as McpToolContext | undefined;
        // Handler returns (does not throw) but signals failure in-band.
        return { content: [{ type: 'text', text: 'chart not found' }], isError: true };
      },
      { name: 'get_chart' },
    );

    const result = await wrapped(legacyExtra);

    // The result still flows back to the SDK untouched.
    expect(result).toMatchObject({ isError: true });
    const events = tracked.filter((e) => e.event_type === 'mcp: tool call response');
    expect(events).toHaveLength(1);
    expect(events[0]?.event_properties).toMatchObject({
      'tool call status': 'error',
      'tool name': 'get_chart',
      'error message': 'chart not found',
      'error type': 'returned_error',
    });
    expect(ctx?.error?.type).toBe('returned_error');
  });

  it('treats a synchronous `isError: true` result as a failure', () => {
    const { client, tracked } = makeAmplitude();
    const wrapped = instrumentTool(
      mkDeps(client, () => boundCtx()),
      (_extra: McpExtra): CallToolResult => ({
        content: [{ type: 'text', text: 'bad input' }],
        isError: true,
      }),
      { name: 'sync_returns_error' },
    );

    wrapped(legacyExtra);

    const events = tracked.filter((e) => e.event_type === 'mcp: tool call response');
    expect(events).toHaveLength(1);
    expect(events[0]?.event_properties).toMatchObject({
      'tool call status': 'error',
      'error message': 'bad input',
      'error type': 'returned_error',
    });
  });

  it('emits with an anonymous-floor anchor when there is no session id (stateless HTTP)', async () => {
    const { client, tracked } = makeAmplitude();
    let ctx: McpToolContext | undefined;
    const wrapped = instrumentTool(
      mkDeps(client, () => boundCtx()),
      async (_extra: McpExtra) => {
        ctx = getCurrentContext() as McpToolContext | undefined;
        return ok();
      },
      { name: 'search_docs' },
    );

    // No sessionId, no trace context → stateless anonymous floor.
    await wrapped(mkExtra());

    expect(ctx?.anchor.type).toBe('anonymous');
    // The session-id property falls back to its sentinel, and the event still emits
    // (the bound tenant keeps it above the skip rule).
    const events = tracked.filter((e) => e.event_type === 'mcp: tool call response');
    expect(events).toHaveLength(1);
    expect(events[0]?.event_properties?.['session id']).toBe('no-session');
    expect(events[0]?.event_properties?.['tool call status']).toBe('success');
  });

  it('anchors on the W3C trace id from _meta.traceparent when there is no session id', async () => {
    const { client, tracked } = makeAmplitude();
    let ctx: McpToolContext | undefined;
    const wrapped = instrumentTool(
      mkDeps(client, () => boundCtx()),
      async (_extra: McpExtra) => {
        ctx = getCurrentContext() as McpToolContext | undefined;
        return ok();
      },
      { name: 'search_docs' },
    );

    // Stateless HTTP: no sessionId, but trace context is propagated in _meta.
    // traceparent = version-traceid-parentid-flags (W3C).
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    await wrapped(
      mkExtra({ _meta: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` } }),
    );

    // The anchor (and ctx.traceId) come from the propagated trace, not a session.
    expect(ctx?.anchor).toEqual({ type: 'trace', value: traceId });
    expect(ctx?.traceId).toBe(traceId);

    const events = tracked.filter((e) => e.event_type === 'mcp: tool call response');
    expect(events).toHaveLength(1);
    expect(events[0]?.event_properties).toMatchObject({
      'anchor type': 'trace',
      'trace id': traceId,
      'session id': 'no-session',
      'tool call status': 'success',
    });
  });

  it('classifies onto ctx.error and emits a failure event when the handler throws', async () => {
    const { client, tracked } = makeAmplitude();
    let ctx: McpToolContext | undefined;
    const wrapped = instrumentTool(
      mkDeps(client, () => boundCtx()),
      async (_extra: McpExtra): Promise<CallToolResult> => {
        ctx = getCurrentContext() as McpToolContext | undefined;
        throw new Error('kaboom');
      },
      { name: 'boom' },
    );

    await expect(wrapped(legacyExtra)).rejects.toThrow('kaboom');

    const events = tracked.filter((e) => e.event_type === 'mcp: tool call response');
    expect(events).toHaveLength(1);
    expect(events[0]?.event_properties).toMatchObject({
      'tool call status': 'error',
      'tool name': 'boom',
      'error message': 'kaboom',
      // The event carries the *classified* type, same shape as a returned error.
      'error type': 'thrown_exception',
    });
    expect(ctx?.error?.type).toBe('thrown_exception');
  });

  it('preserves a synchronous handler shape (returns sync result, not a promise)', () => {
    const { client, tracked } = makeAmplitude();
    const wrapped = instrumentTool(
      mkDeps(client, () => boundCtx()),
      (_extra: McpExtra): CallToolResult => ok('sync'),
      { name: 'sync_tool' },
    );

    const result = wrapped(legacyExtra);
    expect(result).toEqual(ok('sync'));
    expect(tracked.filter((e) => e.event_type === 'mcp: tool call response')).toHaveLength(1);
  });

  it('handles synchronous throws by classifying + emitting failure + rethrowing', () => {
    const { client, tracked } = makeAmplitude();
    let ctx: McpToolContext | undefined;
    const wrapped = instrumentTool(
      mkDeps(client, () => boundCtx()),
      (_extra: McpExtra): CallToolResult => {
        ctx = getCurrentContext() as McpToolContext | undefined;
        throw new Error('sync boom');
      },
      { name: 'sync_throw' },
    );

    expect(() => wrapped(legacyExtra)).toThrow('sync boom');
    const events = tracked.filter((e) => e.event_type === 'mcp: tool call response');
    expect(events).toHaveLength(1);
    expect(events[0]?.event_properties?.['tool call status']).toBe('error');
    expect(ctx?.error?.type).toBe('thrown_exception');
  });

  it('builds a fresh ctx per invocation (no state bleed across concurrent calls)', async () => {
    const { client } = makeAmplitude();
    const seen: McpToolContext[] = [];

    const wrapped = instrumentTool(
      mkDeps(client, () => boundCtx()),
      async (_extra: McpExtra) => {
        seen.push(getCurrentContext() as McpToolContext);
        // Force ordering — both calls in flight before either resolves.
        await new Promise((r) => setTimeout(r, 5));
        return ok();
      },
      { name: 'search_docs' },
    );

    // Stateless HTTP (no session id) → a fresh anonymous-floor anchor per request.
    await Promise.all([wrapped(mkExtra()), wrapped(mkExtra())]);

    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen[0]?.anchor.value).not.toBe(seen[1]?.anchor.value);
  });

  it('reads `extra` as the last argument (MCP SDK convention)', async () => {
    const { client } = makeAmplitude();
    let ctx: McpToolContext | undefined;
    const wrapped = instrumentTool(
      mkDeps(client, () => boundCtx()),
      async (_args: { q: string }, _extra: McpExtra) => {
        ctx = getCurrentContext() as McpToolContext | undefined;
        return ok();
      },
      { name: 'search_docs' },
    );

    await wrapped({ q: 'hi' }, mkExtra({ sessionId: 'sess-xyz' }));
    // The anchor reflects the passed extra's session id — proving it was read.
    expect(ctx?.anchor).toEqual({ type: 'session-id', value: 'sess-xyz' });
  });

  describe('no server binding (instrumentServer not called)', () => {
    it('is a true no-op passthrough: handler runs untouched, no ctx, nothing emitted', async () => {
      const { client, tracked } = makeAmplitude();
      let received: unknown;
      let ambient: McpToolContext | undefined;
      const wrapped = instrumentTool(
        mkDeps(client, () => undefined),
        async (args: { q: string }, _extra: McpExtra) => {
          received = args;
          ambient = getCurrentContext() as McpToolContext | undefined;
          return ok();
        },
        { name: 'search_docs' },
      );

      const result = await wrapped({ q: 'hi' }, mkExtra());

      expect(result).toEqual(ok()); // tool ran and returned normally
      expect(received).toEqual({ q: 'hi' }); // native args pass through
      expect(ambient).toBeUndefined(); // no ambient context established
      expect(tracked).toHaveLength(0); // nothing emitted
    });

    it('warns once (per tool) that analytics is disabled', async () => {
      const warnings: string[] = [];
      const client: AmplitudeClientLike = {
        track: () => undefined,
        flush: () => undefined,
        configuration: {
          loggerProvider: {
            debug: () => undefined,
            error: () => undefined,
            info: () => undefined,
            warn: (m: string) => warnings.push(m),
          },
        },
      } as unknown as AmplitudeClientLike;

      const wrapped = instrumentTool(
        mkDeps(client, () => undefined),
        async (_extra: McpExtra) => ok(),
        { name: 'search_docs' },
      );

      await wrapped(mkExtra());
      await wrapped(mkExtra());

      expect(warnings).toHaveLength(1); // once, not per call
      expect(warnings[0]).toMatch(/instrumentTool\('search_docs'\) ran without instrumentServer/);
    });
  });
});
