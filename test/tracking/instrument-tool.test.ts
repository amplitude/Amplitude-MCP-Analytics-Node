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
      'error type': 'Error',
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
