/**
 * One scenario table against a v1 server and a v2 server. The `[MCP]` events
 * must match, aside from fields whose text or timing legitimately differ
 * (error message wording, durations, sizes).
 */
import { Client as V1Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport as V1Memory } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer as V1Server } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client as V2Client } from '@modelcontextprotocol/client';
import { InMemoryTransport as V2Memory, McpServer as V2Server } from '@modelcontextprotocol/server';
import { z as z3 } from 'zod';
import { z as z4 } from 'zod4';
import { describe, expect, it } from 'vitest';
import { AmplitudeMCPAnalytics } from '../../src/client.js';
import { MCPAnalyticsConfig } from '../../src/config.js';
import { getCurrentContext } from '../../src/context/index.js';
import type { McpToolContext } from '../../src/context/types.js';
import type { AmplitudeEvent } from '../../src/types.js';

type Line = 'v1' | 'v2';

const ok = { content: [{ type: 'text' as const, text: 'ok' }] };
const failed = { content: [{ type: 'text' as const, text: 'upstream 500' }], isError: true as const };

/** Wording and measurements the two SDK lines do not promise to share. */
const UNSTABLE = new Set([
  '[MCP] Error Message',
  '[MCP] Response Duration',
  '[MCP] Response Size',
  '[MCP] Request Size',
  '[MCP] Session Duration',
]);

interface ToolSchema {
  v1: Record<string, z3.ZodTypeAny>;
  v2: Record<string, z4.ZodTypeAny>;
}

interface DrivenClient {
  callTool: (params: {
    name: string;
    arguments?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  }) => Promise<unknown>;
  listTools: () => Promise<unknown>;
  close: () => Promise<void>;
}

interface Session {
  analytics: AmplitudeMCPAnalytics;
  server: V1Server | V2Server;
  register: (name: string, schema: ToolSchema | undefined, handler: () => Promise<unknown>, disable?: boolean) => void;
  connect: () => Promise<DrivenClient>;
  events: AmplitudeEvent[];
}

function open(line: Line, config?: MCPAnalyticsConfig, instrument?: { resolveIdentity?: () => { userId: string } }): Session {
  const events: AmplitudeEvent[] = [];
  const analytics = new AmplitudeMCPAnalytics({
    amplitude: { track: (event: AmplitudeEvent) => events.push(event), flush: () => undefined },
    serverName: 'parity-mcp',
    serverVersion: '1.0.0',
    config,
  });
  const server = line === 'v1'
    ? new V1Server({ name: 'parity-mcp', version: '1.0.0' })
    : new V2Server({ name: 'parity-mcp', version: '1.0.0' });

  return {
    analytics,
    server,
    events,
    register(name, schema, handler, disable) {
      const wrapped = analytics.instrumentTool(handler as () => Promise<typeof ok>, { name });
      if (line === 'v1') {
        const registered = (server as V1Server).registerTool(
          name,
          schema == null ? { description: name } : { description: name, inputSchema: schema.v1 },
          wrapped,
        );
        if (disable) registered.disable();
        return;
      }
      const registered = (server as V2Server).registerTool(
        name,
        schema == null ? { description: name } : { description: name, inputSchema: schema.v2 },
        wrapped,
      );
      if (disable) registered.disable();
    },
    async connect() {
      analytics.instrumentServer(server, { userId: 'user-1', ...instrument });
      if (line === 'v1') {
        const [clientTransport, serverTransport] = V1Memory.createLinkedPair();
        const client = new V1Client({ name: 'parity-client', version: '2.0.0' });
        await Promise.all([(server as V1Server).connect(serverTransport), client.connect(clientTransport)]);
        return client as DrivenClient;
      }
      const [clientTransport, serverTransport] = V2Memory.createLinkedPair();
      const client = new V2Client({ name: 'parity-client', version: '2.0.0' });
      await Promise.all([(server as V2Server).connect(serverTransport), client.connect(clientTransport)]);
      return client as DrivenClient;
    },
  };
}

function project(events: AmplitudeEvent[]) {
  return events
    .filter((event) => event.event_type.startsWith('[MCP]'))
    .map((event) => ({
      type: event.event_type,
      user_id: event.user_id,
      props: Object.fromEntries(
        Object.entries(event.event_properties ?? {})
          .filter(([key]) => !UNSTABLE.has(key))
          .sort(([a], [b]) => a.localeCompare(b)),
      ),
    }));
}

