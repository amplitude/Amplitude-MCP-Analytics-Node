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
        identity: { userId: 'u1', resolvedFrom: 'explicit' },
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
    const event = tracked[0];
    expect(event?.event_type).toBe('mcp: tool result rendered');
    expect(event?.user_id).toBe('u1');
    expect(event?.groups).toEqual({ 'org id': '36958' });
    expect(event?.event_properties).toMatchObject({
      // server-scope inherited
      '[MCP] Session ID': 'sess-1',
      '[MCP] Server Name': 'my-server',
      // tool-scope added
      '[MCP] Tool Name': 'search_docs',
      '[MCP] Tool Owner': 'docs-team',
      '[MCP] Tool Tags': ['search'],
      '[MCP] Tool Category': 'retrieval',
    });
  });

  it('merges caller properties, which win over reserved on collision', () => {
    const { client, tracked } = makeAmplitude();
    const ctx = createToolContext(
      {
        server: { name: 'my-server' },
        transport: 'streamable-http',
        identity: { userId: 'u1', resolvedFrom: 'explicit' },
      },
      { name: 'search_docs' },
    );

    trackToolEvent(client, ctx, 'mcp: tool query', {
      'query text': 'how to do X',
      // Collides with the reserved '[MCP] Tool Name' → caller wins.
      '[MCP] Tool Name': 'overridden_name',
    });

    const event = tracked[0];
    expect(event?.event_properties?.['query text']).toBe('how to do X');
    expect(event?.event_properties?.['[MCP] Tool Name']).toBe('overridden_name'); // caller wins
  });

  it("emits the tool's extra enrichment, and lets caller properties override it", () => {
    const { client, tracked } = makeAmplitude();
    const ctx = createToolContext(
      {
        server: { name: 'my-server' },
        transport: 'streamable-http',
        identity: { userId: 'u1', resolvedFrom: 'explicit' },
      },
      { name: 'search_docs', extra: { 'org url': 'from-extra', region: 'us' } },
    );

    trackToolEvent(client, ctx, 'mcp: tool query', { 'org url': 'from-caller' });

    const event = tracked[0];
    expect(event?.event_properties?.region).toBe('us'); // extra, no collision
    expect(event?.event_properties?.['org url']).toBe('from-caller'); // caller overrides extra
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
        identity: { userId: 'u1', resolvedFrom: 'explicit' },
      },
      { name: 'search_docs' },
    );

    expect(() => trackToolEvent(client, ctx, 'mcp: failing event')).not.toThrow();
  });
});
