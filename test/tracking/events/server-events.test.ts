import { describe, expect, it } from 'vitest';
import { createServerContext } from '../../../src/context/index.js';
import type { McpServerContext } from '../../../src/context/types.js';
import {
  emitSessionEnded,
  emitSessionInitialized,
  emitToolsListed,
} from '../../../src/tracking/events/index.js';
import type { AmplitudeClientLike, AmplitudeEvent } from '../../../src/types.js';

/** A server ctx with a real identity so the audit skip rule doesn't drop it. */
function serverCtx(overrides: Partial<McpServerContext> = {}): McpServerContext {
  return createServerContext({
    server: { name: 'svc', version: '1.0.0' },
    transport: 'stdio',
    identity: { resolvedFrom: 'explicit', userId: 'user-123' },
    client: { name: 'cursor', version: '0.40' },
    protocolVersion: '2025-11-25',
    authType: 'oauth',
    ...overrides,
  });
}

function makeAmplitude(): { client: AmplitudeClientLike; tracked: AmplitudeEvent[] } {
  const tracked: AmplitudeEvent[] = [];
  return { tracked, client: { track: (e) => tracked.push(e), flush: () => undefined } };
}

describe('emitSessionInitialized', () => {
  it('emits the event with ctx-derived reserved props', () => {
    const { client, tracked } = makeAmplitude();
    emitSessionInitialized(client, serverCtx());

    expect(tracked).toHaveLength(1);
    expect(tracked[0]?.event_type).toBe('mcp: session initialized');
    expect(tracked[0]?.event_properties).toMatchObject({
      'server name': 'svc',
      'client name': 'cursor',
      transport: 'stdio',
      'protocol version': '2025-11-25',
      'auth type': 'oauth',
    });
    expect(tracked[0]?.user_id).toBe('user-123');
  });

  it('is dropped when the ctx has neither identity nor tenant (skip rule)', () => {
    const { client, tracked } = makeAmplitude();
    emitSessionInitialized(
      client,
      createServerContext({ server: { name: 'svc' }, transport: 'stdio' }),
    );
    expect(tracked).toHaveLength(0);
  });
});

describe('emitSessionEnded', () => {
  it('rounds and emits session duration when provided', () => {
    const { client, tracked } = makeAmplitude();
    emitSessionEnded(client, serverCtx(), { durationMs: 1234.7 });

    expect(tracked[0]?.event_type).toBe('mcp: session ended');
    expect(tracked[0]?.event_properties?.['session duration']).toBe(1235);
  });

  it('omits session duration when unknown', () => {
    const { client, tracked } = makeAmplitude();
    emitSessionEnded(client, serverCtx());
    expect(tracked[0]?.event_properties).not.toHaveProperty('session duration');
  });
});

describe('emitToolsListed', () => {
  it('always emits is error + tool count, plus names/duration/size when present', () => {
    const { client, tracked } = makeAmplitude();
    emitToolsListed(client, serverCtx(), {
      isError: false,
      toolCount: 2,
      toolNames: ['search', 'create'],
      durationMs: 3.2,
      responseSizeBytes: 256,
    });

    expect(tracked[0]?.event_type).toBe('mcp: tools listed');
    expect(tracked[0]?.event_properties).toMatchObject({
      'is error': false,
      'tool count': 2,
      'tool names': ['search', 'create'],
      'response duration': 3,
      'response size': 256,
    });
  });

  it('emits is error + classified error on failure', () => {
    const { client, tracked } = makeAmplitude();
    emitToolsListed(client, serverCtx(), {
      isError: true,
      toolCount: 0,
      errorMessage: 'boom',
      errorType: 'thrown_exception',
    });

    expect(tracked[0]?.event_properties).toMatchObject({
      'is error': true,
      'tool count': 0,
      'error message': 'boom',
      'error type': 'thrown_exception',
    });
  });

  it('truncates tool names past the cap and flags it, keeping the true count', () => {
    const { client, tracked } = makeAmplitude();
    const names = Array.from({ length: 101 }, (_, i) => `t${i}`);
    emitToolsListed(client, serverCtx(), { isError: false, toolCount: names.length, toolNames: names });

    const props = tracked[0]?.event_properties;
    expect(props?.['tool count']).toBe(101); // true total preserved
    expect((props?.['tool names'] as string[]).length).toBe(100); // clipped to the cap
    expect(props?.['tool names truncated']).toBe(true);
  });

  it('does not set the truncated flag when the list fits', () => {
    const { client, tracked } = makeAmplitude();
    emitToolsListed(client, serverCtx(), { isError: false, toolCount: 2, toolNames: ['a', 'b'] });
    expect(tracked[0]?.event_properties).not.toHaveProperty('tool names truncated');
  });
});
