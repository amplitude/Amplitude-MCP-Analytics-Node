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
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  logStdioMessages,
  type McpRequestRecord,
  type McpResponseRecord,
  openRequestLog,
  type RequestLogRecord,
} from '../examples/playground/request-log.js';
import { createRunInfo } from '../examples/playground/run.js';
import { LOCAL_API_KEY, type SdkTrackRecord } from '../examples/playground/server.js';
import { startPlaygroundHttp, type RunningPlaygroundHttp } from '../examples/playground/http.js';

interface IngestionBatch {
  api_key?: string;
  runId?: string;
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
    const requestLogPath = join(dir, 'mcp-requests.ndjson');
    const trackLogPath = join(dir, 'sdk-track.ndjson');
    // Force the sink even when AMPLITUDE_API_KEY is set in the environment.
    running = await startPlaygroundHttp({ port: 0, logPath, requestLogPath, trackLogPath, delivery: 'sink' });

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

    const requestLog = await readNdjson<RequestLogRecord>(requestLogPath);
    const requests = requestLog.filter(
      (record): record is McpRequestRecord => record.type == null || record.type === 'request',
    );
    const echoCall = requests.find(
      (record) =>
        record.message != null &&
        typeof record.message === 'object' &&
        'method' in record.message &&
        record.message.method === 'tools/call' &&
        'params' in record.message &&
        record.message.params != null &&
        typeof record.message.params === 'object' &&
        'name' in record.message.params &&
        record.message.params.name === 'echo',
    );
    expect(echoCall).toMatchObject({
      transport: 'streamable-http',
      httpMethod: 'POST',
      message: {
        method: 'tools/call',
        params: {
          name: 'echo',
          arguments: { message: 'hello', rationale: 'checking the sink' },
        },
      },
    });

    // Every line of this run carries the run id, and the request has a seq
    // that its response and its track() call share.
    const runId = running.playground.run.runId;
    expect(echoCall?.runId).toBe(runId);
    expect(typeof echoCall?.seq).toBe('number');
    expect(echoCall?.headers).toMatchObject({ 'content-type': expect.stringContaining('application/json') });
    expect(echoCall?.headers?.authorization).toBeUndefined();
    const response = requestLog.find(
      (record): record is McpResponseRecord => record.type === 'response' && record.seq === echoCall?.seq,
    );
    expect(response).toMatchObject({ runId, status: 200 });

    const tracks = await readNdjson<SdkTrackRecord>(trackLogPath);
    const echoTrack = tracks.find(
      (record) => record.type === 'track' && record.requestSeq === echoCall?.seq,
    );
    expect(echoTrack).toMatchObject({
      runId,
      event_type: '[MCP] Tool Call Response',
      event_properties: expect.objectContaining({ '[MCP] Tool Name': 'echo' }),
    });
    expect(echoTrack?.sessionId).toBe(echoCall?.sessionId);
    expect(batch?.runId).toBe(runId);
  });

  it('logs stdio JSON-RPC lines, including a line split across chunks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-playground-stdio-'));
    const run = createRunInfo('stdio');
    const log = await openRequestLog(join(dir, 'mcp-requests.ndjson'), run);
    const input = new PassThrough();
    const output = logStdioMessages(input, log, run);
    const forwarded: Buffer[] = [];
    output.on('data', (chunk: Buffer) => {
      forwarded.push(chunk);
    });
    const done = new Promise<void>((resolve) => {
      output.on('end', () => resolve());
    });

    const message = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'echo', arguments: { message: 'hi' } },
    };
    const line = `${JSON.stringify(message)}\n`;
    input.write(line.slice(0, 12));
    input.end(line.slice(12));
    await done;

    expect(Buffer.concat(forwarded).toString('utf8')).toBe(line);
    const records = await readNdjson<McpRequestRecord | { type: string; runId: string }>(log.logPath);
    expect(records).toEqual([
      expect.objectContaining({ type: 'run_started', runId: run.runId, transport: 'stdio' }),
      expect.objectContaining({
        transport: 'stdio',
        runId: run.runId,
        seq: expect.any(Number),
        receivedAt: expect.any(Number),
        message,
      }),
    ]);
    await log.close();
  });
});

async function readNdjson<T>(path: string): Promise<T[]> {
  const raw = await readFile(path, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}
