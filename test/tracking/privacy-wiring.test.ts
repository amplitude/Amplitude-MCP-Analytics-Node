import { afterEach, describe, expect, it } from 'vitest';
import { AmplitudeMCPAnalytics } from '../../src/client.js';
import { MCPAnalyticsConfig, type MCPAnalyticsConfigOptions } from '../../src/config.js';
import { _resetUnflushedState } from '../../src/core/delivery/index.js';
import { createServerContext } from '../../src/context/index.js';
import type { AmplitudeClientLike, AmplitudeEvent } from '../../src/types.js';

/**
 * End-to-end wiring: a privacy config on the client must redact free-form event
 * content (caller properties + ctx.extra) while leaving the typed identity and
 * dimension fields untouched.
 */
function makeAnalytics(privacy: MCPAnalyticsConfigOptions = {}) {
  const tracked: AmplitudeEvent[] = [];
  const amplitude: AmplitudeClientLike = {
    track: (e) => {
      tracked.push(e);
    },
    flush: () => undefined,
  };
  const analytics = new AmplitudeMCPAnalytics({
    amplitude,
    serverName: 'my-server',
    serverVersion: '1.0.0',
    config: new MCPAnalyticsConfig(privacy),
  });
  return { analytics, tracked };
}

/** Resolved server ctx whose identity/anchor deliberately *look* like PII. */
function resolvedCtx(extra?: Record<string, unknown>) {
  return createServerContext({
    server: { name: 'my-server', version: '1.0.0' },
    transport: 'streamable-http',
    // Email-shaped user id and IP-shaped session id — must NOT be redacted.
    identity: { userId: 'admin@corp.com', resolvedFrom: 'userId' },
    tenant: { groupType: 'org id', groupValue: '36958' },
    anchor: { type: 'session-id', value: '10.0.0.1' },
    ...(extra ? { extra } : {}),
  });
}

afterEach(() => {
  _resetUnflushedState();
});

describe('privacy wiring (client → emit seam)', () => {
  it('redacts PII in caller properties by default', () => {
    const { analytics, tracked } = makeAnalytics();
    analytics.trackServerEvent(resolvedCtx(), 'mcp: custom', {
      note: 'reach me at user@x.com',
      count: 3,
    });

    const props = tracked[0]?.event_properties ?? {};
    expect(props.note).toBe('reach me at [email]');
    // Non-string values pass through unchanged.
    expect(props.count).toBe(3);
  });

  it('redacts PII in ctx.extra enrichment by default', () => {
    const { analytics, tracked } = makeAnalytics();
    analytics.trackServerEvent(
      resolvedCtx({ 'user email': 'e@x.com', 'org url': 'amplitude' }),
      'mcp: enriched',
    );

    const props = tracked[0]?.event_properties ?? {};
    expect(props['user email']).toBe('[email]');
    expect(props['org url']).toBe('amplitude');
  });

  it('never redacts typed identity / dimension fields', () => {
    const { analytics, tracked } = makeAnalytics();
    analytics.trackServerEvent(resolvedCtx(), 'mcp: identity');

    const event = tracked[0]!;
    // Email-shaped user_id and IP-shaped session id survive verbatim —
    // redacting them would corrupt attribution.
    expect(event.user_id).toBe('admin@corp.com');
    expect(event.event_properties?.['session id']).toBe('10.0.0.1');
    expect(event.event_properties?.['server name']).toBe('my-server');
  });

  it('honors redactPii: false (opt-out leaves content intact)', () => {
    const { analytics, tracked } = makeAnalytics({ redactPii: false });
    analytics.trackServerEvent(resolvedCtx(), 'mcp: raw', {
      note: 'reach me at user@x.com',
    });

    expect(tracked[0]?.event_properties?.note).toBe('reach me at user@x.com');
  });

  it('applies custom redaction patterns to free-form content', () => {
    const { analytics, tracked } = makeAnalytics({
      redactPii: false,
      customRedactionPatterns: ['secret-\\d+'],
    });
    analytics.trackServerEvent(resolvedCtx(), 'mcp: custom-pattern', {
      token: 'secret-99',
    });

    expect(tracked[0]?.event_properties?.token).toBe('[REDACTED]');
  });

  it('redacts base64-image content in caller properties', () => {
    const { analytics, tracked } = makeAnalytics();
    analytics.trackServerEvent(resolvedCtx(), 'mcp: image', {
      avatar: 'data:image/png;base64,iVBOR',
    });

    expect(tracked[0]?.event_properties?.avatar).toBe('[base64 image redacted]');
  });
});
