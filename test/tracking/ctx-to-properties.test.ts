import { describe, expect, it } from 'vitest';
import { createServerContext, createToolContext } from '../../src/context/index.js';
import {
  ctxToAmplitudeFields,
  ctxToAmplitudeFieldsForTool,
  reservedFieldsToProperties,
  shouldEmit,
} from '../../src/tracking/ctx-to-properties.js';

describe('ctxToAmplitudeFields', () => {
  it('floors the cross-cutting fields when ctx is built from the anonymous floor', () => {
    const ctx = createServerContext({ server: { name: 'my-server' }, transport: 'stdio' });
    const { event_properties: fields, user_id, device_id, groups } = ctxToAmplitudeFields(ctx);

    expect(fields).toMatchObject({
      sessionId: 'no-session',
      clientName: 'unknown',
      userAgent: 'unknown',
      serverName: 'my-server',
      transport: 'stdio',
      anchorType: 'anonymous',
    });
    expect(user_id).toBeUndefined();
    expect(device_id).toBeUndefined();
    expect(groups).toBeUndefined();
  });

  it('promotes user/device identity onto top-level fields', () => {
    const ctx = createServerContext({
      server: { name: 'my-server' },
      transport: 'streamable-http',
      identity: { userId: 'u1', deviceId: 'd9', resolvedFrom: 'explicit' },
    });
    const mapped = ctxToAmplitudeFields(ctx);

    expect(mapped.user_id).toBe('u1');
    expect(mapped.device_id).toBe('d9');
  });

  it('maps tenant to groups', () => {
    const ctx = createServerContext({
      server: { name: 'my-server' },
      transport: 'streamable-http',
      tenant: { groupType: 'org id', groupValue: '36958' },
      identity: { userId: 'u1', resolvedFrom: 'explicit' },
    });
    const mapped = ctxToAmplitudeFields(ctx);

    expect(mapped.groups).toEqual({ 'org id': '36958' });
  });

  it('sets sessionId only when anchor.type === session-id', () => {
    const sessionful = ctxToAmplitudeFields(
      createServerContext({
        server: { name: 'my-server' },
        transport: 'streamable-http',
        anchor: { type: 'session-id', value: 'sess-abc' },
        identity: { userId: 'u1', resolvedFrom: 'explicit' },
      }),
    ).event_properties;
    expect(sessionful.sessionId).toBe('sess-abc');
    expect(sessionful.anchorType).toBe('session-id');

    const traced = ctxToAmplitudeFields(
      createServerContext({
        server: { name: 'my-server' },
        transport: 'streamable-http',
        anchor: { type: 'trace', value: 'trace-xyz' },
        identity: { userId: 'u1', resolvedFrom: 'explicit' },
      }),
    ).event_properties;
    expect(traced.sessionId).toBe('no-session');
    expect(traced.anchorType).toBe('trace');
  });

  it('sets client and server identity fields when present', () => {
    const ctx = createServerContext({
      server: { name: 'my-server', version: '1.2.3', type: 'remote' },
      transport: 'streamable-http',
      protocolVersion: '2026-07-28',
      authType: 'OAuth',
      client: { name: 'cursor', version: '0.42', userAgent: 'cursor/0.42 (mac)' },
    });
    const { event_properties: fields } = ctxToAmplitudeFields(ctx);

    expect(fields).toMatchObject({
      clientName: 'cursor',
      clientVersion: '0.42',
      userAgent: 'cursor/0.42 (mac)',
      serverName: 'my-server',
      serverVersion: '1.2.3',
      serverType: 'remote',
      protocolVersion: '2026-07-28',
      authType: 'OAuth',
    });
  });

  it('puts ctx.extra in the separate extraProperties layer, not event_properties', () => {
    const ctx = createServerContext({
      server: { name: 'my-server' },
      transport: 'streamable-http',
      extra: { 'org url': 'amplitude', 'user email': 'a@b.com' },
    });
    const mapped = ctxToAmplitudeFields(ctx);

    expect(mapped.extraProperties).toEqual({ 'org url': 'amplitude', 'user email': 'a@b.com' });
    expect('org url' in mapped.event_properties).toBe(false);
  });

  it('omits client and server versions when unset', () => {
    const { event_properties: fields } = ctxToAmplitudeFields(
      createServerContext({
        server: { name: 'my-server' },
        transport: 'stdio',
        identity: { userId: 'u1', resolvedFrom: 'explicit' },
      }),
    );

    expect('clientVersion' in fields).toBe(false);
    expect('serverVersion' in fields).toBe(false);
    expect('protocolVersion' in fields).toBe(false);
    expect('authType' in fields).toBe(false);
  });
});

