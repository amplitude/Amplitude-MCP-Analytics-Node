// Vendored from amplitude/Amplitude-AI-Node @ 97ea346abd0caf333a3bafbd26b74de1d545f3e7
// Source: src/utils/debug.ts
// Adaptations: AI-Node's formatDebugLine keys off the AI event taxonomy
//              (EVENT_AI_RESPONSE, PROP_MODEL_NAME, …) to pretty-print each
//              event kind. The MCP event taxonomy doesn't exist yet (MCP-358 /
//              MCP-363), so there's nothing meaningful to decode — formatDebugLine
//              is a placeholder that emits only the event type for now.
//              formatDryRunLine is verbatim.

import type { AmplitudeEvent } from '../types.js';

/**
 * Placeholder one-liner for the `debug` setting.
 *
 * TODO: once the MCP event taxonomy lands, replace this with
 * an event-aware summary (per-event-type fields, as AI-Node does). Until those
 * events exist there is nothing to decode beyond the event type, so this is
 * deliberately minimal. The `debug` config flag and its call site already route
 * through here, so filling it in later is a one-function change.
 */
export function formatDebugLine(event: AmplitudeEvent): string {
  return `[amplitude-mcp-analytics] ${event.event_type ?? 'unknown'}`;
}

/** Full JSON dump for the `dryRun` setting, so nothing is hidden. */
export function formatDryRunLine(event: unknown): string {
  try {
    return JSON.stringify(event);
  } catch {
    return String(event);
  }
}
