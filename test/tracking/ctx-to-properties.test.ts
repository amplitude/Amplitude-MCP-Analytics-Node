import { describe, expect, it } from 'vitest';
import { createServerContext, createToolContext } from '../../src/context/index.js';
import {
  ctxToAmplitudeFields,
  ctxToAmplitudeFieldsForTool,
  shouldEmit,
} from '../../src/tracking/ctx-to-properties.js';

describe('ctxToAmplitudeFields', () => {
  it('floors the cross-cutting fields when ctx is built from the anonymous floor', () => {
    const ctx = createServerContext({
      server: { name: 'my-server' },
      transport: 'stdio',
    });
    const fields = ctxToAmplitudeFields(ctx);

    expect(fields.event_properties).toMatchObject({
      'session id': 'no-session',
      'trace id': 'no-trace-id',
      'client name': 'unknown',
      'user agent': 'unknown',
      'server name': 'my-server',
      transport: 'stdio',
      'identity resolved from': 'anonymous',
      'anchor type': 'anonymous',
    });
    expect(fields.user_id).toBeUndefined();
    expect(fields.device_id).toBeUndefined();
    expect(fields.groups).toBeUndefined();
  });

  it('promotes user/device identity onto top-level fields', () => {
    const ctx = createServerContext({
      server: { name: 'my-server' },
      transport: 'streamable-http',
      identity: { userId: 'u1', deviceId: 'd9', resolvedFrom: 'userId' },
    });
    const fields = ctxToAmplitudeFields(ctx);

    expect(fields.user_id).toBe('u1');
    expect(fields.device_id).toBe('d9');
    expect(fields.event_properties['identity resolved from']).toBe('userId');
  });

  it('maps tenant to groups and mirrors the group on event_properties', () => {
    const ctx = createServerContext({
      server: { name: 'my-server' },
      transport: 'streamable-http',
      tenant: { groupType: 'org id', groupValue: '36958' },
      identity: { userId: 'u1', resolvedFrom: 'userId' },
    });
    const fields = ctxToAmplitudeFields(ctx);

    expect(fields.groups).toEqual({ 'org id': '36958' });
    expect(fields.event_properties['org id']).toBe('36958');
  });

  it('maps anchor to session id only when anchor.type === session-id', () => {
    const sessionful = ctxToAmplitudeFields(
      createServerContext({
        server: { name: 'my-server' },
        transport: 'streamable-http',
        anchor: { type: 'session-id', value: 'sess-abc' },
        identity: { userId: 'u1', resolvedFrom: 'userId' },
      }),
    );
    expect(sessionful.event_properties['session id']).toBe('sess-abc');
    expect(sessionful.event_properties['anchor type']).toBe('session-id');

    const traced = ctxToAmplitudeFields(
      createServerContext({
        server: { name: 'my-server' },
        transport: 'streamable-http',
        anchor: { type: 'trace', value: 'trace-xyz' },
        identity: { userId: 'u1', resolvedFrom: 'userId' },
      }),
    );
    expect(traced.event_properties['session id']).toBe('no-session');
    expect(traced.event_properties['anchor type']).toBe('trace');
  });

  it('emits trace id when present, sentinel otherwise', () => {
    const withTrace = ctxToAmplitudeFields(
      createServerContext({
        server: { name: 'my-server' },
        transport: 'streamable-http',
        traceId: 'abc-123',
      }),
    );
    expect(withTrace.event_properties['trace id']).toBe('abc-123');

    const withoutTrace = ctxToAmplitudeFields(
      createServerContext({ server: { name: 'my-server' }, transport: 'stdio' }),
    );
    expect(withoutTrace.event_properties['trace id']).toBe('no-trace-id');
  });

  it('emits client and server identity properties when present', () => {
    const ctx = createServerContext({
      server: { name: 'my-server', version: '1.2.3', type: 'remote' },
      transport: 'streamable-http',
      protocolVersion: '2026-07-28',
      authType: 'OAuth',
      client: { name: 'cursor', version: '0.42', userAgent: 'cursor/0.42 (mac)' },
    });
    const fields = ctxToAmplitudeFields(ctx);

    expect(fields.event_properties).toMatchObject({
      'client name': 'cursor',
      'client version': '0.42',
      'user agent': 'cursor/0.42 (mac)',
      'server name': 'my-server',
      'server version': '1.2.3',
      'server type': 'remote',
      'protocol version': '2026-07-28',
      'auth type': 'OAuth',
    });
  });

  it('spreads ctx.extra onto event_properties (host-domain enrichment like org url)', () => {
    const ctx = createServerContext({
      server: { name: 'my-server' },
      transport: 'streamable-http',
      extra: { 'org url': 'amplitude', 'user email': 'a@b.com' },
    });
    const fields = ctxToAmplitudeFields(ctx);

    expect(fields.event_properties['org url']).toBe('amplitude');
    expect(fields.event_properties['user email']).toBe('a@b.com');
  });

  it('omits client and server versions when unset (no `undefined` values on payload)', () => {
    const ctx = createServerContext({
      server: { name: 'my-server' },
      transport: 'stdio',
      identity: { userId: 'u1', resolvedFrom: 'userId' },
    });
    const fields = ctxToAmplitudeFields(ctx);

    expect('client version' in fields.event_properties).toBe(false);
    expect('server version' in fields.event_properties).toBe(false);
    expect('protocol version' in fields.event_properties).toBe(false);
    expect('auth type' in fields.event_properties).toBe(false);
  });
});

