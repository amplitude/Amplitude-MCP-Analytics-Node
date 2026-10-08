export { AmplitudeMCPAnalytics, createFeedbackToolHandler, createMcpAnalytics } from './client.js';
export type {
  AmplitudeMCPAnalyticsOptions,
  CreateFeedbackToolHandlerOptions,
  InstrumentServerOptions,
  RegisterFeedbackToolOptions,
} from './client.js';
export {
  FEEDBACK_REASONS,
  FEEDBACK_TOOL_DEFINITION,
  FEEDBACK_TOOL_INSTRUCTIONS,
  FEEDBACK_TOOL_NAME,
  feedbackToolDefinition,
  feedbackToolInstructions,
} from './core/feedback-tool.js';
export type {
  FeedbackInputJsonSchema,
  FeedbackJsonSchemaProperty,
  FeedbackReason,
  FeedbackToolAnnotations,
  FeedbackToolDefinition,
} from './core/feedback-tool.js';
export { DEFAULT_PARAM_NEVER_KEYS, MCPAnalyticsConfig } from './config.js';
export type {
  AutocaptureConfig,
  MCPAnalyticsConfigOptions,
  ParamCaptureConfig,
} from './config.js';
export {
  createServerContext,
  createToolContext,
  getCurrentContext,
  runWithContext,
  setIdentity,
  setRationale,
} from './context/index.js';
export type {
  AnchorType,
  ClientInfoResolver,
  CreateServerContextInput,
  IdentityResolver,
  IdentityResolvedFrom,
  McpAnchor,
  McpCorrelation,
  McpClientInfo,
  McpEpisodeAnchorConfidence,
  McpEpisodeAnchorType,
  McpIdentity,
  McpRequestInfo,
  McpRequestMethod,
  McpServerContext,
  McpServerInfo,
  McpTenant,
  McpToolContext,
  McpToolMeta,
  McpTransport,
  ResolveClientInfoInput,
  SetIdentityInput,
  ToolParamCapture,
} from './context/index.js';
export { buildToolError, classifyError, toolErrorResult } from './errors.js';
export type { McpToolError, McpToolErrorType, ToolErrorInput } from './errors.js';
export { MockAmplitudeMCPAnalytics } from './testing.js';
export {
  ctxToAmplitudeFields,
  ctxToAmplitudeFieldsForTool,
  shouldEmit,
  trackServerEvent,
  trackToolEvent,
} from './tracking/index.js';
export type {
  AmplitudeFields,
  DefaultServerFields,
  DefaultToolFields,
  TrackEventOptions,
} from './tracking/index.js';
export type { AmplitudeClientLike, AmplitudeEvent } from './types.js';
