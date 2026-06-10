import { describe, expect, it } from 'vitest';
import {
  createServerContext,
  createToolContext,
} from '../src/context/index.js';
import type { McpServerContext } from '../src/context/index.js';

describe('createServerContext', () => {
  it('fills the always-emit floor when only server is given', () => {
    const ctx = createServerContext({ server: { name: 'my-server' } });

    expect(ctx.identity).toEqual({ resolvedFrom: 'anonymous' });
    expect(ctx.anchor).toEqual({ type: 'anonymous', value: '' });
    expect(ctx.transport).toBe('stdio');
    expect(ctx.server).toEqual({ name: 'my-server' });
  });

  it('keeps caller-supplied values (caller > derived)', () => {
    const ctx = createServerContext({
      server: { name: 'my-server', version: '1.0.0', type: 'remote' },
      identity: { userId: 'u1', resolvedFrom: 'userId' },
      anchor: { type: 'session-id', value: 'sess-1' },
      transport: 'streamable-http',
      protocolVersion: '2026-07-28',
      tenant: { groupType: 'org id', groupValue: '36958' },
      client: { name: 'cursor', version: '0.42', userAgent: 'cursor/0.42' },
    });

    expect(ctx.identity).toEqual({ userId: 'u1', resolvedFrom: 'userId' });
    expect(ctx.anchor).toEqual({ type: 'session-id', value: 'sess-1' });
    expect(ctx.transport).toBe('streamable-http');
    expect(ctx.protocolVersion).toBe('2026-07-28');
    expect(ctx.tenant).toEqual({ groupType: 'org id', groupValue: '36958' });
    expect(ctx.client?.name).toBe('cursor');
  });

  it('fills only the fields the caller left unset', () => {
    // anchor supplied, identity/transport defaulted to the floor
    const ctx = createServerContext({
      server: { name: 'my-server' },
      anchor: { type: 'trace', value: 'trace-abc' },
    });

    expect(ctx.anchor).toEqual({ type: 'trace', value: 'trace-abc' });
    expect(ctx.identity).toEqual({ resolvedFrom: 'anonymous' });
    expect(ctx.transport).toBe('stdio');
  });
});

describe('createToolContext', () => {
  it('extends an existing resolved server context with tool metadata', () => {
    const server = createServerContext({
      server: { name: 'my-server' },
      identity: { userId: 'u1', resolvedFrom: 'userId' },
      transport: 'streamable-http',
    });
    const ctx = createToolContext(server, {
      name: 'search_docs',
      owner: 'docs-team',
    });

    expect(ctx.tool.name).toBe('search_docs');
    expect(ctx.tool.owner).toBe('docs-team');
    // server-scope fields carry through unchanged
    expect(ctx.server.name).toBe('my-server');
    expect(ctx.identity).toEqual({ userId: 'u1', resolvedFrom: 'userId' });
    expect(ctx.transport).toBe('streamable-http');
  });

  it('builds both scopes at once from inline server input', () => {
    const ctx = createToolContext(
      { server: { name: 'my-server' }, transport: 'streamable-http' },
      { name: 'search_docs' },
      { request: { method: 'tools/call', sizeBytes: 128 } },
    );

    // inline input was resolved through the floor (identity/anchor defaulted)
    expect(ctx.identity).toEqual({ resolvedFrom: 'anonymous' });
    expect(ctx.anchor).toEqual({ type: 'anonymous', value: '' });
    expect(ctx.transport).toBe('streamable-http');
    expect(ctx.tool.name).toBe('search_docs');
    expect(ctx.request).toEqual({ method: 'tools/call', sizeBytes: 128 });
  });

  it('does not re-default a fully resolved base context', () => {
    const server = createServerContext({
      server: { name: 'my-server' },
      anchor: { type: 'process', value: '4242' },
      transport: 'stdio',
    });
    const ctx = createToolContext(server, { name: 't' });

    // the resolved anchor is preserved, not overwritten with the floor
    expect(ctx.anchor).toEqual({ type: 'process', value: '4242' });
  });

  it('leaves request and error unset when no extra is provided', () => {
    const ctx = createToolContext(
      { server: { name: 'my-server' } },
      { name: 'search_docs' },
    );

    expect(ctx.request).toBeUndefined();
    expect(ctx.error).toBeUndefined();
  });

  it('attaches a structured error when provided', () => {
    const ctx = createToolContext(
      { server: { name: 'my-server' } },
      { name: 'search_docs' },
      { error: { message: 'boom', type: 'internal' } },
    );

    expect(ctx.error).toEqual({ message: 'boom', type: 'internal' });
  });

  it('produces a tool context assignable to its server-scope base', () => {
    // McpToolContext extends McpServerContext — a tool ctx is usable
    // anywhere the shared server context is expected.
    const ctx = createToolContext(
      { server: { name: 'my-server' } },
      { name: 'search_docs' },
    );
    const asServer: McpServerContext = ctx;

    expect(asServer.server.name).toBe('my-server');
  });
});
