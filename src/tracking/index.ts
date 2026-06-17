/**
 * Public surface of the tracking module — the custom event API.
 * Also re-exported from the root `@amplitude/mcp-analytics` entry point;
 * the subpath import (`@amplitude/mcp-analytics/tracking`) is the stable home
 * for callers who want the tracking helpers without the full client.
 */
export {
  ctxToAmplitudeFields,
  ctxToAmplitudeFieldsForTool,
  shouldEmit,
} from './ctx-to-properties.js';
export { trackServerEvent } from './track-server-event.js';
export { trackToolEvent } from './track-tool-event.js';
// Tool instrumentation is the `AmplitudeMCPAnalytics.instrumentTool` method; the
// standalone factory in ./instrument-tool.js is internal.
export type { AmplitudeFields } from './types.js';
