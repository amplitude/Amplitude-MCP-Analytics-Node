import { describe, expect, it, vi } from 'vitest';
import type { ErrorMessageSanitizer } from '../../../src/config.js';
import { createServerContext, createToolContext } from '../../../src/context/index.js';
import { PrivacyConfig } from '../../../src/core/privacy.js';
import { emitToolCallResponse } from '../../../src/tracking/events/tool-call-response.js';
import { emitToolCallRejected } from '../../../src/tracking/events/tool-call-rejected.js';
import { emitToolsListed } from '../../../src/tracking/events/tools-listed.js';
import type { AmplitudeClientLike, AmplitudeEvent } from '../../../src/types.js';

describe.each(['response', 'listed', 'rejected'] as const)('normalized error message: %s', (kind) => {
  function emit(message?: string, sanitize?: ErrorMessageSanitizer, privacy?: PrivacyConfig) {
    const tracked: AmplitudeEvent[] = [];
    const amplitude: AmplitudeClientLike = {
      track: (event) => tracked.push(event),
      flush: () => undefined,
    };
    const ctx = createServerContext({
      server: { name: 'svc' },
      transport: 'stdio',
      identity: { resolvedFrom: 'explicit', userId: 'user-123' },
    });
    if (kind === 'response') {
      const tool = createToolContext(ctx, { name: 'lookup' });
      if (message !== undefined) {
        tool.error = { message, type: 'thrown_exception', fingerprint: 'existing-hash' };
      }
      emitToolCallResponse(amplitude, tool, { isToolError: message !== undefined, durationMs: 1 }, sanitize, privacy);
    } else {
      const outcome = { errorMessage: message, errorFingerprint: 'existing-hash' };
      if (kind === 'listed') {
        emitToolsListed(amplitude, ctx, { ...outcome, isError: true, toolCount: 0 }, sanitize, privacy);
      } else {
        emitToolCallRejected(amplitude, ctx, outcome, sanitize, privacy);
      }
    }
    expect(tracked).toHaveLength(1);
    return tracked[0]?.event_properties;
  }

  it('normalizes UUIDs, numbers and quoted strings in emitted messages', () => {
    const message = 'Record 550e8400-e29b-41d4-a716-446655440000 retry 42 "private"';
    const properties = emit(message);
    expect(properties?.['[MCP] Error Message Normalized']).toBe('Record <uuid> retry <n> "<str>"');
    expect(properties?.['[MCP] Error Fingerprint']).toBe('existing-hash');
  });

  it.each([undefined, ''])('omits normalized text when no message is available (%s)', (message) => {
    expect(emit(message)).not.toHaveProperty('[MCP] Error Message Normalized');
  });

  it('normalizes only the sanitizer replacement and calls the sanitizer once', () => {
    const sanitize = vi.fn(() => 'Safe replacement 99');
    const properties = emit('sensitive original', sanitize);
    expect(sanitize).toHaveBeenCalledExactlyOnceWith('sensitive original');
    expect(properties?.['[MCP] Error Message']).toBe('Safe replacement 99');
    expect(properties?.['[MCP] Error Message Normalized']).toBe('Safe replacement <n>');
    expect(JSON.stringify(properties)).not.toContain('sensitive original');
  });

  it.each([
    () => null,
    () => '',
    () => { throw new Error('sanitizer failed'); },
  ])('omits normalized text when the sanitizer drops, empties or fails', (sanitize) => {
    const properties = emit('sensitive original', sanitize);
    expect(properties).not.toHaveProperty('[MCP] Error Message Normalized');
    expect(properties?.['[MCP] Error Fingerprint']).toBe('existing-hash');
    expect(JSON.stringify(properties)).not.toContain('sensitive original');
  });

  it('applies built-in and custom content redaction to normalized text', () => {
    const properties = emit('Email jane@example.com secret', undefined, new PrivacyConfig({
      customRedactionFn: (text) => text.replace(/secret/g, '[hidden]'),
    }));
    const normalized = properties?.['[MCP] Error Message Normalized'];
    expect(normalized).not.toContain('jane@example.com');
    expect(normalized).not.toContain('secret');
    expect(normalized).toContain('[hidden]');
    expect(properties?.['[MCP] Error Fingerprint']).toBe('existing-hash');
  });
});
