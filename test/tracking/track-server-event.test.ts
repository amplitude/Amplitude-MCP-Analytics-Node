import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createServerContext } from '../../src/context/index.js';
import { trackServerEvent } from '../../src/tracking/track-server-event.js';
import type { AmplitudeClientLike, AmplitudeEvent } from '../../src/types.js';

function makeAmplitude(): { client: AmplitudeClientLike; tracked: AmplitudeEvent[] } {
  const tracked: AmplitudeEvent[] = [];
  return {
    tracked,
    client: {
      track: (e) => {
        tracked.push(e);
      },
      flush: () => undefined,
    },
  };
}

function resolvedCtx(overrides: Parameters<typeof createServerContext>[0] | undefined = undefined) {
  return createServerContext({
    server: { name: 'my-server', version: '1.0.0' },
    transport: 'streamable-http',
    identity: { userId: 'u1', resolvedFrom: 'userId' },
    tenant: { groupType: 'org id', groupValue: '36958' },
    anchor: { type: 'session-id', value: 'sess-1' },
    ...overrides,
  });
}

describe('trackServerEvent', () => {
  it('emits an event with the configured name and inherited ctx properties', () => {
    const { client, tracked } = makeAmplitude();
    trackServerEvent(client, resolvedCtx(), 'mcp: custom server event');

    expect(tracked).toHaveLength(1);
    const event = tracked[0]!;
    expect(event.event_type).toBe('mcp: custom server event');
    expect(event.user_id).toBe('u1');
    expect(event.groups).toEqual({ 'org id': '36958' });
    expect(event.event_properties).toMatchObject({
      'session id': 'sess-1',
      'server name': 'my-server',
      'client name': 'unknown',
      'identity resolved from': 'userId',
      'org id': '36958',
    });
  });

  it('merges caller-supplied properties with ctx-derived ones, caller wins on collision', () => {
    const { client, tracked } = makeAmplitude();
    trackServerEvent(client, resolvedCtx(), 'mcp: custom server event', {
      'query type': 'cohort',
      // Override a ctx-derived property — caller wins.
      'client name': 'custom-client-name',
    });

    const event = tracked[0]!;
    expect(event.event_properties?.['query type']).toBe('cohort');
    expect(event.event_properties?.['client name']).toBe('custom-client-name');
    // Other ctx-derived properties still present.
    expect(event.event_properties?.['session id']).toBe('sess-1');
  });

  it('drops emission when identity is anonymous AND no tenant (audit §2 skip rule)', () => {
    const { client, tracked } = makeAmplitude();
    const ctx = createServerContext({ server: { name: 'my-server' }, transport: 'stdio' });
    trackServerEvent(client, ctx, 'mcp: never emitted');

    expect(tracked).toHaveLength(0);
  });

  it('emits when tenant is set even with anonymous identity (e.g. auth org mismatch path)', () => {
    const { client, tracked } = makeAmplitude();
    const ctx = createServerContext({
      server: { name: 'my-server' },
      transport: 'streamable-http',
      tenant: { groupType: 'org id', groupValue: '36958' },
    });
    trackServerEvent(client, ctx, 'mcp: auth org mismatch');

    expect(tracked).toHaveLength(1);
  });

  it('swallows underlying client errors and never throws (best-effort isolation)', () => {
    const warnings: string[] = [];
    const client: AmplitudeClientLike = {
      track: () => {
        throw new Error('amplitude broke');
      },
      flush: () => undefined,
      configuration: { loggerProvider: { debug: () => undefined, error: () => undefined, info: () => undefined, warn: (m: string) => warnings.push(m) } },
    };

    expect(() =>
      trackServerEvent(client, resolvedCtx(), 'mcp: failing event'),
    ).not.toThrow();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/mcp: failing event/);
    expect(warnings[0]).toMatch(/amplitude broke/);
  });

  it('emits ctx.extra values (host-domain enrichment) onto event_properties', () => {
    const { client, tracked } = makeAmplitude();
    const ctx = resolvedCtx({
      server: { name: 'my-server' },
      transport: 'streamable-http',
      identity: { userId: 'u1', resolvedFrom: 'userId' },
      extra: { 'org url': 'amplitude', 'user email': 'a@b.com' },
    });
    trackServerEvent(client, ctx, 'mcp: enriched event');

    const event = tracked[0]!;
    expect(event.event_properties?.['org url']).toBe('amplitude');
    expect(event.event_properties?.['user email']).toBe('a@b.com');
  });

  it('caller properties win over ctx.extra values (precedence chain: typed < extra < caller)', () => {
    const { client, tracked } = makeAmplitude();
    const ctx = resolvedCtx({
      server: { name: 'my-server' },
      transport: 'streamable-http',
      identity: { userId: 'u1', resolvedFrom: 'userId' },
      extra: { 'user email': 'from-extra@x.com' },
    });
    trackServerEvent(client, ctx, 'mcp: collision', { 'user email': 'from-caller@x.com' });

    expect(tracked[0]?.event_properties?.['user email']).toBe('from-caller@x.com');
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });
});
