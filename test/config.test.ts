import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAM_NEVER_KEYS, MCPAnalyticsConfig } from '../src/config.js';

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

describe('MCPAnalyticsConfig privacy', () => {
  it('redacts built-in PII by default and has no custom rules', () => {
    const config = new MCPAnalyticsConfig();
    expect(config.redactPii).toBe(true);
    expect(config.customRedactionPatterns).toEqual([]);
    expect(config.customRedactionFn).toBeNull();
  });

  it('honors opt-out, patterns, and a custom function', () => {
    const fn = (text: string) => text;
    const patterns = ['secret-\\d+', { pattern: '\\bACME-\\d+\\b', replacement: '[ticket]' }] as const;
    const config = new MCPAnalyticsConfig({
      redactPii: false,
      customRedactionPatterns: [...patterns],
      customRedactionFn: fn,
    });
    expect(config.redactPii).toBe(false);
    expect(config.customRedactionPatterns).toEqual([...patterns]);
    expect(config.customRedactionFn).toBe(fn);
    expect(config.toPrivacyConfig().redactText('user@x.com secret-9 ACME-4')).toBe(
      'user@x.com [REDACTED] [ticket]',
    );
  });

  it('ignores a non-function customRedactionFn and a non-array pattern list', () => {
    const config = new MCPAnalyticsConfig({
      customRedactionFn: 'nope' as unknown as (text: string) => string,
      customRedactionPatterns: 'nope' as unknown as string[],
    });
    expect(config.customRedactionFn).toBeNull();
    expect(config.customRedactionPatterns).toEqual([]);
  });
});

describe('MCPAnalyticsConfig parameter capture', () => {
  it('defaults shape on and excludes injected host metadata keys', () => {
    expect(new MCPAnalyticsConfig().paramCapture).toEqual({
      shape: true,
      neverKeys: DEFAULT_PARAM_NEVER_KEYS,
    });
  });

  it('accepts the shape off-switch and custom exclusions', () => {
    expect(
      new MCPAnalyticsConfig({
        paramCapture: { shape: false, neverKeys: ['private'] },
      }).paramCapture,
    ).toEqual({
      shape: false,
      neverKeys: ['private'],
    });
  });

  it('allows an empty exclusion list and drops invalid entries', () => {
    expect(
      new MCPAnalyticsConfig({ paramCapture: { neverKeys: [] } }).paramCapture
        .neverKeys,
    ).toEqual([]);
    expect(
      new MCPAnalyticsConfig({
        paramCapture: {
          neverKeys: ['safe', 42] as unknown as string[],
        },
      }).paramCapture.neverKeys,
    ).toEqual(['safe']);
  });
});
