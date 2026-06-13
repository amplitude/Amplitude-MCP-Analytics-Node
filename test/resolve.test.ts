import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { describe, expect, it } from 'vitest';
import type { McpExtra } from '../src/core/mcp.js';
import {
  parseTraceId,
  resolveAnchor,
  resolveProtocolVersion,
  resolveTransport,
} from '../src/core/resolve.js';

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

describe('resolveTransport', () => {
  const stdioLike: Transport = { start: async () => {}, send: async () => {}, close: async () => {} };
  const httpLike: Transport = {
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

describe('resolveProtocolVersion', () => {
  it('prefers the MCP-Protocol-Version header (case-insensitive)', () => {
    const extra = mkExtra({
      requestInfo: { headers: { 'MCP-Protocol-Version': '2025-11-25' } },
      _meta: { protocolVersion: '2026-07-28' },
    });
    expect(resolveProtocolVersion(extra)).toBe('2025-11-25');
  });

  it('falls back to _meta.protocolVersion (stateless path)', () => {
    const extra = mkExtra({ _meta: { protocolVersion: '2026-07-28' } });
    expect(resolveProtocolVersion(extra)).toBe('2026-07-28');
  });

  it('is undefined when neither header nor _meta carries it (e.g. stdio)', () => {
    expect(resolveProtocolVersion(mkExtra())).toBeUndefined();
  });
});

describe('parseTraceId', () => {
  it('extracts the 32-hex trace-id from a W3C traceparent', () => {
    const tp = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    expect(parseTraceId(tp)).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
  });

  it('rejects malformed, all-zero, and missing values', () => {
    expect(parseTraceId(undefined)).toBeUndefined();
    expect(parseTraceId('not-a-traceparent')).toBeUndefined();
    expect(parseTraceId('00-00000000000000000000000000000000-00f067aa0ba902b7-01')).toBeUndefined();
    expect(parseTraceId('00-tooshort-00f067aa0ba902b7-01')).toBeUndefined();
  });
});

describe('resolveAnchor', () => {
  it('stdio → process anchor (process lifetime, stable)', () => {
    expect(resolveAnchor('stdio', mkExtra())).toEqual({ type: 'process', value: String(process.pid) });
  });

  it('legacy HTTP → session-id anchor when a session id is present', () => {
    const anchor = resolveAnchor('streamable-http', mkExtra({ sessionId: 'sess-abc123' }));
    expect(anchor).toEqual({ type: 'session-id', value: 'sess-abc123' });
  });

  it('stateless HTTP → trace anchor from traceparent in _meta (no session id)', () => {
    const extra = mkExtra({
      _meta: { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' },
    });
    const anchor = resolveAnchor('streamable-http', extra);
    expect(anchor).toEqual({ type: 'trace', value: '4bf92f3577b34da6a3ce929d0e0e4736' });
  });

  it('stateless HTTP → anonymous per-request floor when neither session nor trace exists', () => {
    const first = resolveAnchor('streamable-http', mkExtra());
    const second = resolveAnchor('streamable-http', mkExtra());
    expect(first.type).toBe('anonymous');
    expect(first.value.length).toBeGreaterThanOrEqual(5); // valid synthetic id
    expect(first.value).not.toBe(second.value); // fresh per request, no stitching
  });

  it('ignores an empty session id and falls through to the stateless branch', () => {
    const anchor = resolveAnchor('streamable-http', mkExtra({ sessionId: '' }));
    expect(anchor.type).toBe('anonymous');
  });
});
