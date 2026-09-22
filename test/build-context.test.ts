import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { describe, expect, it } from 'vitest';
import { createServerContext } from '../src/context/index.js';
import type { McpServerContext, McpTransport } from '../src/context/types.js';
import { buildToolContext, resolveTransport } from '../src/core/build-context.js';
import type { McpExtra } from '../src/core/mcp.js';

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

/** A server-scope ctx for the given transport, with optional overrides. */
function serverCtx(transport: McpTransport, overrides: Partial<McpServerContext> = {}): McpServerContext {
  return createServerContext({ server: { name: 'test-mcp', version: '9.9.9' }, transport, ...overrides });
}

/** Build the per-request tool ctx — exercises the resolvers private to build-context. */
function toolCtx(transport: McpTransport, extra: McpExtra, overrides?: Partial<McpServerContext>) {
  return buildToolContext(serverCtx(transport, overrides), { name: 'search_docs' }, extra);
}

describe('resolveTransport', () => {
  const stdioLike: Transport = { start: async () => {}, send: async () => {}, close: async () => {} };
  const httpLike = {
    start: async () => {},
    send: async () => {},
    close: async () => {},
    handleRequest: () => undefined,
  } as Transport & { handleRequest: () => void };

  it('classifies a Streamable HTTP transport structurally (handleRequest present)', () => {
    expect(resolveTransport(httpLike)).toBe('streamable-http');
  });

  it('classifies a transport without handleRequest as stdio (no session-id assumption)', () => {
    expect(resolveTransport(stdioLike)).toBe('stdio');
  });
});

