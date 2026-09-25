/**
 * The playground posts a real HTTP V2 batch at a local sink.
 *
 * Unit tests stop at an in-memory `track`. This drives the official MCP client
 * through `startPlaygroundHttp` and reads the body `@amplitude/analytics-node`
 * actually sent.
 */
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCAL_API_KEY } from '../examples/playground/server.js';
import { startPlaygroundHttp, type RunningPlaygroundHttp } from '../examples/playground/http.js';

interface IngestionBatch {
  api_key?: string;
  events?: Array<{
    event_type?: string;
    user_id?: string;
    event_properties?: Record<string, unknown>;
  }>;
}

describe('playground ingestion sink', () => {
  let running: RunningPlaygroundHttp | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
    await running?.close();
    running = undefined;
  });

  it('posts a tool-call event inside an HTTP V2 events array', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-playground-'));
    const logPath = join(dir, 'events.ndjson');
    // Force the sink even when AMPLITUDE_API_KEY is set in the environment.
    running = await startPlaygroundHttp({ port: 0, logPath, delivery: 'sink' });

    client = new Client({ name: 'playground-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(running.url));
    const result = await client.callTool({
      name: 'echo',
      arguments: { message: 'hello', rationale: 'checking the sink' },
    });
    const whoami = await client.callTool({ name: 'whoami' });
    await running.flush();

    expect(result).toMatchObject({
      content: [{ type: 'text', text: 'hello' }],
    });
    expect(whoami).toMatchObject({
      content: [{ type: 'text', text: 'playground-user' }],
    });

    const batches = (await readFile(logPath, 'utf8'))
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as IngestionBatch);
    const batch = batches.find((entry) =>
      entry.events?.some((event) => event.event_type === '[MCP] Tool Call Response'),
    );
    expect(batch?.api_key).toBe(LOCAL_API_KEY);
    const whoamiEvent = batches
      .flatMap((entry) => entry.events ?? [])
      .find((event) => event.event_properties?.['[MCP] Tool Name'] === 'whoami');
    expect(whoamiEvent?.user_id).toBe('playground-user');
    expect(batch?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: '[MCP] Tool Call Response',
          event_properties: expect.objectContaining({
            '[MCP] Tool Name': 'echo',
            '[MCP] Rationale': 'checking the sink',
          }),
        }),
      ]),
    );
  });
});