describe('ctxToAmplitudeFieldsForTool', () => {
  it('extends server fields with toolName', () => {
    const ctx = createToolContext(
      { server: { name: 'my-server' }, transport: 'stdio' },
      { name: 'search_docs' },
    );
    expect(ctxToAmplitudeFieldsForTool(ctx).event_properties.toolName).toBe('search_docs');
  });

  it('promotes tool owner / tags / category', () => {
    const ctx = createToolContext(
      { server: { name: 'my-server' }, transport: 'streamable-http' },
      {
        name: 'search_docs',
        owner: 'docs-team',
        tags: ['search', 'rag'],
        category: 'retrieval',
      },
    );
    const { event_properties: fields } = ctxToAmplitudeFieldsForTool(ctx);

    expect(fields.toolOwner).toBe('docs-team');
    expect(fields.toolTags).toEqual(['search', 'rag']);
    expect(fields.toolCategory).toBe('retrieval');
  });

  it('omits tool tags when empty', () => {
    const ctx = createToolContext(
      { server: { name: 'my-server' }, transport: 'stdio' },
      { name: 'search_docs', tags: [] },
    );
    expect('toolTags' in ctxToAmplitudeFieldsForTool(ctx).event_properties).toBe(false);
  });

  it('resolves the tool extra bag into extraProperties, layered over server extra', () => {
    const ctx = createToolContext(
      {
        server: { name: 'my-server' },
        transport: 'streamable-http',
        extra: { 'org url': 'server-level', region: 'us' },
      },
      { name: 'search_docs', extra: { 'org url': 'tool-level', team: 'docs' } },
    );
    const mapped = ctxToAmplitudeFieldsForTool(ctx);

    expect(mapped.extraProperties).toEqual({
      'org url': 'tool-level',
      region: 'us',
      team: 'docs',
    });
  });

  it('inherits server-scope fields unchanged', () => {
    const ctx = createToolContext(
      {
        server: { name: 'my-server' },
        transport: 'streamable-http',
        tenant: { groupType: 'org id', groupValue: '36958' },
        identity: { userId: 'u1', resolvedFrom: 'explicit' },
        anchor: { type: 'session-id', value: 'sess-1' },
      },
      { name: 'search_docs' },
    );
    const mapped = ctxToAmplitudeFieldsForTool(ctx);

    expect(mapped.user_id).toBe('u1');
    expect(mapped.groups).toEqual({ 'org id': '36958' });
    expect(mapped.event_properties.sessionId).toBe('sess-1');
  });

  it('promotes the request-scope rationale and response HTTP status', () => {
    const ctx = createToolContext(
      { server: { name: 'my-server' }, transport: 'streamable-http' },
      { name: 'search_docs' },
      {
        request: {
          method: 'tools/call',
          rationale: 'need ids first',
          responseHttpStatus: 400,
        },
      },
    );
    const { event_properties: fields } = ctxToAmplitudeFieldsForTool(ctx);

    expect(fields.rationale).toBe('need ids first');
    expect(fields.responseHttpStatus).toBe(400);

    const props = reservedFieldsToProperties(fields);
    expect(props['[MCP] Rationale']).toBe('need ids first');
    expect(props['[MCP] Response HTTP Status']).toBe(400);
  });

  it('omits rationale and response HTTP status when unset', () => {
    const ctx = createToolContext(
      { server: { name: 'my-server' }, transport: 'stdio' },
      { name: 'search_docs' },
    );
    const { event_properties: fields } = ctxToAmplitudeFieldsForTool(ctx);

    expect('rationale' in fields).toBe(false);
    expect('responseHttpStatus' in fields).toBe(false);
  });
});

describe('reservedFieldsToProperties', () => {
  it('converts camelCase fields to wire property names', () => {
    const ctx = createToolContext(
      {
        server: { name: 'my-server', version: '1.0.0' },
        transport: 'streamable-http',
        tenant: { groupType: 'org id', groupValue: '36958' },
        anchor: { type: 'session-id', value: 'sess-1' },
      },
      { name: 'search_docs', owner: 'docs-team' },
    );
    const props = reservedFieldsToProperties(ctxToAmplitudeFieldsForTool(ctx).event_properties);

    expect(props).toMatchObject({
      '[MCP] Session ID': 'sess-1',
      '[MCP] Server Name': 'my-server',
      '[MCP] Server Version': '1.0.0',
      '[MCP] Transport': 'streamable-http',
      '[MCP] Anchor Type': 'session-id',
      '[MCP] Tool Name': 'search_docs',
      '[MCP] Tool Owner': 'docs-team',
    });
    // No camelCase keys leak onto the wire payload.
    expect('sessionId' in props).toBe(false);
  });
});

describe('shouldEmit (identity/tenant skip rule)', () => {
  it('drops events when identity is anonymous AND no tenant is set', () => {
    const ctx = createServerContext({ server: { name: 'my-server' }, transport: 'stdio' });
    expect(shouldEmit(ctx)).toBe(false);
  });

  it('emits when identity is resolved, even without tenant', () => {
    const ctx = createServerContext({
      server: { name: 'my-server' },
      transport: 'stdio',
      identity: { userId: 'u1', resolvedFrom: 'explicit' },
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
