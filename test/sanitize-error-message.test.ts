/**
 * `config.sanitizeErrorMessage` — the opt-out for `[MCP] Error Message`.
 *
 * Covers the helper's contract directly, then the wiring: every default event
 * that carries the property must route through it, and no other error property
 * may be disturbed.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { AmplitudeMCPAnalytics } from '../src/client.js';
import { MCPAnalyticsConfig } from '../src/config.js';
import { sanitizeErrorMessage } from '../src/tracking/sanitize-error-message.js';
import type { AmplitudeEvent } from '../src/types.js';

describe('sanitizeErrorMessage helper', () => {
  it('passes the message through when no sanitizer is configured', () => {
    expect(sanitizeErrorMessage('boom', undefined)).toBe('boom');
  });

  it('returns the sanitizer’s replacement', () => {
    expect(sanitizeErrorMessage('user@example.com failed', (m) => m.replace(/\S+@\S+/, '<email>'))).toBe(
      '<email> failed',
    );
  });

  it('omits the property when the sanitizer returns null', () => {
    expect(sanitizeErrorMessage('boom', () => null)).toBeUndefined();
  });

  it('omits the property when the sanitizer returns a non-string', () => {
    expect(sanitizeErrorMessage('boom', () => undefined as unknown as string)).toBeUndefined();
    expect(sanitizeErrorMessage('boom', () => 42 as unknown as string)).toBeUndefined();
  });

  it('fails closed when the sanitizer throws — never falls back to the raw message', () => {
    const thrower = () => {
      throw new Error('sanitizer bug');
    };
    expect(sanitizeErrorMessage('user@example.com', thrower)).toBeUndefined();
  });

  it('passes the raw message to the sanitizer exactly once', () => {
    const spy = vi.fn(() => 'clean');
    sanitizeErrorMessage('raw', spy);
    expect(spy).toHaveBeenCalledExactlyOnceWith('raw');
  });
});

const PII = 'No subscriber found for "jane@example.com"';

function makeAnalytics(config?: MCPAnalyticsConfig) {
  const tracked: AmplitudeEvent[] = [];
  const analytics = new AmplitudeMCPAnalytics({
    amplitude: { track: (e: AmplitudeEvent) => tracked.push(e), flush: () => undefined },
    serverName: 'test-mcp',
    serverVersion: '9.9.9',
    config,
  });
  return { analytics, tracked };
}

/** Minimal server double — enough for `instrumentServer` to bind a scope. */
function fakeServer() {
  const requestHandlers = new Map<string, unknown>();
  return {
    server: { getClientVersion: () => undefined, _requestHandlers: requestHandlers },
    connect: (_t: unknown): Promise<void> => Promise.resolve(),
    isConnected: () => false,
  };
}

const stdioTransport = { start: async () => {}, send: async () => {}, close: async () => {} };

/** Run one instrumented tool that fails in-band, returning the emitted event. */
async function callFailingTool(config?: MCPAnalyticsConfig): Promise<AmplitudeEvent | undefined> {
  const { analytics, tracked } = makeAnalytics(config);
  const server = fakeServer();
  analytics.instrumentServer(server as unknown as McpServer, { userId: 'user-1' });
  await server.connect(stdioTransport);

  const tool = analytics.instrumentTool(
    async (_args: Record<string, unknown>, _extra: unknown) => ({
      content: [{ type: 'text' as const, text: PII }],
      isError: true,
    }),
    { name: 'lookup' },
  );
  await tool({}, { requestId: 1 });

  return tracked.find((e) => e.event_type === '[MCP] Tool Call Response');
}

describe('sanitizeErrorMessage — [MCP] Tool Call Response', () => {
  it('emits the raw result text by default (documented v0 behavior)', async () => {
    const event = await callFailingTool();
    expect(event?.event_properties?.['[MCP] Error Message']).toBe(PII);
  });

  it('emits the sanitizer’s rewrite instead of the result text', async () => {
    const event = await callFailingTool(
      new MCPAnalyticsConfig({
        sanitizeErrorMessage: (m) => m.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '<email>'),
      }),
    );
    expect(event?.event_properties?.['[MCP] Error Message']).toBe(
      'No subscriber found for "<email>"',
    );
  });

  it('omits the property on null, keeping Error Code and Error Type', async () => {
    const event = await callFailingTool(
      new MCPAnalyticsConfig({ sanitizeErrorMessage: () => null }),
    );

    expect(event?.event_properties).not.toHaveProperty('[MCP] Error Message');
    // The segmentable classification is exactly what must survive.
    expect(event?.event_properties?.['[MCP] Error Type']).toBe('returned_error');
    expect(event?.event_properties?.['[MCP] Is Error']).toBe(true);
  });

  it('omits the property when the sanitizer throws, and still emits the event', async () => {
    const event = await callFailingTool(
      new MCPAnalyticsConfig({
        sanitizeErrorMessage: () => {
          throw new Error('sanitizer bug');
        },
      }),
    );

    expect(event).toBeDefined();
    expect(event?.event_properties).not.toHaveProperty('[MCP] Error Message');
    expect(event?.event_properties?.['[MCP] Is Error']).toBe(true);
  });

  it('leaves a successful call untouched — the sanitizer never runs', async () => {
    const spy = vi.fn((m: string) => m);
    const { analytics, tracked } = makeAnalytics(
      new MCPAnalyticsConfig({ sanitizeErrorMessage: spy }),
    );
    const server = fakeServer();
    analytics.instrumentServer(server as unknown as McpServer, { userId: 'user-1' });
    await server.connect(stdioTransport);

    const tool = analytics.instrumentTool(
      async (_args: Record<string, unknown>, _extra: unknown) => ({
        content: [{ type: 'text' as const, text: 'ok' }],
      }),
      { name: 'ok' },
    );
    await tool({}, { requestId: 1 });

    expect(spy).not.toHaveBeenCalled();
    const event = tracked.find((e) => e.event_type === '[MCP] Tool Call Response');
    expect(event?.event_properties).not.toHaveProperty('[MCP] Error Message');
  });
});

describe('MCPAnalyticsConfig.sanitizeErrorMessage', () => {
  it('is undefined by default', () => {
    expect(new MCPAnalyticsConfig().sanitizeErrorMessage).toBeUndefined();
  });

  it('retains a supplied function', () => {
    const fn = (m: string) => m;
    expect(new MCPAnalyticsConfig({ sanitizeErrorMessage: fn }).sanitizeErrorMessage).toBe(fn);
  });

  it('ignores a non-function value rather than crashing at emit time', () => {
    const config = new MCPAnalyticsConfig({
      sanitizeErrorMessage: 'nope' as unknown as (m: string) => string,
    });
    expect(config.sanitizeErrorMessage).toBeUndefined();
  });
});
