/**
 * The playground registers submit_feedback and the scripted cases land as
 * `[MCP] Feedback Submitted` through the real ingestion sink.
 *
 * This does not run an agent. It checks that each case's expected arguments
 * produce the event, that a call does not also emit `[MCP] Tool Call Response`,
 * and that the tool result is the text that tells the agent not to ask again.
 */
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { FEEDBACK_CASES, feedbackCasesThatCall } from '../examples/playground/feedback-cases.js';
import { startPlaygroundHttp, type RunningPlaygroundHttp } from '../examples/playground/http.js';
import { FEEDBACK_RECORDED_TEXT } from '../src/core/feedback-tool.js';

interface IngestionEvent {
  event_type?: string;
  event_properties?: Record<string, unknown>;
}

interface IngestionBatch {
  events?: IngestionEvent[];
}

describe('playground submit_feedback', () => {
  let running: RunningPlaygroundHttp | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
    await running?.close();
    running = undefined;
  });

  it('lists the tool, and each calling case emits feedback without a tool-call response', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-playground-feedback-'));
    const logPath = join(dir, 'events.ndjson');
    running = await startPlaygroundHttp({
      port: 0,
      logPath,
      requestLogPath: join(dir, 'mcp-requests.ndjson'),
      delivery: 'sink',
    });

    client = new Client({ name: 'playground-feedback', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(running.url));

    expect(client.getInstructions()).toContain('submit_feedback');

    const listed = await client.listTools();
    const feedback = listed.tools.find((tool) => tool.name === 'submit_feedback');
    expect(feedback?.description).toContain("thanks, that's it");
    expect(feedback?.description).toContain("that's wrong");
    expect(feedback?.inputSchema.properties).not.toHaveProperty('comment');
    expect(listed.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['echo', 'whoami', 'submit_feedback']),
    );

    const calling = feedbackCasesThatCall();
    expect(calling.map((feedbackCase) => feedbackCase.id)).toEqual([
      'thanks-thats-it',
      'perfect',
      'thats-wrong',
      'didnt-work',
      'file-feedback',
    ]);
    expect(FEEDBACK_CASES.filter((feedbackCase) => feedbackCase.expectedCall == null).map((feedbackCase) => feedbackCase.id)).toEqual([
      'neutral-follow-up',
      'after-recorded',
    ]);
    expect(FEEDBACK_CASES.find((feedbackCase) => feedbackCase.id === 'file-feedback')?.askFirst).toBe(true);
    expect(FEEDBACK_CASES.find((feedbackCase) => feedbackCase.id === 'after-recorded')?.afterFeedback).toBe(true);

    for (const feedbackCase of calling) {
      const expected = feedbackCase.expectedCall;
      if (expected == null) continue;
      const before = await readEvents(logPath);
      const result = await client.callTool({
        name: 'submit_feedback',
        arguments: {
          helpful: expected.helpful,
          ...(expected.reason != null ? { reason: expected.reason } : {}),
          solicited: expected.solicited,
          tools: ['echo'],
        },
      });
      expect(result).toMatchObject({
        content: [{ type: 'text', text: FEEDBACK_RECORDED_TEXT }],
      });
      expect(FEEDBACK_RECORDED_TEXT).toContain('Do not ask for feedback again');

      await running.flush();
      const events = await readEvents(logPath);
      const added = events.slice(before.length);
      const submitted = added.filter((event) => event.event_type === '[MCP] Feedback Submitted');
      expect(submitted).toHaveLength(1);
      expect(submitted[0]?.event_properties).toMatchObject({
        '[MCP] Tool Name': 'submit_feedback',
        '[MCP] Feedback Helpful': expected.helpful,
        '[MCP] Feedback Solicited': expected.solicited,
        '[MCP] Feedback Has Comment': false,
        '[MCP] Feedback Tool Names': ['echo'],
        ...(expected.reason != null ? { '[MCP] Feedback Reason': expected.reason } : {}),
      });
      if (expected.reason == null) {
        expect(submitted[0]?.event_properties).not.toHaveProperty('[MCP] Feedback Reason');
      }
      expect(added.some((event) => event.event_type === '[MCP] Tool Call Response')).toBe(false);
    }

    const beforeEcho = await readEvents(logPath);
    await client.callTool({ name: 'echo', arguments: { message: 'hello again' } });
    await running.flush();
    const afterEcho = await readEvents(logPath);
    const echoAdded = afterEcho.slice(beforeEcho.length);
    expect(echoAdded.some((event) => event.event_type === '[MCP] Tool Call Response')).toBe(true);
    expect(echoAdded.some((event) => event.event_type === '[MCP] Feedback Submitted')).toBe(false);
  });
});

async function readEvents(logPath: string): Promise<IngestionEvent[]> {
  let raw = '';
  try {
    raw = await readFile(logPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const batch = JSON.parse(line) as IngestionBatch;
      return batch.events ?? [];
    });
}
