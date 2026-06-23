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
    expect(tracked[0]?.event_type).toBe('mcp: tool call response');
    expect(tracked[0]?.event_properties).toMatchObject({
      'is error': false,
      'response duration': 13, // rounded
      'tool name': 'search_docs', // ctx-derived
    });
    // No error keys on success, no size keys when absent.
    expect(tracked[0]?.event_properties).not.toHaveProperty('tool error message');
    expect(tracked[0]?.event_properties).not.toHaveProperty('request size');
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
      'request size': 40,
      'response size': 128,
    });
  });

  it('emits error message + classified type from ctx.error on failure', () => {
    const { client, tracked } = makeAmplitude();
    const ctx = toolCtx();
    ctx.error = buildToolError({ code: 'x', message: 'boom', type: 'thrown_exception' });
    emitToolCallResponse(client, ctx, { isToolError: true, durationMs: 1 });

    expect(tracked[0]?.event_properties).toMatchObject({
      'is error': true,
      'tool error message': 'boom',
      'tool error type': 'thrown_exception',
    });
  });

  it('emits a tool\'s `extra` enrichment as event properties', () => {
    const { client, tracked } = makeAmplitude();
    emitToolCallResponse(client, toolCtx({ name: 'search_docs', extra: { 'org url': 'amp' } }), okOutcome);

    expect(tracked[0]?.event_properties?.['org url']).toBe('amp');
  });

  it('lets the outcome props override a colliding `extra` value (SDK value wins)', () => {
    const { client, tracked } = makeAmplitude();
    const ctx = toolCtx({ name: 'search_docs', extra: { 'is error': 'bogus' } });
    emitToolCallResponse(client, ctx, okOutcome);

    expect(tracked[0]?.event_properties?.['is error']).toBe(false);
  });
});
