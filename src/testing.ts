import { AmplitudeMCPAnalytics, type AmplitudeMCPAnalyticsOptions } from './client.js';
import type { AmplitudeEvent } from './types.js';

/**
 * In-memory test double for {@link AmplitudeMCPAnalytics}.
 *
 * Behaves like the real client but captures every emitted event in
 * {@link MockAmplitudeMCPAnalytics.events} instead of delivering to
 * Amplitude. Use this in unit tests to assert against the event
 * stream without network I/O or an API key.
 *
 * @example
 * ```typescript
 * import { MockAmplitudeMCPAnalytics } from '@amplitude/mcp-analytics/testing';
 *
 * const mock = new MockAmplitudeMCPAnalytics({
 *   serverName: 'test-server',
 *   serverVersion: '0.0.0',
 * });
 *
 * Pass `mock` wherever an AmplitudeMCPAnalytics instance is expected, then assert against the captured event stream.
 * expect(mock.getEvents('[MCP] Tool Invoked')).toHaveLength(1);
 * expect(mock.events).toHaveLength(1);
 * ```
 */
export class MockAmplitudeMCPAnalytics extends AmplitudeMCPAnalytics {
  readonly events: AmplitudeEvent[];

  constructor(options: Omit<AmplitudeMCPAnalyticsOptions, 'amplitude' | 'apiKey'>) {
    const captured: AmplitudeEvent[] = [];
    super({
      ...options,
      amplitude: {
        track: (event) => {
          captured.push(event);
        },
        flush: () => [],
        shutdown: () => { },
      },
    });
    this.events = captured;
  }

  /** Return events captured so far, optionally filtered by event_type. */
  getEvents(eventType?: string): AmplitudeEvent[] {
    if (eventType == null) return [...this.events];
    return this.events.filter((e) => e.event_type === eventType);
  }

  /** Drop all captured events. Useful between test cases. */
  reset(): void {
    this.events.length = 0;
  }
}
