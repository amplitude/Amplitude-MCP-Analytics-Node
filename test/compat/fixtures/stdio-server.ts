/**
 * Spawned stdio server for the real-transport tests. stdout is the MCP
 * protocol, so captured events are appended to `MCP_EVENTS_FILE`.
 *
 * `MCP_SDK_LINE=v1` uses `@modelcontextprotocol/sdk`. `v2` uses
 * `@modelcontextprotocol/server` and `serveStdio`, which connects the server
 * after the factory returns.
 */
import { appendFileSync } from 'node:fs';
import { AmplitudeMCPAnalytics } from '../../../src/client.js';
import type { AmplitudeEvent } from '../../../src/types.js';

const eventsFile = process.env.MCP_EVENTS_FILE;
if (eventsFile == null || eventsFile.length === 0) {
  throw new Error('MCP_EVENTS_FILE is required');
}

const analytics = new AmplitudeMCPAnalytics({
  amplitude: {
    track: (event: AmplitudeEvent) => {
      appendFileSync(eventsFile, `${JSON.stringify(event)}\n`);
    },
    flush: () => undefined,
  },
  serverName: 'stdio-mcp',
  serverVersion: '1.0.0',
});

/**
 * The v1 transport reports close only from `close()`, and older stdio clients
 * neither end stdin nor signal the process. Close on EOF and on SIGTERM so
 * the session-ended event is written before the process goes away.
 */
function shutdownOnEof(server: { close: () => Promise<unknown> }): void {
  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    void server.close().then(
      () => process.exit(0),
      () => process.exit(0),
    );
  };
  process.stdin.on('end', shutdown);
  process.on('SIGTERM', shutdown);
}

const ping = analytics.instrumentTool(
  async () => ({ content: [{ type: 'text' as const, text: 'pong' }] }),
  { name: 'ping' },
);

if (process.env.MCP_SDK_LINE === 'v2') {
  const { McpServer } = await import('@modelcontextprotocol/server');
  const { serveStdio } = await import('@modelcontextprotocol/server/stdio');
  serveStdio(() => {
    const server = new McpServer({ name: 'stdio-mcp', version: '1.0.0' });
    analytics.instrumentServer(server);
    server.registerTool('ping', { description: 'ping' }, ping);
    shutdownOnEof(server);
    return server;
  });
} else {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const server = new McpServer({ name: 'stdio-mcp', version: '1.0.0' });
  analytics.instrumentServer(server);
  server.registerTool('ping', { description: 'ping' }, ping);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  shutdownOnEof(server);
}
