/**
 * End-to-end wiring: a privacy config on the client redacts free-form event
 * content and leaves typed identity and dimension fields untouched.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { AmplitudeMCPAnalytics } from '../../src/client.js';
import { MCPAnalyticsConfig, type MCPAnalyticsConfigOptions } from '../../src/config.js';
import { createServerContext, createToolContext } from '../../src/context/index.js';
import { REDACTED_IMAGE_PLACEHOLDER } from '../../src/core/privacy.js';
import { MockAmplitudeMCPAnalytics } from '../../src/testing.js';
import type { AmplitudeEvent } from '../../src/types.js';

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function makeAnalytics(privacy: MCPAnalyticsConfigOptions = {}) {
  return new MockAmplitudeMCPAnalytics({
    serverName: 'my-server',
    serverVersion: '1.0.0',
    config: new MCPAnalyticsConfig(privacy),
  });
}

function resolvedCtx(extra?: Record<string, unknown>) {
  return createServerContext({
    server: { name: 'my-server', version: '1.0.0' },
    transport: 'streamable-http',
    identity: { userId: 'admin@corp.com', resolvedFrom: 'explicit' },
    tenant: { groupType: 'org id', groupValue: '36958' },
    anchor: { type: 'session-id', value: '10.0.0.1' },
    ...(extra ? { extra } : {}),
  });
}

describe('privacy wiring (client → emit seam)', () => {
  it('redacts PII in caller properties and ctx.extra by default', () => {
    const analytics = makeAnalytics();
    analytics.trackServerEvent(resolvedCtx({ 'user email': 'e@x.com', 'org url': 'amplitude' }), 'mcp: custom', {
      note: 'reach me at user@x.com',
      count: 3,
      profile: { phone: 'Call (555) 123-4567' },
    });

    const props = analytics.events[0]?.event_properties ?? {};
    expect(props.note).toBe('reach me at [email]');
    expect(props.count).toBe(3);
    expect(props['user email']).toBe('[email]');
    expect(props['org url']).toBe('amplitude');
    expect(props.profile).toEqual({ phone: 'Call [phone]' });
  });

  it('never redacts typed identity or dimension fields', () => {
    const analytics = makeAnalytics();
    const ctx = createToolContext(resolvedCtx(), { name: 'user@example.com' }, {
      request: { rationale: 'email the user at user@x.com' },
    });
    analytics.trackToolEvent(ctx, 'mcp: identity', {
      '[MCP] Error Message': 'failed for user@x.com',
      '[MCP] Error Type': 'returned_error',
      '[MCP] Tool Name': 'user@example.com',
      '[MCP] Param: note': 'reach user@x.com',
    });

    const event = analytics.events[0]!;
    expect(event.user_id).toBe('admin@corp.com');
    expect(event.groups).toEqual({ 'org id': '36958' });
    expect(event.event_properties?.['[MCP] Session ID']).toBe('10.0.0.1');
    expect(event.event_properties?.['[MCP] Server Name']).toBe('my-server');
    expect(event.event_properties?.['[MCP] Tool Name']).toBe('user@example.com');
    expect(event.event_properties?.['[MCP] Error Type']).toBe('returned_error');
    expect(event.event_properties?.['[MCP] Rationale']).toBe('email the user at [email]');
    expect(event.event_properties?.['[MCP] Error Message']).toBe('failed for [email]');
    expect(event.event_properties?.['[MCP] Param: note']).toBe('reach [email]');
  });

  it('honors redactPii: false and still applies custom patterns and base64 replacement', () => {
    const analytics = makeAnalytics({
      redactPii: false,
      customRedactionPatterns: ['secret-\\d+'],
    });
    analytics.trackServerEvent(resolvedCtx(), 'mcp: raw', {
      note: 'reach me at user@x.com',
      token: 'secret-99',
      image: PNG_BASE64,
    });

    const props = analytics.events[0]?.event_properties ?? {};
    expect(props.note).toBe('reach me at user@x.com');
    expect(props.token).toBe('[REDACTED]');
    expect(props.image).toBe(REDACTED_IMAGE_PLACEHOLDER);
  });

  it('redacts base64-image content when built-in PII patterns are on', () => {
    const analytics = makeAnalytics();
    analytics.trackServerEvent(resolvedCtx(), 'mcp: image', {
      image: `data:image/png;base64,${PNG_BASE64}`,
    });
    expect(analytics.events[0]?.event_properties?.image).toBe(REDACTED_IMAGE_PLACEHOLDER);
  });
});

describe('privacy wiring (sanitizeErrorMessage runs first)', () => {
  function makeClient(config: MCPAnalyticsConfig) {
    const tracked: AmplitudeEvent[] = [];
    const analytics = new AmplitudeMCPAnalytics({
      amplitude: { track: (e: AmplitudeEvent) => tracked.push(e), flush: () => undefined },
      serverName: 'test-mcp',
      serverVersion: '9.9.9',
      config,
    });
    return { analytics, tracked };
  }

  const stdioTransport = { start: async () => {}, send: async () => {}, close: async () => {} };

  async function callFailingTool(config: MCPAnalyticsConfig) {
    const { analytics, tracked } = makeClient(config);
    const server = {
      server: { getClientVersion: () => ({ name: 'cursor', version: '0.40' }) },
      connect: (_t: unknown): Promise<void> => Promise.resolve(),
      isConnected: () => false,
    };
    analytics.instrumentServer(server as unknown as McpServer, { userId: 'user-1' });
    await server.connect(stdioTransport);
    const tool = analytics.instrumentTool(
      async (_args: Record<string, unknown>, _extra: unknown) => ({
        content: [{ type: 'text' as const, text: 'No subscriber found for "jane@example.com"' }],
        isError: true,
      }),
      { name: 'lookup' },
    );
    await tool({}, { requestId: 1 });
    return tracked.find((e) => e.event_type === '[MCP] Tool Call Response');
  }

  it('gives the sanitizer the raw message, then redacts whatever it returns', async () => {
    const spy = vi.fn((message: string) => message);
    const event = await callFailingTool(new MCPAnalyticsConfig({ sanitizeErrorMessage: spy }));
    expect(spy).toHaveBeenCalledExactlyOnceWith('No subscriber found for "jane@example.com"');
    expect(event?.event_properties?.['[MCP] Error Message']).toBe(
      'No subscriber found for "[email]"',
    );
  });

  it('omits the property when the sanitizer returns null, before redaction', async () => {
    const event = await callFailingTool(new MCPAnalyticsConfig({ sanitizeErrorMessage: () => null }));
    expect(event?.event_properties).not.toHaveProperty('[MCP] Error Message');
    expect(event?.event_properties?.['[MCP] Error Type']).toBe('returned_error');
  });
});
