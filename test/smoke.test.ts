import { describe, expect, it } from 'vitest';

describe('smoke test: all public exports are defined', () => {
  it('main entry point exports all expected symbols', async (): Promise<void> => {
    const mod = await import('../src/index.js');

    // Client
    expect(mod.AmplitudeMCPAnalytics).toBeDefined();

    // Config
    expect(mod.MCPAnalyticsConfig).toBeDefined();

    // Testing
    expect(mod.MockAmplitudeMCPAnalytics).toBeDefined();

    // Context
    expect(mod.createServerContext).toBeDefined();
    expect(mod.createToolContext).toBeDefined();
    expect(mod.runWithContext).toBeDefined();
    expect(mod.getCurrentContext).toBeDefined();
  });

  it('key classes can be instantiated', async (): Promise<void> => {
    const mod = await import('../src/index.js');

    // MCPAnalyticsConfig
    const config = new mod.MCPAnalyticsConfig();
    expect(config.debug).toBe(false);
    expect(config.dryRun).toBe(false);

    // MockAmplitudeMCPAnalytics
    const mock = new mod.MockAmplitudeMCPAnalytics({
      serverName: 'test-server',
      serverVersion: '0.0.0',
    });
    expect(mock.events).toEqual([]);
  });
});
