/**
 * The chain viewer's joiner, on hand-written fixtures. Ids are placeholders.
 */
import { describe, expect, it } from 'vitest';
import {
  buildChain,
  type ChainLogs,
  findCorrelationIds,
  formatChain,
  recordsForRun,
  selectRun,
} from '../examples/playground/chain.js';
import { pickLoggedHeaders } from '../examples/playground/request-log.js';

const RUN = 'run-aaaa';
const OLD_RUN = 'run-0000';
const SESSION = 'sess-1111';
const T0 = 1_700_000_000_000;

function toolsCall(seq: number, id: number, name: string, meta?: Record<string, unknown>) {
  return {
    type: 'request',
    transport: 'streamable-http',
    runId: RUN,
    seq,
    receivedAt: T0 + seq * 1000,
    httpMethod: 'POST',
    path: '/mcp',
    headers: { 'mcp-session-id': SESSION },
    sessionId: SESSION,
    message: {
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: { message: 'hi' }, ...(meta ? { _meta: meta } : {}) },
    },
  };
}

function response(seq: number, status: number, extra: Record<string, unknown> = {}) {
  return {
    type: 'response',
    transport: 'streamable-http',
    runId: RUN,
    seq,
    at: T0 + seq * 1000 + 5,
    status,
    durationMs: 5,
    ...extra,
  };
}

function track(seq: number, requestSeq: number, tool: string, props: Record<string, unknown> = {}) {
  return {
    type: 'track',
    runId: RUN,
    seq,
    at: T0 + requestSeq * 1000 + 3,
    requestSeq,
    sessionId: SESSION,
    event_type: '[MCP] Tool Call Response',
    user_id: 'playground-user',
    device_id: 'dev-2222',
    event_properties: { '[MCP] Tool Name': tool, '[MCP] Session ID': SESSION, ...props },
  };
}

function ingestion(runId: string, events: Array<Record<string, unknown>>) {
  return {
    api_key: 'local-test-key',
    runId,
    receivedAt: T0 + 10_000,
    events,
    options: {},
  };
}

function ingestedToolCall(requestSeq: number, tool: string, extra: Record<string, unknown> = {}) {
  return {
    event_type: '[MCP] Tool Call Response',
    user_id: 'playground-user',
    device_id: 'dev-2222',
    time: T0 + requestSeq * 1000 + 4,
    insert_id: `insert-${requestSeq}`,
    event_properties: { '[MCP] Tool Name': tool, '[MCP] Session ID': SESSION, ...extra },
  };
}

const logs: ChainLogs = {
  requests: [
    { type: 'run_started', at: T0 - 60_000, pid: 1, transport: 'streamable-http', runId: OLD_RUN },
    { ...toolsCall(90, 1, 'echo'), runId: OLD_RUN },
    { type: 'run_started', at: T0, pid: 2, transport: 'streamable-http', runId: RUN },
    { type: 'session_opened', transport: 'streamable-http', runId: RUN, seq: 1, at: T0 + 1, sessionId: SESSION },
    // Full chain, with a nested _meta id that matches an event property by value.
    toolsCall(2, 10, 'echo', { conversation_id: 'conv-3333', agent: { turn_id: 'turn-4444', cwd: '/not/logged' } }),
    response(2, 200, { sse: true, sessionId: SESSION }),
    // Request that never reached track().
    toolsCall(3, 11, 'missing'),
    response(3, 400, { errorBody: '{"error":"nope"}' }),
    // Tracked but never ingested.
    toolsCall(4, 12, 'whoami'),
    response(4, 200, { sse: true }),
  ],
  tracks: [
    { type: 'run_started', at: T0, pid: 2, transport: 'streamable-http', runId: RUN },
    track(20, 2, 'echo', { '[MCP] Conversation ID': 'conv-3333' }),
    track(21, 4, 'whoami'),
  ],
  ingestion: [
    { type: 'run_started', at: T0, pid: 2, transport: 'streamable-http', runId: RUN },
    ingestion(RUN, [ingestedToolCall(2, 'echo', { '[MCP] Conversation ID': 'conv-3333' })]),
    ingestion(OLD_RUN, [ingestedToolCall(4, 'whoami')]),
  ],
};

