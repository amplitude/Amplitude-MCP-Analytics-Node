import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod4';
import { FEEDBACK_TOOL_INSTRUCTIONS } from '../../../src/index.js';
import { PLAYGROUND_SERVER_NAME, type Playground } from '../server.js';

/**
 * The same playground tools on the TypeScript SDK v2 server line
 * (`@modelcontextprotocol/server`), for capture modes that need to answer
 * `server/discover` and speak protocol revision 2026-07-28.
 *
 * `createMcpHandler` and `serveStdio` call the factory per connection (per
 * request on the stateless HTTP fallback), so the returned function is the
 * unit of sharing — analytics state lives in `playground`, not the server.
 */
export function createV2ServerFactory(playground: Playground): () => McpServer {
  const analytics = playground.analytics;
  return () => {
    const server = new McpServer(
      { name: PLAYGROUND_SERVER_NAME, version: packageVersion() },
      {
        instructions: [
          'Local playground for Amplitude MCP analytics. echo returns the message you pass and, when you include rationale, records why you called it. whoami records a fixed playground user id. Neither tool does any other work.',
          FEEDBACK_TOOL_INSTRUCTIONS,
        ].join('\n\n'),
      },
    );

    server.registerTool(
      'echo',
      {
        description:
          'Return the message you were given. Include rationale when you know why you are calling this tool.',
        inputSchema: {
          message: z.string().describe('Text to echo back.'),
          rationale: z.string().optional().describe('Why you called this tool.'),
        },
      },
      analytics.instrumentTool(async (args: { message?: string; rationale?: string }) => {
        if (typeof args.rationale === 'string' && args.rationale.length > 0) {
          analytics.setRationale(args.rationale);
        }
        const message = typeof args.message === 'string' ? args.message : '';
        return { content: [{ type: 'text' as const, text: message }] };
      }, { name: 'echo' }),
    );

    server.registerTool(
      'whoami',
      { description: 'Report the playground user id and attach it to analytics for this call.' },
      analytics.instrumentTool(async () => {
        analytics.setIdentity({ userId: 'playground-user' });
        return { content: [{ type: 'text' as const, text: 'playground-user' }] };
      }, { name: 'whoami' }),
    );

    analytics.instrumentServer(server, {
      tenant: { groupType: 'org id', groupValue: process.env.PLAYGROUND_ORG_ID ?? '0' },
    });
    analytics.registerFeedbackTool(server);
    return server;
  };
}

function packageVersion(): string {
  const path = fileURLToPath(new URL('../../../package.json', import.meta.url));
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (parsed != null && typeof parsed === 'object' && 'version' in parsed && typeof parsed.version === 'string') {
    return parsed.version;
  }
  return '0.0.0';
}
