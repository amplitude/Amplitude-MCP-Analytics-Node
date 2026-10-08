import { describe, expect, it } from 'vitest';

describe('smoke test: all public exports are defined', () => {
  it('main entry point exports all expected symbols', async (): Promise<void> => {
    const mod = await import('../src/index.js');

    // Client
    expect(mod.AmplitudeMCPAnalytics).toBeDefined();

    // Config
    expect(mod.MCPAnalyticsConfig).toBeDefined();
    expect(mod.DEFAULT_PARAM_NEVER_KEYS).toEqual(['rationale', 'context']);

    // Testing
    expect(mod.MockAmplitudeMCPAnalytics).toBeDefined();

    // Context
    expect(mod.createServerContext).toBeDefined();
    expect(mod.createToolContext).toBeDefined();
    expect(mod.runWithContext).toBeDefined();
    expect(mod.getCurrentContext).toBeDefined();

    // Tracking (custom event API)
    expect(mod.trackServerEvent).toBeDefined();
    expect(mod.trackToolEvent).toBeDefined();
    expect(mod.ctxToAmplitudeFields).toBeDefined();
    expect(mod.ctxToAmplitudeFieldsForTool).toBeDefined();
    expect(mod.shouldEmit).toBeDefined();
  });

  it('tracking subpath exposes the custom event API', async (): Promise<void> => {
    const tracking = await import('../src/tracking/index.js');
    expect(tracking.trackServerEvent).toBeDefined();
    expect(tracking.trackToolEvent).toBeDefined();
    expect(tracking.ctxToAmplitudeFields).toBeDefined();
    expect(tracking.ctxToAmplitudeFieldsForTool).toBeDefined();
    expect(tracking.shouldEmit).toBeDefined();
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

    // Instrumentation entry points are part of the public surface.
    expect(typeof mock.instrumentServer).toBe('function');
    expect(typeof mock.instrumentTool).toBe('function');
    expect(typeof mock.registerFeedbackTool).toBe('function');
    expect(typeof mock.setIdentity).toBe('function');
  });

  it('exports the opt-in feedback tool', async (): Promise<void> => {
    const mod = await import('../src/index.js');

    expect(mod.FEEDBACK_TOOL_NAME).toBe('submit_feedback');
    expect(mod.FEEDBACK_TOOL_DEFINITION.name).toBe('submit_feedback');
    expect(mod.FEEDBACK_TOOL_DEFINITION.inputSchema.properties).not.toHaveProperty('comment');
    expect(mod.FEEDBACK_TOOL_INSTRUCTIONS).toContain('submit_feedback');
    expect(typeof mod.feedbackToolDefinition).toBe('function');
    expect(typeof mod.feedbackToolInstructions).toBe('function');
    expect(typeof mod.createFeedbackToolHandler).toBe('function');
    expect(mod.FEEDBACK_REASONS).toContain('wrong_result');
  });
});
