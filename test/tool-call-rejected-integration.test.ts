/**
 * `[MCP] Tool Call Rejected` against the **real** `McpServer`, over a real
 * transport pair.
 *
 * The sibling `tool-call-rejected.test.ts` drives a hand-rolled server so it can
 * pin down exact dispatch semantics; that fake encodes the pre-1.21 contract in
 * which the SDK threw for pre-dispatch failures. These tests deliberately use
 * whatever SDK is installed instead, because the behavior they assert must hold
 * on both sides of the 1.21 change (see `core/tool-call-rejection.ts`):
 *
 *   - through 1.20 the `tools/call` handler threw an `McpError`
 *   - from 1.21 it returns an in-band `isError` result for the same failures
 *
 * Every assertion below is therefore written to be version-independent. A run
 * against a single SDK proves one arm; the CI `sdk-compat` job covers the other.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { beforeEach, describe, expect, it } from 'vitest';
import { AmplitudeMCPAnalytics } from '../src/client.js';
import { MCPAnalyticsConfig } from '../src/config.js';
import type { AmplitudeEvent } from '../src/types.js';

const REJECTED = '[MCP] Tool Call Rejected';
const RESPONSE = '[MCP] Tool Call Response';

const ok = { content: [{ type: 'text' as const, text: 'ok' }] };
const failed = { content: [{ type: 'text' as const, text: 'upstream 500' }], isError: true };

interface Harness {
  client: Client;
  tracked: AmplitudeEvent[];
  events: (type: string) => AmplitudeEvent[];
  reset: () => void;
}

/**
 * A live client wired to an instrumented `McpServer` carrying one tool of each
 * shape that matters here: instrumented, instrumented-and-failing, registered
 * but never wrapped, and disabled.
 */
async function harness(config?: MCPAnalyticsConfig): Promise<Harness> {
  const tracked: AmplitudeEvent[] = [];
  const analytics = new AmplitudeMCPAnalytics({
    amplitude: { track: (e: AmplitudeEvent) => tracked.push(e), flush: () => undefined },
    serverName: 'test-mcp',
    serverVersion: '9.9.9',
    config,
  });

  const server = new McpServer({ name: 'test-mcp', version: '9.9.9' });
  server.tool(
    'echo',
    { text: z.string() },
    analytics.instrumentTool(async () => ok, { name: 'echo' }),
  );
  server.tool(
    'fails',
    {},
    analytics.instrumentTool(async () => failed, { name: 'fails' }),
  );
  // Registered but NOT wrapped: its callback runs unseen, so an `isError` from
  // it reaches the hook unmarked — the false positive the classifier must dodge.
  server.tool('uninstrumented', {}, async () => failed);
  server.tool('off', {}, analytics.instrumentTool(async () => ok, { name: 'off' })).disable();

  analytics.instrumentServer(server, { userId: 'user-1' });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    tracked,
    events: (type) => tracked.filter((e) => e.event_type === type),
    reset: () => {
      tracked.length = 0;
    },
  };
}

/** Call a tool, tolerating either failure shape the SDK may use. */
async function call(h: Harness, name: string, args?: Record<string, unknown>): Promise<void> {
  await h.client.callTool({ name, arguments: args ?? {} }).catch(() => undefined);
}

