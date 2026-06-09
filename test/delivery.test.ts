import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MCPAnalyticsConfig } from '../src/config.js';
import {
  TrackingProxy,
  _resetShortIdWarned,
  _resetUnflushedState,
  getGlobalUnflushedCount,
  installTrackCounter,
  installTrackHook,
} from '../src/core/delivery/index.js';
import type { AmplitudeClientLike, AmplitudeEvent } from '../src/types.js';

type RawClient = AmplitudeClientLike & {
  track: ReturnType<typeof vi.fn<(event: AmplitudeEvent) => void>>;
  flush: ReturnType<typeof vi.fn<() => unknown>>;
  shutdown: ReturnType<typeof vi.fn<() => void>>;
  configuration?: { callback?: (...args: unknown[]) => void };
};

/** Minimal fake client; optionally exposes a mutable `configuration`. */
function makeRawClient(withConfiguration = false): RawClient {
  const raw: RawClient = {
    track: vi.fn<(event: AmplitudeEvent) => void>(),
    flush: vi.fn<() => unknown>(() => []),
    shutdown: vi.fn<() => void>(),
  };
  if (withConfiguration) raw.configuration = {};
  return raw;
}

/** Wire a proxy the same way the client constructor does: counter then hook. */
function buildProxy(raw: AmplitudeClientLike, config: MCPAnalyticsConfig) {
  const proxy = new TrackingProxy(raw);
  installTrackCounter(proxy);
  installTrackHook(proxy, config);
  return proxy;
}

const EVENT: AmplitudeEvent = { event_type: '[MCP] Test', user_id: 'user-123' };

describe('delivery layer', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetShortIdWarned();
    _resetUnflushedState();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  describe('dry-run', () => {
    it('skips the underlying track', () => {
      const raw = makeRawClient();
      const proxy = buildProxy(raw, new MCPAnalyticsConfig({ dryRun: true }));

      proxy.track(EVENT);

      expect(raw.track).not.toHaveBeenCalled();
    });

    it('does not count dry-run events as unflushed', () => {
      const raw = makeRawClient();
      const proxy = buildProxy(raw, new MCPAnalyticsConfig({ dryRun: true }));

      proxy.track(EVENT);

      // The hook sits outermost, so it short-circuits before the counter runs.
      expect(getGlobalUnflushedCount()).toBe(0);
      expect(proxy.trackCountSinceFlush).toBe(0);
    });
  });

  describe('debug', () => {
    it('emits a log line and still delivers', () => {
      const raw = makeRawClient();
      const proxy = buildProxy(raw, new MCPAnalyticsConfig({ debug: true }));

      proxy.track(EVENT);

      expect(raw.track).toHaveBeenCalledTimes(1);
      const logged = warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
      expect(logged).toContain('[MCP] Test');
      expect(logged).toContain('user=user-123');
    });
  });

  describe('short-id warning', () => {
    it('fires once per (field, value)', () => {
      const raw = makeRawClient();
      const proxy = buildProxy(raw, new MCPAnalyticsConfig());

      const warned = () =>
        warnSpy.mock.calls.filter((c: unknown[]) =>
          String(c[0]).includes('shorter than 5 characters'),
        ).length;

      proxy.track({ event_type: 'e', user_id: 'ab' });
      proxy.track({ event_type: 'e', user_id: 'ab' });
      expect(warned()).toBe(1);

      // A different value warns again.
      proxy.track({ event_type: 'e', user_id: 'cd' });
      expect(warned()).toBe(2);

      // A different field warns again.
      proxy.track({ event_type: 'e', device_id: 'xy' });
      expect(warned()).toBe(3);
    });
  });

  describe('delivery-failure callback', () => {
    it('surfaces 4xx/5xx and preserves an existing callback', () => {
      const raw = makeRawClient(true);
      const existing = vi.fn();
      // biome-ignore lint/style/noNonNullAssertion: created with configuration.
      raw.configuration!.callback = existing;

      buildProxy(raw, new MCPAnalyticsConfig());

      // biome-ignore lint/style/noNonNullAssertion: callback was composed above.
      raw.configuration!.callback!(EVENT, 500, 'boom');

      expect(existing).toHaveBeenCalledTimes(1);
      const logged = warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
      expect(logged).toContain('delivery failed');
      expect(logged).toContain('HTTP 500');
    });

    it('does not warn on a 2xx delivery', () => {
      const raw = makeRawClient(true);
      buildProxy(raw, new MCPAnalyticsConfig());

      // biome-ignore lint/style/noNonNullAssertion: callback was composed above.
      raw.configuration!.callback!(EVENT, 200, 'ok');

      const logged = warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
      expect(logged).not.toContain('delivery failed');
    });
  });

  describe('unflushed counter', () => {
    it('increments per track and resets after flush', () => {
      const raw = makeRawClient();
      const proxy = buildProxy(raw, new MCPAnalyticsConfig());

      proxy.track(EVENT);
      proxy.track(EVENT);
      proxy.track(EVENT);

      expect(getGlobalUnflushedCount()).toBe(3);
      expect(proxy.trackCountSinceFlush).toBe(3);
      expect(raw.track).toHaveBeenCalledTimes(3);

      proxy.flush();

      expect(getGlobalUnflushedCount()).toBe(0);
      expect(proxy.trackCountSinceFlush).toBe(0);
      expect(raw.flush).toHaveBeenCalledTimes(1);
    });

    it('settles the global counter on shutdown', () => {
      const raw = makeRawClient();
      const proxy = buildProxy(raw, new MCPAnalyticsConfig());

      proxy.track(EVENT);
      proxy.track(EVENT);
      expect(getGlobalUnflushedCount()).toBe(2);

      proxy.shutdown();

      expect(getGlobalUnflushedCount()).toBe(0);
      expect(raw.shutdown).toHaveBeenCalledTimes(1);
    });
  });
});
