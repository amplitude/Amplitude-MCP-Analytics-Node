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
  return { amplitude: client, getServerCtx, trackToolCalls: true };
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
    expect(ctx?.identity.resolvedFrom).toBe('anchor');
  });

  it('emits the `[MCP] Tool Call Response` event with is-tool-error + duration on success', async () => {
    const { client, tracked } = makeAmplitude();
    const wrapped = instrumentTool(
      mkDeps(client, () => boundCtx()),
      async (_extra: McpExtra) => ok(),
      { name: 'search_docs' },
    );

    await wrapped(legacyExtra);

    const events = tracked.filter((e) => e.event_type === '[MCP] Tool Call Response');
    expect(events).toHaveLength(1);
    expect(events[0]?.event_properties).toMatchObject({
      '[MCP] Is Error': false,
      '[MCP] Tool Name': 'search_docs',
    });
    expect(events[0]?.event_properties?.['[MCP] Response Duration']).toEqual(expect.any(Number));
    // No error keys on a successful call.
    expect(events[0]?.event_properties).not.toHaveProperty('[MCP] Error Message');
    expect(events[0]?.event_properties).not.toHaveProperty('[MCP] Error Type');
  });

  it('skips the default event when trackToolCalls is false, but still runs under ctx', async () => {
    const { client, tracked } = makeAmplitude();
    let ctx: McpToolContext | undefined;
    const wrapped = instrumentTool(
      { ...mkDeps(client, () => boundCtx()), trackToolCalls: false },
      async (_extra: McpExtra) => {
        ctx = getCurrentContext() as McpToolContext | undefined;
        return ok();
      },
      { name: 'search_docs' },
    );

    await wrapped(legacyExtra);

    expect(tracked).toHaveLength(0); // no [MCP] Tool Call Response
    expect(ctx?.tool.name).toBe('search_docs'); // ctx still established for custom events
  });

  it('emits request/response size when computable, omits request size when no args', async () => {
    const { client, tracked } = makeAmplitude();

    // Handler with a schema → first positional arg is the request body.
    const withArgs = instrumentTool(
      mkDeps(client, () => boundCtx()),
      async (_args: { q: string }, _extra: McpExtra) => ok('result'),
      { name: 'with_args' },
    );
    await withArgs({ q: 'hello' }, legacyExtra);

    // Handler without a schema → only `extra`, so there is no request body.
    const noArgs = instrumentTool(
      mkDeps(client, () => boundCtx()),
      async (_extra: McpExtra) => ok('result'),
      { name: 'no_args' },
    );
    await noArgs(legacyExtra);

    const [withArgsEvent, noArgsEvent] = tracked.filter(
      (e) => e.event_type === '[MCP] Tool Call Response',
    );
    expect(withArgsEvent?.event_properties?.['[MCP] Request Size']).toEqual(expect.any(Number));
    expect(withArgsEvent?.event_properties?.['[MCP] Response Size']).toEqual(expect.any(Number));
    expect(noArgsEvent?.event_properties).not.toHaveProperty('[MCP] Request Size');
    expect(noArgsEvent?.event_properties?.['[MCP] Response Size']).toEqual(expect.any(Number));
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
    const events = tracked.filter((e) => e.event_type === '[MCP] Tool Call Response');
    expect(events).toHaveLength(1);
    expect(events[0]?.event_properties).toMatchObject({
      '[MCP] Is Error': true,
      '[MCP] Tool Name': 'get_chart',
      '[MCP] Error Message': 'chart not found',
      '[MCP] Error Type': 'returned_error',
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

    const events = tracked.filter((e) => e.event_type === '[MCP] Tool Call Response');
    expect(events).toHaveLength(1);
    expect(events[0]?.event_properties).toMatchObject({
      '[MCP] Is Error': true,
      '[MCP] Error Message': 'bad input',
      '[MCP] Error Type': 'returned_error',
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
    const events = tracked.filter((e) => e.event_type === '[MCP] Tool Call Response');
    expect(events).toHaveLength(1);
    expect(events[0]?.event_properties?.['[MCP] Session ID']).toBe('no-session');
    expect(events[0]?.event_properties?.['[MCP] Is Error']).toBe(false);
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

    // The anchor comes from the propagated trace, not a session.
    expect(ctx?.anchor).toEqual({ type: 'trace', value: traceId });

    const events = tracked.filter((e) => e.event_type === '[MCP] Tool Call Response');
    expect(events).toHaveLength(1);
    expect(events[0]?.event_properties).toMatchObject({
      '[MCP] Anchor Type': 'trace',
      '[MCP] Session ID': 'no-session',
      '[MCP] Is Error': false,
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

    const events = tracked.filter((e) => e.event_type === '[MCP] Tool Call Response');
    expect(events).toHaveLength(1);
    expect(events[0]?.event_properties).toMatchObject({
      '[MCP] Is Error': true,
      '[MCP] Tool Name': 'boom',
      '[MCP] Error Message': 'kaboom',
      // The event carries the *classified* type, same shape as a returned error.
      '[MCP] Error Type': 'thrown_exception',
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
    expect(tracked.filter((e) => e.event_type === '[MCP] Tool Call Response')).toHaveLength(1);
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
    const events = tracked.filter((e) => e.event_type === '[MCP] Tool Call Response');
    expect(events).toHaveLength(1);
    expect(events[0]?.event_properties?.['[MCP] Is Error']).toBe(true);
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

  describe('custom event fields (meta.extra)', () => {
    it('merges meta.extra into the default event', async () => {
      const { client, tracked } = makeAmplitude();
      const wrapped = instrumentTool(
        mkDeps(client, () => boundCtx()),
        async (_extra: McpExtra) => ok(),
        { name: 'search_docs', extra: { 'feature flag': 'new-ranker' } },
      );

      await wrapped(legacyExtra);

      const event = tracked.find((e) => e.event_type === '[MCP] Tool Call Response');
      expect(event?.event_properties).toMatchObject({
        'feature flag': 'new-ranker',
        '[MCP] Is Error': false,
      });
    });

    it('reads meta.extra at emit time, so a handler can enrich it before returning', async () => {
      const { client, tracked } = makeAmplitude();
      const wrapped = instrumentTool(
        mkDeps(client, () => boundCtx()),
        async (args: { q: string }, _extra: McpExtra) => {
          // Dynamic enrichment: mutate the tool-scope extra bag mid-call.
          const ctx = getCurrentContext() as McpToolContext;
          ctx.tool.extra = { ...ctx.tool.extra, query: args.q };
          return ok();
        },
        { name: 'search_docs' },
      );

      await wrapped({ q: 'climate' }, legacyExtra);

      const event = tracked.find((e) => e.event_type === '[MCP] Tool Call Response');
      expect(event?.event_properties?.query).toBe('climate');
    });

    it('reserved contract keys win over colliding meta.extra keys (parity guard)', async () => {
      const { client, tracked } = makeAmplitude();
      const wrapped = instrumentTool(
        mkDeps(client, () => boundCtx()),
        async (_extra: McpExtra) => ok(),
        { name: 'search_docs', extra: { '[MCP] Is Error': 'definitely not a boolean' } },
      );

      await wrapped(legacyExtra);

      const event = tracked.find((e) => e.event_type === '[MCP] Tool Call Response');
      // The canonical outcome value wins; the custom collision is discarded.
      expect(event?.event_properties?.['[MCP] Is Error']).toBe(false);
    });

    it('forwards meta.extra values faithfully (no escaping/redaction in this layer)', async () => {
      const { client, tracked } = makeAmplitude();
      const wrapped = instrumentTool(
        mkDeps(client, () => boundCtx()),
        async (args: { q: string }, _extra: McpExtra) => {
          const ctx = getCurrentContext() as McpToolContext;
          ctx.tool.extra = { 'echoed query': args.q };
          return ok();
        },
        { name: 'search_docs' },
      );

      // Values pass through verbatim — output encoding is the renderer's job and
      // value sanitization belongs at the serialize-and-send boundary, not here.
      await wrapped({ q: '<script>alert(1)</script>' }, legacyExtra);

      const event = tracked.find((e) => e.event_type === '[MCP] Tool Call Response');
      expect(event?.event_properties?.['echoed query']).toBe('<script>alert(1)</script>');
    });
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
