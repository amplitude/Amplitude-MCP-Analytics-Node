/**
 * A real v1 stdio process: the client spawns the server, and the server's
 * anchor is the process rather than an HTTP session.
 */
import { describe, expect, it } from 'vitest';
import { connectStdio, waitForEvents } from './stdio.js';

describe('v1 stdio', () => {
  it('anchors the session to the process and emits session events', async () => {
    const session = await connectStdio('v1');
    try {
      await session.client.callTool({ name: 'ping', arguments: {} });
      await session.client.close();
      const events = await waitForEvents(session.events, (found) =>
        found.some((event) => event.event_type === '[MCP] Session Ended'),
      );

      const types = events.map((event) => event.event_type);
      expect(types).toContain('[MCP] Session Initialized');
      expect(types).toContain('[MCP] Session Ended');
      expect(types).toContain('[MCP] Tool Call Response');

      for (const event of events) {
        expect(event.event_properties?.['[MCP] Transport']).toBe('stdio');
        expect(event.event_properties?.['[MCP] Anchor Type']).toBe('process');
      }
      expect(events[0]?.user_id?.startsWith('process:')).toBe(true);
    } finally {
      await session.close();
    }
  }, 20_000);
});
