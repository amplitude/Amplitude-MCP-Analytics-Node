import { describe, expect, it } from 'vitest';
import { createServerContext } from '../../../src/context/index.js';
import { buildToolContext } from '../../../src/core/build-context.js';
import type { McpExtra } from '../../../src/core/mcp.js';
import type { McpToolContext } from '../../../src/context/types.js';
import type { McpToolMeta } from '../../../src/context/types.js';
import { buildToolError } from '../../../src/errors.js';
import { emitToolCallResponse } from '../../../src/tracking/events/tool-call-response.js';
import type { AmplitudeClientLike, AmplitudeEvent } from '../../../src/types.js';

function toolCtx(meta: McpToolMeta = { name: 'search_docs' }): McpToolContext {
  const server = createServerContext({
    server: { name: 'svc', version: '1.0.0' },
    transport: 'streamable-http',
    tenant: { groupType: 'org id', groupValue: '36958' },
  });
  return buildToolContext(server, meta, {} as McpExtra);
}

function makeAmplitude(): { client: AmplitudeClientLike; tracked: AmplitudeEvent[] } {
  const tracked: AmplitudeEvent[] = [];
  return { tracked, client: { track: (e) => tracked.push(e), flush: () => undefined } };
}

const okOutcome = { isToolError: false, durationMs: 12.7 };

describe('emitToolCallResponse', () => {
  it('emits the canonical outcome props plus the ctx-derived properties', () => {
    const { client, tracked } = makeAmplitude();
    emitToolCallResponse(client, toolCtx(), okOutcome);

    expect(tracked).toHaveLength(1);
    expect(tracked[0]?.event_type).toBe('[MCP] Tool Call Response');
    expect(tracked[0]?.event_properties).toMatchObject({
      '[MCP] Is Error': false,
      '[MCP] Response Duration': 13, // rounded
      '[MCP] Tool Name': 'search_docs', // ctx-derived
    });
    // No error keys on success, no size keys when absent.
    expect(tracked[0]?.event_properties).not.toHaveProperty('[MCP] Error Message');
    expect(tracked[0]?.event_properties).not.toHaveProperty('[MCP] Request Size');
  });

  it('includes request/response sizes when present', () => {
    const { client, tracked } = makeAmplitude();
    emitToolCallResponse(client, toolCtx(), {
      isToolError: false,
      durationMs: 5,
      requestSizeBytes: 40,
      responseSizeBytes: 128,
    });

    expect(tracked[0]?.event_properties).toMatchObject({
      '[MCP] Request Size': 40,
      '[MCP] Response Size': 128,
    });
  });

  it('emits error message + code + type from ctx.error on failure', () => {
    const { client, tracked } = makeAmplitude();
    const ctx = toolCtx();
    ctx.error = { code: 'thrown_exception', message: 'boom', type: 'thrown_exception' };
    emitToolCallResponse(client, ctx, { isToolError: true, durationMs: 1 });

    expect(tracked[0]?.event_properties).toMatchObject({
      '[MCP] Is Error': true,
      '[MCP] Error Message': 'boom',
      '[MCP] Error Code': 'thrown_exception',
      '[MCP] Error Type': 'thrown_exception',
    });
    expect(tracked[0]?.event_properties).not.toHaveProperty('[MCP] Error HTTP Status');
  });

  it('omits [MCP] Error Code when the classified error carries no code', () => {
    const { client, tracked } = makeAmplitude();
    const ctx = toolCtx();
    ctx.error = { message: 'boom', type: 'thrown_exception' };
    emitToolCallResponse(client, ctx, { isToolError: true, durationMs: 1 });

    expect(tracked[0]?.event_properties).toMatchObject({
      '[MCP] Error Message': 'boom',
      '[MCP] Error Type': 'thrown_exception',
    });
    expect(tracked[0]?.event_properties).not.toHaveProperty('[MCP] Error Code');
  });

  it('emits the host-supplied code from analytics.toolError as [MCP] Error Code', () => {
    const { client, tracked } = makeAmplitude();
    const ctx = toolCtx();
    ctx.error = buildToolError({ code: 'missing_chart_id', message: 'No chart ID.' });
    emitToolCallResponse(client, ctx, { isToolError: true, durationMs: 1 });

    expect(tracked[0]?.event_properties).toMatchObject({
      '[MCP] Error Code': 'missing_chart_id',
      // host-built errors are always in-band returned errors
      '[MCP] Error Type': 'returned_error',
    });
  });

  it('emits the error HTTP status when the error carries one', () => {
    const { client, tracked } = makeAmplitude();
    const ctx = toolCtx();
    ctx.error = buildToolError({
      code: 'upstream_denied',
      message: 'Access denied by upstream.',
      httpStatus: 403,
    });
    emitToolCallResponse(client, ctx, { isToolError: true, durationMs: 1 });

    expect(tracked[0]?.event_properties).toMatchObject({
      '[MCP] Is Error': true,
      '[MCP] Error HTTP Status': 403,
    });
  });

  it('emits [MCP] Rationale when the host set a rationale on the ctx', () => {
    const { client, tracked } = makeAmplitude();
    const ctx = toolCtx();
    ctx.request = { ...ctx.request, rationale: 'checking config before mutation' };
    emitToolCallResponse(client, ctx, okOutcome);

    expect(tracked[0]?.event_properties?.['[MCP] Rationale']).toBe(
      'checking config before mutation',
    );
  });

  it('emits a tool\'s `extra` enrichment as event properties', () => {
    const { client, tracked } = makeAmplitude();
    emitToolCallResponse(client, toolCtx({ name: 'search_docs', extra: { 'org url': 'amp' } }), okOutcome);

    expect(tracked[0]?.event_properties?.['org url']).toBe('amp');
  });

  it('lets the outcome props override a colliding `extra` value (SDK value wins)', () => {
    const { client, tracked } = makeAmplitude();
    const ctx = toolCtx({ name: 'search_docs', extra: { '[MCP] Is Error': 'bogus' } });
    emitToolCallResponse(client, ctx, okOutcome);

    expect(tracked[0]?.event_properties?.['[MCP] Is Error']).toBe(false);
  });
});