describe('buildToolContext — anchor', () => {
  it('stdio → process anchor (process lifetime, stable)', () => {
    const anchor = toolCtx('stdio', mkExtra()).anchor;
    expect(anchor.type).toBe('process');
    expect(toolCtx('stdio', mkExtra()).anchor).toEqual(anchor);
    // The pid stays readable, but it is NOT the whole value: pids are recycled
    // per machine, so a bare pid collided across hosts (see processAnchorValue).
    expect(anchor.value).toMatch(new RegExp(`^${process.pid}-[0-9a-f]{32}$`));
    expect(anchor.value).not.toBe(String(process.pid));
  });

  it('legacy HTTP → session-id anchor when a session id is present', () => {
    const ctx = toolCtx('streamable-http', mkExtra({ sessionId: 'sess-abc123' }));
    expect(ctx.anchor).toEqual({ type: 'session-id', value: 'sess-abc123' });
  });

  it('stateless HTTP → trace anchor from traceparent in _meta (no session id)', () => {
    const ctx = toolCtx(
      'streamable-http',
      mkExtra({ _meta: { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' } }),
    );
    expect(ctx.anchor).toEqual({ type: 'trace', value: '4bf92f3577b34da6a3ce929d0e0e4736' });
  });

  it('stateless HTTP → anonymous per-request floor when neither session nor trace exists', () => {
    const first = toolCtx('streamable-http', mkExtra()).anchor;
    const second = toolCtx('streamable-http', mkExtra()).anchor;
    expect(first.type).toBe('anonymous');
    expect(first.value.length).toBeGreaterThanOrEqual(5); // valid synthetic id
    expect(first.value).not.toBe(second.value); // fresh per request, no stitching
  });

  it('ignores an empty session id and falls through to the stateless branch', () => {
    expect(toolCtx('streamable-http', mkExtra({ sessionId: '' })).anchor.type).toBe('anonymous');
  });

  it('falls back to the anonymous floor on a malformed/all-zero traceparent', () => {
    const malformed = toolCtx('streamable-http', mkExtra({ _meta: { traceparent: 'not-a-traceparent' } }));
    const allZero = toolCtx(
      'streamable-http',
      mkExtra({ _meta: { traceparent: '00-00000000000000000000000000000000-00f067aa0ba902b7-01' } }),
    );
    expect(malformed.anchor.type).toBe('anonymous');
    expect(allZero.anchor.type).toBe('anonymous');
  });
});

describe('buildToolContext — protocolVersion', () => {
  it('prefers the MCP-Protocol-Version header (case-insensitive)', () => {
    const ctx = toolCtx(
      'streamable-http',
      mkExtra({
        requestInfo: { headers: { 'MCP-Protocol-Version': '2025-11-25' } },
        _meta: { protocolVersion: '2026-07-28' },
      }),
    );
    expect(ctx.protocolVersion).toBe('2025-11-25');
  });

  it('falls back to _meta.protocolVersion (stateless path)', () => {
    const ctx = toolCtx('streamable-http', mkExtra({ _meta: { protocolVersion: '2026-07-28' } }));
    expect(ctx.protocolVersion).toBe('2026-07-28');
  });

  it('falls back to the server-scope version when the request carries none (e.g. stdio)', () => {
    const ctx = toolCtx('stdio', mkExtra(), { protocolVersion: '2025-11-25' });
    expect(ctx.protocolVersion).toBe('2025-11-25');
  });
});

describe('buildToolContext — client correlation', () => {
  it('reads conversation, run, and turn identifiers from stateless request _meta', () => {
    const ctx = toolCtx(
      'streamable-http',
      mkExtra({
        _meta: {
          conversation_id: 'conversation-123',
          run_id: 'run-456',
          turn_id: 'turn-7',
        },
      }),
    );

    expect(ctx.correlation).toEqual({
      conversationId: 'conversation-123',
      runId: 'run-456',
      turnId: 'turn-7',
      episodeAnchorType: 'conversation-id',
      episodeAnchorConfidence: 'high',
    });
    expect(ctx.anchor.type).toBe('anonymous');
  });

  it('normalizes job and numeric turn aliases and uses the run as the episode anchor', () => {
    const ctx = toolCtx(
      'streamable-http',
      mkExtra({ _meta: { jobId: 'job-456', turn_number: 8 } }),
    );

    expect(ctx.correlation).toEqual({
      runId: 'job-456',
      turnId: '8',
      episodeAnchorType: 'run-id',
      episodeAnchorConfidence: 'high',
    });
  });

  it('keeps legacy session semantics while reporting the best episode anchor', () => {
    const ctx = toolCtx(
      'streamable-http',
      mkExtra({
        sessionId: 'session-legacy',
        _meta: { conversationId: 'conversation-123' },
      }),
    );

    expect(ctx.anchor).toEqual({ type: 'session-id', value: 'session-legacy' });
    expect(ctx.correlation?.episodeAnchorType).toBe('conversation-id');
    expect(ctx.correlation?.episodeAnchorConfidence).toBe('high');
  });

  it('classifies trace and inferred fallbacks without fabricating identifiers', () => {
    const traced = toolCtx(
      'streamable-http',
      mkExtra({
        _meta: {
          traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        },
      }),
    );
    const inferred = toolCtx('streamable-http', mkExtra());

    expect(traced.correlation).toEqual({
      episodeAnchorType: 'trace',
      episodeAnchorConfidence: 'medium',
    });
    expect(inferred.correlation).toEqual({
      episodeAnchorType: 'inferred',
      episodeAnchorConfidence: 'low',
    });
  });
});

describe('buildToolContext — client info', () => {
  it('reads per-request clientInfo from _meta (wins over the handshake)', () => {
    const ctx = toolCtx(
      'streamable-http',
      mkExtra({ _meta: { clientInfo: { name: 'cursor', version: '1.2.3' } } }),
      { client: { name: 'stale', version: '0.0.0' } },
    );
    expect(ctx.client).toMatchObject({ name: 'cursor', version: '1.2.3' });
  });

  it('falls back to the server-scope handshake client when _meta has none', () => {
    const ctx = toolCtx('stdio', mkExtra(), { client: { name: 'claude', version: '3.0' } });
    expect(ctx.client).toMatchObject({ name: 'claude', version: '3.0' });
  });

  it('reads the User-Agent header (Streamable HTTP)', () => {
    const ctx = toolCtx('streamable-http', mkExtra({ requestInfo: { headers: { 'user-agent': 'cursor/1.2.3' } } }));
    expect(ctx.client?.userAgent).toBe('cursor/1.2.3');
  });
});
