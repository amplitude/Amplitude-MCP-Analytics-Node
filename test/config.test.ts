import { describe, expect, it } from 'vitest';
import { MCPAnalyticsConfig } from '../src/config.js';

describe('MCPAnalyticsConfig autocapture normalization', () => {
  it('defaults every family on when unset', () => {
    expect(new MCPAnalyticsConfig().autocapture).toEqual({ serverEvents: true, toolCalls: true });
  });

  it('treats `true` as all-on and `false` as all-off', () => {
    expect(new MCPAnalyticsConfig({ autocapture: true }).autocapture).toEqual({
      serverEvents: true,
      toolCalls: true,
    });
    expect(new MCPAnalyticsConfig({ autocapture: false }).autocapture).toEqual({
      serverEvents: false,
      toolCalls: false,
    });
  });

  it('toggles families independently, defaulting the omitted ones on', () => {
    expect(new MCPAnalyticsConfig({ autocapture: { serverEvents: false } }).autocapture).toEqual({
      serverEvents: false,
      toolCalls: true,
    });
    expect(new MCPAnalyticsConfig({ autocapture: { toolCalls: false } }).autocapture).toEqual({
      serverEvents: true,
      toolCalls: false,
    });
  });
});