describe('ctxToAmplitudeFieldsForTool', () => {
  it('extends server fields with tool name', () => {
    const ctx = createToolContext(
      { server: { name: 'my-server' }, transport: 'stdio' },
      { name: 'search_docs' },
    );
    const fields = ctxToAmplitudeFieldsForTool(ctx);

    expect(fields.event_properties['tool name']).toBe('search_docs');
  });

  it('promotes tool owner / tags / category / project id / project name via free-form access', () => {
    const ctx = createToolContext(
      { server: { name: 'my-server' }, transport: 'streamable-http' },
      {
        name: 'search_docs',
        owner: 'docs-team',
        tags: ['search', 'rag'],
        category: 'retrieval',
        projectId: '67890',
        projectName: 'Docs',
      },
    );
    const fields = ctxToAmplitudeFieldsForTool(ctx);

    expect(fields.event_properties['tool owner']).toBe('docs-team');
    expect(fields.event_properties['tool tags']).toEqual(['search', 'rag']);
    expect(fields.event_properties['tool category']).toBe('retrieval');
    expect(fields.event_properties['project id']).toBe('67890');
    expect(fields.event_properties['project name']).toBe('Docs');
  });

  it('omits tool tags when empty (no empty-array noise on payload)', () => {
    const ctx = createToolContext(
      { server: { name: 'my-server' }, transport: 'stdio' },
      { name: 'search_docs', tags: [] },
    );
    const fields = ctxToAmplitudeFieldsForTool(ctx);

    expect('tool tags' in fields.event_properties).toBe(false);
  });

  it('emits request method when present', () => {
    const ctx = createToolContext(
      { server: { name: 'my-server' }, transport: 'stdio' },
      { name: 'search_docs' },
      { request: { method: 'tools/call' } },
    );
    const fields = ctxToAmplitudeFieldsForTool(ctx);

    expect(fields.event_properties['request method']).toBe('tools/call');
  });

  it('inherits server-scope cross-cutting properties unchanged', () => {
    const ctx = createToolContext(
      {
        server: { name: 'my-server' },
        transport: 'streamable-http',
        tenant: { groupType: 'org id', groupValue: '36958' },
        identity: { userId: 'u1', resolvedFrom: 'userId' },
        anchor: { type: 'session-id', value: 'sess-1' },
      },
      { name: 'search_docs' },
    );
    const fields = ctxToAmplitudeFieldsForTool(ctx);

    expect(fields.user_id).toBe('u1');
    expect(fields.groups).toEqual({ 'org id': '36958' });
    expect(fields.event_properties['session id']).toBe('sess-1');
    expect(fields.event_properties['org id']).toBe('36958');
  });
});

describe('shouldEmit (audit §2 skip rule)', () => {
  it('drops events when identity is anonymous AND no tenant is set', () => {
    const ctx = createServerContext({ server: { name: 'my-server' }, transport: 'stdio' });
    expect(shouldEmit(ctx)).toBe(false);
  });

  it('emits when identity is resolved, even without tenant', () => {
    const ctx = createServerContext({
      server: { name: 'my-server' },
      transport: 'stdio',
      identity: { userId: 'u1', resolvedFrom: 'userId' },
    });
    expect(shouldEmit(ctx)).toBe(true);
  });

  it('emits when tenant is set, even with anonymous identity', () => {
    const ctx = createServerContext({
      server: { name: 'my-server' },
      transport: 'stdio',
      tenant: { groupType: 'org id', groupValue: '36958' },
    });
    expect(shouldEmit(ctx)).toBe(true);
  });
});