describe('[MCP] Tool Call Rejected — real McpServer', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });

  it('emits for an unknown tool name', async () => {
    await call(h, 'made_up_tool');

    const [rejected] = h.events(REJECTED);
    expect(rejected?.user_id).toBe('user-1');
    expect(rejected?.event_properties).toMatchObject({
      '[MCP] Attempted Tool Name': 'made_up_tool',
      '[MCP] Error Type': 'protocol_error',
      '[MCP] Is Error': true,
    });
    // The attempted name is unvalidated input and must stay off the reserved key.
    expect(rejected?.event_properties?.['[MCP] Tool Name']).toBeUndefined();
    expect(h.events(RESPONSE)).toHaveLength(0);
  });

  it('emits for a disabled tool', async () => {
    await call(h, 'off');

    expect(h.events(REJECTED)).toHaveLength(1);
    expect(h.events(REJECTED)[0]?.event_properties).toMatchObject({
      '[MCP] Attempted Tool Name': 'off',
      '[MCP] Error Type': 'protocol_error',
    });
    expect(h.events(RESPONSE)).toHaveLength(0);
  });

  it('emits for an input-schema validation failure', async () => {
    await call(h, 'echo', { text: 123 });

    expect(h.events(REJECTED)).toHaveLength(1);
    expect(h.events(REJECTED)[0]?.event_properties).toMatchObject({
      '[MCP] Attempted Tool Name': 'echo',
      '[MCP] Error Type': 'protocol_error',
    });
    expect(h.events(RESPONSE)).toHaveLength(0);
  });

  it('recovers the JSON-RPC code, which SDKs >= 1.21 keep only in the message', async () => {
    await call(h, 'made_up_tool');

    // -32602 (invalid params) for every pre-dispatch rejection the SDK raises.
    expect(h.events(REJECTED)[0]?.event_properties?.['[MCP] Error Code']).toBe('-32602');
  });

  it('separates the three rejection causes, which Error Code cannot', async () => {
    await call(h, 'made_up_tool');
    const unknown = h.events(REJECTED)[0]?.event_properties;
    h.reset();
    await call(h, 'off');
    const disabled = h.events(REJECTED)[0]?.event_properties;
    h.reset();
    await call(h, 'echo', { text: 123 });
    const invalid = h.events(REJECTED)[0]?.event_properties;

    // The SDK codes all three -32602, so Error Code is not a discriminator...
    expect(unknown?.['[MCP] Error Code']).toBe('-32602');
    expect(disabled?.['[MCP] Error Code']).toBe('-32602');
    expect(invalid?.['[MCP] Error Code']).toBe('-32602');
    // ...and Error Type is `protocol_error` for every one of them.
    expect(unknown?.['[MCP] Error Type']).toBe('protocol_error');

    // Rejection Reason is what actually separates them.
    expect(unknown?.['[MCP] Rejection Reason']).toBe('unknown_tool');
    expect(disabled?.['[MCP] Rejection Reason']).toBe('disabled_tool');
    expect(invalid?.['[MCP] Rejection Reason']).toBe('schema_validation');
  });

  it('keeps Rejection Reason when sanitizeErrorMessage drops the message', async () => {
    // The whole point: dropping the message must not cost the distinction.
    const dropped = await harness(new MCPAnalyticsConfig({ sanitizeErrorMessage: () => null }));
    await call(dropped, 'off');

    const props = dropped.events(REJECTED)[0]?.event_properties;
    expect(props).not.toHaveProperty('[MCP] Error Message');
    expect(props?.['[MCP] Rejection Reason']).toBe('disabled_tool');
  });

  it('carries duration and response size', async () => {
    await call(h, 'made_up_tool');

    const props = h.events(REJECTED)[0]?.event_properties;
    expect(props?.['[MCP] Response Duration']).toBeTypeOf('number');
    expect(props?.['[MCP] Response Size']).toBeTypeOf('number');
    expect(props?.['[MCP] Response Size']).toBeGreaterThan(0);
  });

  it('does not emit for a successful dispatched call', async () => {
    await call(h, 'echo', { text: 'hi' });

    expect(h.events(REJECTED)).toHaveLength(0);
    expect(h.events(RESPONSE)).toHaveLength(1);
  });

  it('does not emit for an instrumented tool that fails in-band — Response owns it', async () => {
    await call(h, 'fails');

    expect(h.events(REJECTED)).toHaveLength(0);
    expect(h.events(RESPONSE)).toHaveLength(1);
    expect(h.events(RESPONSE)[0]?.event_properties).toMatchObject({ '[MCP] Is Error': true });
  });

  it('does not misreport an uninstrumented tool’s own isError as a rejection', async () => {
    await call(h, 'uninstrumented');

    // Nothing is emitted: the wrapper never saw the call, and it is not a
    // protocol rejection either. Claiming it would inflate protocol_error.
    expect(h.events(REJECTED)).toHaveLength(0);
    expect(h.events(RESPONSE)).toHaveLength(0);
  });

  it('respects autocapture.toolCalls: false', async () => {
    const off = await harness(new MCPAnalyticsConfig({ autocapture: { toolCalls: false } }));
    await call(off, 'made_up_tool');

    expect(off.events(REJECTED)).toHaveLength(0);
  });

  it('routes the rejection message through sanitizeErrorMessage', async () => {
    // SDK >= 1.21 quotes the offending argument value in validation errors, so
    // this path can carry caller-supplied data.
    const sanitized = await harness(
      new MCPAnalyticsConfig({ sanitizeErrorMessage: () => '<redacted>' }),
    );
    await call(sanitized, 'echo', { text: 123 });

    const [rejected] = sanitized.events(REJECTED);
    expect(rejected?.event_properties?.['[MCP] Error Message']).toBe('<redacted>');
    // Classification survives sanitization — it is what remains segmentable.
    expect(rejected?.event_properties?.['[MCP] Error Type']).toBe('protocol_error');
  });
});
