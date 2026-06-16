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
        projectId: '67890',
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
      'session id': 'sess-1',
      'server name': 'my-server',
      // tool-scope added
      'tool name': 'search_docs',
      'tool owner': 'docs-team',
      'tool tags': ['search'],
      'tool category': 'retrieval',
      'project id': '67890',
    });
  });

  it('merges caller-supplied properties with caller-wins precedence', () => {
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
      // Override tool name — caller wins (uncommon but supported).
      'tool name': 'overridden_name',
    });

    const event = tracked[0]!;
    expect(event.event_properties?.['query text']).toBe('how to do X');
    expect(event.event_properties?.['tool name']).toBe('overridden_name');
  });

  it('drops emission under audit §2 skip rule (anonymous + no tenant)', () => {
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