describe('playground chain viewer', () => {
  it('picks the latest run by default and honours --run', () => {
    expect(selectRun(logs.requests)?.runId).toBe(RUN);
    expect(selectRun(logs.requests, OLD_RUN)?.runId).toBe(OLD_RUN);
    expect(selectRun(logs.requests, 'run-unknown')).toMatchObject({ runId: 'run-unknown', at: null });
  });

  it('attributes lines without a runId to the run whose marker precedes them', () => {
    const records = [
      { type: 'run_started', runId: 'a' },
      { events: [] },
      { type: 'run_started', runId: 'b' },
      { events: [{ event_type: 'x' }] },
      { runId: 'a', events: [] },
    ];
    expect(recordsForRun(records, 'a')).toHaveLength(2);
    expect(recordsForRun(records, 'b')).toHaveLength(1);
  });

  it('lists only correlation-shaped keys with their path and value', () => {
    const ids = findCorrelationIds({
      conversation_id: 'conv-1',
      agent: { turn_id: 'turn-2', cwd: '/secret/path', remote: 'git@example' },
      threadId: 5,
      unrelated: 'x',
    });
    expect(ids).toEqual([
      { path: 'conversation_id', value: 'conv-1' },
      { path: 'agent.turn_id', value: 'turn-2' },
      { path: 'threadId', value: 5 },
    ]);
  });

  it('joins request, response, track, and ingestion, and flags the gaps', () => {
    const rows = buildChain(logs, RUN);
    expect(rows.map((row) => row.tool)).toEqual(['echo', 'missing', 'whoami']);

    const [echo, missing, whoami] = rows;
    expect(echo).toMatchObject({
      seq: 2,
      jsonrpcId: 10,
      sessionId: SESSION,
      response: { status: 200, sse: true, sessionId: SESSION },
      track: { seq: 20, event_type: '[MCP] Tool Call Response', user_id: 'playground-user' },
      ingested: { insert_id: 'insert-2' },
    });
    expect(echo?.metaIds).toEqual([
      { path: 'conversation_id', value: 'conv-3333' },
      { path: 'agent.turn_id', value: 'turn-4444' },
    ]);
    expect(echo?.eventIds).toEqual(
      expect.arrayContaining([
        { path: '[MCP] Session ID', value: SESSION },
        { path: '[MCP] Conversation ID', value: 'conv-3333' },
      ]),
    );
    expect(echo?.flags).toEqual(['meta id not on event: agent.turn_id']);

    expect(missing?.track).toBeNull();
    expect(missing?.response).toMatchObject({ status: 400, errorBody: '{"error":"nope"}' });
    expect(missing?.flags).toEqual(['no track() record for this request', 'response status 400']);

    // The whoami ingestion body belongs to the old run, so it must not be joined.
    expect(whoami?.track).toMatchObject({ seq: 21 });
    expect(whoami?.ingested).toBeNull();
    expect(whoami?.flags).toEqual(['track() record has no ingestion record']);
  });

  it('formats without throwing and includes the flags', () => {
    const run = selectRun(logs.requests);
    if (!run) throw new Error('fixture has no run');
    const text = formatChain(run, buildChain(logs, RUN));
    expect(text).toContain(`run ${RUN}`);
    expect(text).toContain('FLAG       no track() record for this request');
    expect(text).not.toContain('/not/logged');
  });
});

describe('request header allowlist', () => {
  it('keeps only the allowlisted headers', () => {
    const picked = pickLoggedHeaders({
      authorization: 'Bearer secret',
      cookie: 'session=abc',
      'x-forwarded-for': '10.0.0.1',
      'mcp-session-id': SESSION,
      'mcp-protocol-version': '2025-11-25',
      'user-agent': 'test-agent/1.0',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'last-event-id': '7',
    });
    expect(picked).toEqual({
      'mcp-session-id': SESSION,
      'mcp-protocol-version': '2025-11-25',
      'user-agent': 'test-agent/1.0',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'last-event-id': '7',
    });
    expect(Object.keys(picked)).not.toContain('authorization');
    expect(Object.keys(picked)).not.toContain('cookie');
  });
});