const echoSchema: ToolSchema = {
  v1: { text: z3.string() },
  v2: { text: z4.string() },
};

const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

describe('v1 and v2 emit the same [MCP] events', () => {
  const scenarios: Array<{ name: string; run: (line: Line) => Promise<AmplitudeEvent[]> }> = [
    {
      name: 'tools/list',
      async run(line) {
        const session = open(line);
        session.register('ping', undefined, async () => ok);
        const client = await session.connect();
        await client.listTools();
        await client.close();
        return session.events;
      },
    },
    {
      name: 'successful call',
      async run(line) {
        const session = open(line);
        session.register('echo', echoSchema, async () => ok);
        const client = await session.connect();
        await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
        await client.close();
        return session.events;
      },
    },
    {
      name: 'thrown error',
      async run(line) {
        const session = open(line);
        session.register('boom', undefined, async () => {
          throw new Error('boom');
        });
        const client = await session.connect();
        await client.callTool({ name: 'boom', arguments: {} }).catch(() => undefined);
        await client.close();
        return session.events;
      },
    },
    {
      name: 'isError result',
      async run(line) {
        const session = open(line);
        session.register('fails', undefined, async () => failed);
        const client = await session.connect();
        await client.callTool({ name: 'fails', arguments: {} });
        await client.close();
        return session.events;
      },
    },
    {
      name: 'unknown, disabled, and schema-invalid calls',
      async run(line) {
        const session = open(line);
        session.register('echo', echoSchema, async () => ok);
        session.register('off', undefined, async () => ok, true);
        const client = await session.connect();
        await client.callTool({ name: 'made_up_tool', arguments: {} }).catch(() => undefined);
        await client.callTool({ name: 'off', arguments: {} }).catch(() => undefined);
        await client.callTool({ name: 'echo', arguments: { text: 1 } }).catch(() => undefined);
        await client.close();
        return session.events;
      },
    },
    {
      name: 'toolError()',
      async run(line) {
        const session = open(line);
        session.register('needs_chart', undefined, async () =>
          session.analytics.toolError(getCurrentContext() as McpToolContext | undefined, {
            code: 'missing_chart_id',
            message: 'No chart ID was provided.',
          }),
        );
        const client = await session.connect();
        await client.callTool({ name: 'needs_chart', arguments: {} });
        await client.close();
        return session.events;
      },
    },
    {
      name: 'setIdentity',
      async run(line) {
        const session = open(line);
        session.register('identify', undefined, async () => {
          session.analytics.setIdentity({ userId: 'from-tool' });
          return ok;
        });
        const client = await session.connect();
        await client.callTool({ name: 'identify', arguments: {} });
        await client.close();
        return session.events;
      },
    },
    {
      name: 'resolveIdentity',
      async run(line) {
        const session = open(line, undefined, { resolveIdentity: () => ({ userId: 'resolved-user' }) });
        session.register('ping', undefined, async () => ok);
        const client = await session.connect();
        await client.callTool({ name: 'ping', arguments: {} });
        await client.close();
        return session.events;
      },
    },
    {
      name: 'feedback tool',
      async run(line) {
        const session = open(line);
        session.analytics.instrumentServer(session.server, { userId: 'user-1' });
        session.analytics.registerFeedbackTool(session.server);
        const client = await session.connect();
        await client.callTool({ name: 'submit_feedback', arguments: { helpful: true } });
        await client.close();
        return session.events;
      },
    },
  ];

  scenarios.push(
    {
      name: '_meta correlation ids',
      async run(line) {
        const session = open(line);
        session.register('echo', echoSchema, async () => ok);
        const client = await session.connect();
        await client.callTool({
          name: 'echo',
          arguments: { text: 'hi' },
          _meta: { conversation_id: 'conv-1', traceparent: TRACEPARENT },
        });
        await client.close();
        return session.events;
      },
    },
    {
      name: 'autocapture off',
      async run(line) {
        const session = open(line, new MCPAnalyticsConfig({ autocapture: false }));
        session.register('ping', undefined, async () => ok);
        const client = await session.connect();
        await client.listTools();
        await client.callTool({ name: 'ping', arguments: {} });
        await client.close();
        return session.events;
      },
    },
  );

  it.each(scenarios.map((scenario) => [scenario.name, scenario.run] as const))(
    '%s',
    async (_name, run) => {
      const v1 = project(await run('v1'));
      const v2 = project(await run('v2'));
      expect(v2).toEqual(v1);
    },
  );
});
