/**
 * `registerFeedbackTool` on a v2 server. v2 rejects a zod 3 raw shape, so
 * registration goes through the server package's JSON Schema helper.
 */
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { AmplitudeMCPAnalytics } from '../src/client.js';
import type { AmplitudeEvent } from '../src/types.js';

describe('registerFeedbackTool — v2 McpServer', () => {
  it('registers the tool and emits [MCP] Feedback Submitted', async () => {
    const tracked: AmplitudeEvent[] = [];
    const analytics = new AmplitudeMCPAnalytics({
      amplitude: { track: (event: AmplitudeEvent) => tracked.push(event), flush: () => undefined },
      serverName: 'test-mcp',
      serverVersion: '9.9.9',
    });
    const server = new McpServer({ name: 'test-mcp', version: '9.9.9' });
    analytics.instrumentServer(server, { userId: 'user-7' });
    analytics.registerFeedbackTool(server);

    const registered = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    expect(registered.submit_feedback).toBeDefined();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const listed = await client.listTools();
    const feedback = listed.tools.find((tool) => tool.name === 'submit_feedback');
    expect(feedback?.inputSchema.required).toContain('helpful');

    const result = await client.callTool({
      name: 'submit_feedback',
      arguments: { helpful: true, solicited: false },
    });
    expect(result.isError).toBeUndefined();

    const submitted = tracked.filter((event) => event.event_type === '[MCP] Feedback Submitted');
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.user_id).toBe('user-7');
    expect(submitted[0]?.event_properties).toMatchObject({
      '[MCP] Tool Name': 'submit_feedback',
      '[MCP] Feedback Helpful': true,
      '[MCP] Feedback Solicited': false,
    });
    expect(tracked.some((event) => event.event_type === '[MCP] Tool Call Response')).toBe(false);

    await client.close();
    await server.close();
  });
});
