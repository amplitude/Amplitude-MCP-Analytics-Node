import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { readRequest } from '../src/core/mcp.js';

describe('readRequest — v1 extra', () => {
  it('reads every v1 field', () => {
    const headers = { 'MCP-Protocol-Version': ['2025-11-25', 'ignored'], 'User-Agent': 'cursor/1' };
    const request = readRequest({
      _meta: { clientInfo: { name: 'cursor' }, traceparent: '00-abc' },
      sessionId: 'sess-1',
      requestId: 4,
      authInfo: { clientId: 'oauth-1' },
      requestInfo: { headers },
    });

    expect(request.meta).toEqual({ clientInfo: { name: 'cursor' }, traceparent: '00-abc' });
    expect(request.envelope).toBeUndefined();
    expect(request.sessionId).toBe('sess-1');
    expect(request.requestId).toBe(4);
    expect(request.authInfo).toEqual({ clientId: 'oauth-1' });
    expect(request.headers).toBe(headers);
    expect(request.isHttp).toBe(true);
    expect(request.header('mcp-protocol-version')).toBe('2025-11-25');
    expect(request.header('user-agent')).toBe('cursor/1');
    expect(request.header('missing')).toBeUndefined();
  });

  it('keeps an empty protocol-version header instead of falling through', () => {
    const request = readRequest({
      requestInfo: { headers: { 'MCP-Protocol-Version': '' } },
      _meta: { protocolVersion: 'from-meta' },
    });
    expect(request.header('mcp-protocol-version')).toBe('');
  });

  it('drops an empty or non-string session id and a non-finite request id', () => {
    expect(readRequest({ sessionId: '' }).sessionId).toBeUndefined();
    expect(readRequest({ sessionId: 12 }).sessionId).toBeUndefined();
    expect(readRequest({ requestId: Number.NaN }).requestId).toBeUndefined();
    expect(readRequest({ requestId: 0 }).requestId).toBe(0);
  });

  it('is not HTTP without requestInfo', () => {
    const request = readRequest({ sessionId: 'stdio-session' });
    expect(request.isHttp).toBe(false);
    expect(request.headers).toBeUndefined();
    expect(request.header('user-agent')).toBeUndefined();
  });
});

describe('readRequest — v2 ctx', () => {
  it('reads every v2 field and ignores the v1 locations', () => {
    const headers = new Headers({ 'MCP-Protocol-Version': '2026-07-28' });
    const request = readRequest({
      requestId: 'v1-id',
      authInfo: { clientId: 'v1-client' },
      _meta: { clientInfo: { name: 'not-here' } },
      sessionId: 'sess-v2',
      mcpReq: {
        id: 'v2-id',
        _meta: { conversation_id: 'conv-1' },
        envelope: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
      },
      http: {
        authInfo: { clientId: 'v2-client', token: 't', scopes: [] },
        req: { headers },
      },
    });

    expect(request.meta).toEqual({ conversation_id: 'conv-1' });
    expect(request.envelope).toEqual({ 'io.modelcontextprotocol/protocolVersion': '2026-07-28' });
    expect(request.sessionId).toBe('sess-v2');
    expect(request.requestId).toBe('v2-id');
    expect(request.authInfo).toMatchObject({ clientId: 'v2-client' });
    expect(request.headers).toEqual({ 'mcp-protocol-version': '2026-07-28' });
    expect(request.isHttp).toBe(true);
    expect(request.header('Mcp-Protocol-Version')).toBe('2026-07-28');
  });

  it('is not HTTP when ctx.http is absent', () => {
    const request = readRequest({ mcpReq: { id: 1 }, http: undefined });
    expect(request.isHttp).toBe(false);
    expect(request.requestId).toBe(1);
    expect(request.envelope).toBeUndefined();
  });
});

describe('readRequest — hostile input', () => {
  it('returns an empty request for a non-object', () => {
    for (const value of [undefined, null, 0, 'extra', true]) {
      const request = readRequest(value);
      expect(request.sessionId).toBeUndefined();
      expect(request.requestId).toBeUndefined();
      expect(request.isHttp).toBe(false);
      expect(request.header('user-agent')).toBeUndefined();
    }
  });

  it('does not throw when a field getter throws', () => {
    const extra: Record<string, unknown> = {};
    Object.defineProperty(extra, 'mcpReq', {
      get() {
        throw new Error('mcpReq');
      },
    });
    Object.defineProperty(extra, 'sessionId', {
      get() {
        throw new Error('sessionId');
      },
    });
    expect(() => readRequest(extra)).not.toThrow();
    expect(readRequest(extra).sessionId).toBeUndefined();
  });

  it('never throws, and sessionId is a non-empty string or absent', () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        const request = readRequest(value);
        expect(request.sessionId === undefined || typeof request.sessionId === 'string').toBe(true);
        if (request.sessionId != null) expect(request.sessionId.length).toBeGreaterThan(0);
        expect(
          request.requestId === undefined ||
            typeof request.requestId === 'string' ||
            (typeof request.requestId === 'number' && Number.isFinite(request.requestId)),
        ).toBe(true);
        expect(typeof request.isHttp).toBe('boolean');
        const header = request.header('x-anything');
        expect(header === undefined || typeof header === 'string').toBe(true);
        expect(() => request.header('not-a-name')).not.toThrow();
      }),
      { numRuns: 100 },
    );
  });
});
