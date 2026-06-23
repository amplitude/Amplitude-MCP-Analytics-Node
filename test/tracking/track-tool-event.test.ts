import { describe, expect, it } from 'vitest';
import { createToolContext } from '../../src/context/index.js';
import { trackToolEvent } from '../../src/tracking/track-tool-event.js';
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

describe('trackToolEvent', () => {
  it('emits a tool-scope event with inherited server + tool properties', () => {
    const { client, tracked } = makeAmplitude();
    const ctx = createToolContext(
      {
        server: { name: 'my-server' },
        transport: 'streamable-http',
        identity: { userId: 'u1', resolvedFrom: 'userId' },
        tenant: { groupType: 'org id', groupValue: '36958' },
        anchor: { type: 'session-id', value: 'sess-1' },
      },
      {
        name: 'search_docs',
        owner: 'docs-team',
        tags: ['search'],
        category: 'retrieval',
      },
    );

    trackToolEvent(client, ctx, 'mcp: tool result rendered');

    expect(tracked).toHaveLength(1);
    const event = tracked[0]!;
    expect(event.event_type).toBe('mcp: tool result rendered');
    expect(event.user_id).toBe('u1');
    expect(event.groups).toEqual({ 'org id': '36958' });
    expect(event.event_properties).toMatchObject({
      // server-scope inherited
      '[MCP] Session ID': 'sess-1',
      'server name': 'my-server',
      // tool-scope added
      'tool name': 'search_docs',
      'tool owner': 'docs-team',
      'tool tags': ['search'],
      'tool category': 'retrieval',
    });
  });

  it('merges caller properties, which win over reserved on collision', () => {
    const { client, tracked } = makeAmplitude();
    const ctx = createToolContext(
      {
        server: { name: 'my-server' },
        transport: 'streamable-http',
        identity: { userId: 'u1', resolvedFrom: 'userId' },
      },
      { name: 'search_docs' },
    );

    trackToolEvent(client, ctx, 'mcp: tool query', {
      'query text': 'how to do X',
      // Collides with the reserved 'tool name' → caller wins.
      'tool name': 'overridden_name',
    });

    const event = tracked[0]!;
    expect(event.event_properties?.['query text']).toBe('how to do X');
    expect(event.event_properties?.['tool name']).toBe('overridden_name'); // caller wins
  });

  it("emits the tool's extra enrichment, and lets caller properties override it", () => {
    const { client, tracked } = makeAmplitude();
    const ctx = createToolContext(
      {
        server: { name: 'my-server' },
        transport: 'streamable-http',
        identity: { userId: 'u1', resolvedFrom: 'userId' },
      },
      { name: 'search_docs', extra: { 'org url': 'from-extra', region: 'us' } },
    );

    trackToolEvent(client, ctx, 'mcp: tool query', { 'org url': 'from-caller' });

    const event = tracked[0]!;
    expect(event.event_properties?.region).toBe('us'); // extra, no collision
    expect(event.event_properties?.['org url']).toBe('from-caller'); // caller overrides extra
  });

  it('drops emission under the identity/tenant skip rule (anonymous + no tenant)', () => {
    const { client, tracked } = makeAmplitude();
    const ctx = createToolContext(
      { server: { name: 'my-server' }, transport: 'stdio' },
      { name: 'search_docs' },
    );
    trackToolEvent(client, ctx, 'mcp: never emitted');

    expect(tracked).toHaveLength(0);
  });

  it('swallows underlying client errors (best-effort)', () => {
    const client: AmplitudeClientLike = {
      track: () => {
        throw new Error('amplitude broke');
      },
      flush: () => undefined,
    };
    const ctx = createToolContext(
      {
        server: { name: 'my-server' },
        transport: 'streamable-http',
        identity: { userId: 'u1', resolvedFrom: 'userId' },
      },
      { name: 'search_docs' },
    );

    expect(() => trackToolEvent(client, ctx, 'mcp: failing event')).not.toThrow();
  });
});
