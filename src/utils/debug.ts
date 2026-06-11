// Vendored from amplitude/Amplitude-AI-Node @ 97ea346abd0caf333a3bafbd26b74de1d545f3e7
// Source: src/utils/debug.ts

import type { AmplitudeEvent } from '../types.js';

/**
 * Placeholder one-liner for the `debug` setting.
 * @internal Not part of the public package surface.
 */
export function formatDebugLine(event: AmplitudeEvent): string {
  return `[amplitude-mcp-analytics] ${event.event_type ?? 'unknown'}`;
}

/** @internal Not part of the public package surface. */
export function formatDryRunLine(event: unknown): string {
  try {
    return JSON.stringify(event);
  } catch {
    return String(event);
  }
}
