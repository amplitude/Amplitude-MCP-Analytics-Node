import { describe, expect, it } from 'vitest';
import { MCPAnalyticsConfig } from '../src/config.js';

describe('MCPAnalyticsConfig autocapture normalization', () => {
  it('defaults every family on when unset', () => {
    expect(new MCPAnalyticsConfig().autocapture).toEqual({
      serverEvents: true,
      sessionLifecycle: true,
      toolsListed: true,
      toolCalls: true,
    });
  });

  it('treats `true` as all-on and `false` as all-off', () => {
    expect(new MCPAnalyticsConfig({ autocapture: true }).autocapture).toEqual({
      serverEvents: true,
      sessionLifecycle: true,
      toolsListed: true,
      toolCalls: true,
    });
    expect(new MCPAnalyticsConfig({ autocapture: false }).autocapture).toEqual({
      serverEvents: false,
      sessionLifecycle: false,
      toolsListed: false,
      toolCalls: false,
    });
  });

  it('toggles families independently, defaulting the omitted ones on', () => {
    expect(new MCPAnalyticsConfig({ autocapture: { serverEvents: false } }).autocapture).toEqual({
      serverEvents: false,
      sessionLifecycle: false,
      toolsListed: false,
      toolCalls: true,
    });
    expect(new MCPAnalyticsConfig({ autocapture: { toolCalls: false } }).autocapture).toEqual({
      serverEvents: true,
      sessionLifecycle: true,
      toolsListed: true,
      toolCalls: false,
    });
  });

  it('sub-families default to the serverEvents umbrella and override it independently', () => {
    // Umbrella off, one sub-family re-enabled — the per-request-server shape.
    expect(
      new MCPAnalyticsConfig({
        autocapture: { serverEvents: false, toolsListed: true },
      }).autocapture,
    ).toEqual({
      serverEvents: false,
      sessionLifecycle: false,
      toolsListed: true,
      toolCalls: true,
    });

    // Umbrella on (default), one sub-family opted out.
    expect(
      new MCPAnalyticsConfig({ autocapture: { sessionLifecycle: false } }).autocapture,
    ).toEqual({
      serverEvents: true,
      sessionLifecycle: false,
      toolsListed: true,
      toolCalls: true,
    });
  });
});

describe('MCPAnalyticsConfig emitAnonymousEvent', () => {
  it('defaults to false', () => {
    expect(new MCPAnalyticsConfig().emitAnonymousEvent).toBe(false);
    expect(new MCPAnalyticsConfig({}).emitAnonymousEvent).toBe(false);
  });

  it('honors an explicit true', () => {
    expect(new MCPAnalyticsConfig({ emitAnonymousEvent: true }).emitAnonymousEvent).toBe(true);
  });
});
