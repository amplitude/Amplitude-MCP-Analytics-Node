import { describe, expect, it } from 'vitest';
import { createServerContext, createToolContext } from '../src/context/index.js';
import type { McpClientInfo } from '../src/context/types.js';
import { trackServerEvent, trackToolEvent } from '../src/tracking/index.js';
import type { AmplitudeEvent } from '../src/types.js';
import fixtures from './fixtures/client-attribution.json';

const attributionKeys = [
  '[MCP] Client Name', '[MCP] Client Version', '[MCP] Client Name Source',
  '[MCP] Client Family', '[MCP] Client Surface', '[MCP] Client Family Source', '[MCP] User Agent',
];

describe('client attribution on custom events', () => {
  it.each(fixtures)('$case', ({ client, expected }) => {
    const events: AmplitudeEvent[] = [];
    const amplitude = { track: (event: AmplitudeEvent) => events.push(event), flush: () => undefined };
    const ctx = createServerContext({
      server: { name: 'sdk-test' },
      transport: 'streamable-http',
      identity: { userId: 'test-user', resolvedFrom: 'explicit' },
      // Fixture data includes intentionally malformed runtime inputs.
      client: Object.freeze(client) as McpClientInfo,
    });

    trackServerEvent(amplitude, ctx, 'server-custom');
    trackToolEvent(amplitude, createToolContext(ctx, { name: 'echo' }), 'tool-custom');

    expect(events).toHaveLength(2);
    for (const event of events) {
      const props = Object.entries(event.event_properties ?? {})
        .filter(([key]) => attributionKeys.includes(key));
      expect(Object.fromEntries(props)).toEqual(expected);
    }
  });
});
