/**
 * `[MCP] Tool Call Rejected` against a real `@modelcontextprotocol/server` v2
 * `McpServer`. v2 throws for an unknown or disabled tool (with a JSON-RPC code
 * and no `MCP error` prefix) and returns an in-band `isError` result for
 * schema validation, again without that prefix.
 */
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod4';
import { beforeEach, describe, expect, it } from 'vitest';
import { AmplitudeMCPAnalytics } from '../src/client.js';
import type { AmplitudeEvent } from '../src/types.js';

const REJECTED = '[MCP] Tool Call Rejected';
const RESPONSE = '[MCP] Tool Call Response';

const ok = { content: [{ type: 'text' as const, text: 'ok' }] };
const failed = { content: [{ type: 'text' as const, text: 'upstream 500' }], isError: true };

interface Harness {
  client: Client;
  events: (type: string) => AmplitudeEvent[];
  reset: () => void;
}

async function harness(): Promise<Harness> {
  const tracked: AmplitudeEvent[] = [];
  const analytics = new AmplitudeMCPAnalytics({
    amplitude: { track: (e: AmplitudeEvent) => tracked.push(e), flush: () => undefined },
    serverName: 'test-mcp',
    serverVersion: '9.9.9',
  });

  const server = new McpServer({ name: 'test-mcp', version: '9.9.9' });
  server.registerTool(
    'echo',
    { inputSchema: { text: z.string() } },
    analytics.instrumentTool(async () => ok, { name: 'echo' }),
  );
  server.registerTool(
    'fails',
    {},
    analytics.instrumentTool(async () => failed, { name: 'fails' }),
  );
  server.registerTool('off', {}, analytics.instrumentTool(async () => ok, { name: 'off' })).disable();

  analytics.instrumentServer(server, { userId: 'user-1' });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    events: (type) => tracked.filter((e) => e.event_type === type),
    reset: () => {
      tracked.length = 0;
    },
  };
}

async function call(h: Harness, name: string, args?: Record<string, unknown>): Promise<void> {
  await h.client.callTool({ name, arguments: args ?? {} }).catch(() => undefined);
}

describe('[MCP] Tool Call Rejected — v2 McpServer', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });

  it('emits for an unknown tool, a disabled tool, and a schema failure', async () => {
    await call(h, 'made_up_tool');
    const unknown = h.events(REJECTED)[0]?.event_properties;
    h.reset();
    await call(h, 'off');
    const disabled = h.events(REJECTED)[0]?.event_properties;
    h.reset();
    await call(h, 'echo', { text: 123 });
    const invalid = h.events(REJECTED)[0]?.event_properties;

    expect(unknown).toMatchObject({
      '[MCP] Attempted Tool Name': 'made_up_tool',
      '[MCP] Rejection Reason': 'unknown_tool',
      '[MCP] Error Code': '-32602',
      '[MCP] Error Type': 'protocol_error',
    });
    expect(disabled).toMatchObject({
      '[MCP] Attempted Tool Name': 'off',
      '[MCP] Rejection Reason': 'disabled_tool',
      '[MCP] Error Code': '-32602',
    });
    expect(invalid).toMatchObject({
      '[MCP] Attempted Tool Name': 'echo',
      '[MCP] Rejection Reason': 'schema_validation',
      '[MCP] Error Code': '-32602',
    });
    expect(unknown?.['[MCP] Tool Name']).toBeUndefined();
  });

  it('reports a tool failure on Tool Call Response', async () => {
    await call(h, 'fails');

    expect(h.events(REJECTED)).toHaveLength(0);
    expect(h.events(RESPONSE)).toHaveLength(1);
    expect(h.events(RESPONSE)[0]?.event_properties).toMatchObject({ '[MCP] Is Error': true });
  });
});
