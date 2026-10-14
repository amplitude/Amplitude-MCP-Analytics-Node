/**
 * Opt-in `submit_feedback` tool. `instrumentServer` does not register it;
 * `registerFeedbackTool` does, and only on a high-level `McpServer`.
 *
 * The handler builds a tool-scope context and emits `[MCP] Feedback Submitted`.
 * It is not wrapped in `instrumentTool`, so the call does not also emit
 * `[MCP] Tool Call Response`.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ErrorMessageSanitizer } from '../config.js';
import { runWithContext } from '../context/als.js';
import type { ClientInfoResolver, McpServerContext } from '../context/types.js';
import type { ServerIdentity } from './identity.js';
import { buildToolContext } from './build-context.js';
import { lookupRegisteredTool, type McpExtra, type McpServerLike } from './mcp.js';
import { markToolCallDispatched } from './tool-call-hook.js';
import type { AmplitudeClientLike } from '../types.js';
import type { Logger } from '../utils/logger.js';
import { getLogger } from '../utils/logger.js';
import {
  FEEDBACK_COMMENT_MAX,
  FEEDBACK_TOOLS_MAX,
} from '../tracking/constants.js';
import { emitFeedbackSubmitted } from '../tracking/events/feedback-submitted.js';
import { sanitizeErrorMessage } from '../tracking/sanitize-error-message.js';

/** Default tool name. Plain on purpose: agents match it more reliably than a prefixed name. */
export const FEEDBACK_TOOL_NAME = 'submit_feedback';

export const FEEDBACK_TOOL_TITLE = 'Submit feedback on this server';

/**
 * Why the result did not help, when the user indicated a reason.
 * Closed set — a value outside it is dropped rather than emitted.
 */
export const FEEDBACK_REASONS = [
  'wrong_result',
  'incomplete',
  'too_slow',
  'wrong_tool',
  'missing_capability',
  'other',
] as const;

export type FeedbackReason = (typeof FEEDBACK_REASONS)[number];

/** Static tool result. Never echoes the arguments back to the model. */
export const FEEDBACK_RECORDED_TEXT =
  'Feedback recorded. Thank the user briefly and continue. Do not ask for feedback again in this conversation unless the user raises it.';

const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const REASON_SET: ReadonlySet<string> = new Set(FEEDBACK_REASONS);

export interface FeedbackToolAnnotations {
  readonly readOnlyHint: false;
  readonly destructiveHint: false;
  readonly idempotentHint: false;
  readonly openWorldHint: true;
}

/** Hints for hosts that show an approval dialog on non-read-only tools. */
export const FEEDBACK_TOOL_ANNOTATIONS: FeedbackToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

export interface FeedbackJsonSchemaProperty {
  type: 'boolean' | 'string' | 'array';
  description: string;
  enum?: readonly FeedbackReason[];
  maxLength?: number;
  maxItems?: number;
  items?: { readonly type: 'string' };
}

/** JSON Schema for the tool input. Plain data — the MCP SDK registration uses a Zod shape built from the same fields. */
export interface FeedbackInputJsonSchema {
  type: 'object';
  properties: Record<string, FeedbackJsonSchemaProperty>;
  required: readonly ['helpful'];
  additionalProperties: false;
}

export interface FeedbackToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: FeedbackInputJsonSchema;
  annotations: FeedbackToolAnnotations;
}

export interface RegisterFeedbackToolOptions {
  /**
   * Tool name advertised to the agent. Default `submit_feedback`.
   * Must be 1–64 characters of letters, numbers, underscores, or hyphens.
   * An invalid name is not registered.
   */
  name?: string;
  /**
   * Accept an optional `comment` argument and emit `[MCP] Feedback Comment`.
   * Default false: the field is omitted from the schema, and a comment that
   * arrives anyway is dropped.
   */
  captureComment?: boolean;
  /**
   * Replaces the default tool description entirely. The description is the
   * instruction the agent follows, so a replacement should still say when to
   * call the tool and that the rating must be the user's, not the agent's.
   */
  description?: string;
}

export interface CreateFeedbackToolHandlerOptions extends RegisterFeedbackToolOptions {
  /**
   * Server whose registered tool names are checked against the `tools`
   * argument. Names that are not registered are dropped. When omitted, or
   * when the registry cannot be read, `tools` is left off the event.
   */
  server?: object;
}

/** Dependencies the handler needs from the analytics client. @internal */
export interface FeedbackToolDependencies {
  amplitude: AmplitudeClientLike;
  getServerCtx: () => McpServerContext | undefined;
  getServerIdentity: () => ServerIdentity | undefined;
  getClientInfoResolver: () => ClientInfoResolver | undefined;
  sanitizeErrorMessage?: ErrorMessageSanitizer;
  logger?: Logger;
}

const HELPFUL_DESCRIPTION =
  'Whether the result actually helped the user. True only when the user indicated it helped; false when they indicated it did not.';
const REASON_DESCRIPTION =
  'Why it did not help, when the user indicated a reason. Omit when they did not say.';
const COMMENT_DESCRIPTION =
  "The user's own words, only when they offered a comment and agreed to share it. At most 500 characters.";
const TOOLS_DESCRIPTION =
  "Names of this server's tools the feedback is about, if the user named any.";
const SOLICITED_DESCRIPTION =
  'True when you asked the user whether it helped; false when they volunteered the reaction.';

function defaultDescription(captureComment: boolean): string {
  const fields = captureComment
    ? 'Set helpful to whether it helped, set reason when it did not, and set comment only when the user offered a short comment in their own words and agreed to share it. Submitting sends only those fields.'
    : 'Set helpful to whether it helped, and set reason when it did not. Submitting sends only those fields.';
  return [
    "Record whether the help provided through this server's tools actually worked for the user.",
    'Call this when the user reacts to a result from this server, positively ("thanks, that\'s it", "perfect") or negatively ("that\'s wrong", "not what I asked", "this didn\'t work"), or when the user explicitly asks to give feedback.',
    "After you finish a multi-step task that relied on this server's tools, you may ask the user once, briefly, whether the result was helpful, and call this with their answer.",
    'Do not ask if they already indicated it, and never more than once per task.',
    'Report only what the user actually expressed; do not infer a rating from your own judgment of the result.',
    fields,
    'No conversation content is sent.',
    'This is never required for the task to succeed.',
  ].join(' ');
}

/**
 * Paragraph to append to the server's `instructions` at construction time.
 * Uses `toolName` so a renamed tool is still named in the instructions.
 */
export function feedbackToolInstructions(toolName: string = FEEDBACK_TOOL_NAME): string {
  return `This server provides a ${toolName} tool. When the user reacts to a result from this server, or explicitly asks to give feedback, call ${toolName} with what they expressed. You may ask once, briefly, after finishing a multi-step task that used this server's tools. Do not ask more than once per task, and do not infer a rating the user did not express.`;
}

/** Default instructions, for a server that keeps the default tool name. */
export const FEEDBACK_TOOL_INSTRUCTIONS = feedbackToolInstructions();

function inputJsonSchema(captureComment: boolean): FeedbackInputJsonSchema {
  const properties: Record<string, FeedbackJsonSchemaProperty> = {
    helpful: { type: 'boolean', description: HELPFUL_DESCRIPTION },
    reason: { type: 'string', description: REASON_DESCRIPTION, enum: FEEDBACK_REASONS },
    tools: {
      type: 'array',
      description: TOOLS_DESCRIPTION,
      items: { type: 'string' },
      maxItems: FEEDBACK_TOOLS_MAX,
    },
    solicited: { type: 'boolean', description: SOLICITED_DESCRIPTION },
  };
  if (captureComment) {
    properties.comment = {
      type: 'string',
      description: COMMENT_DESCRIPTION,
      maxLength: FEEDBACK_COMMENT_MAX,
    };
  }
  return {
    type: 'object',
    properties,
    required: ['helpful'],
    additionalProperties: false,
  };
}

/** Zod raw shape accepted by `McpServer.registerTool`. Not part of the published definition, which stays JSON Schema. */
function feedbackInputShape(captureComment: boolean): Record<string, z.ZodTypeAny> {
  return {
    helpful: z.boolean().describe(HELPFUL_DESCRIPTION),
    reason: z.enum(FEEDBACK_REASONS).optional().describe(REASON_DESCRIPTION),
    ...(captureComment
      ? { comment: z.string().max(FEEDBACK_COMMENT_MAX).optional().describe(COMMENT_DESCRIPTION) }
      : {}),
    tools: z.array(z.string()).max(FEEDBACK_TOOLS_MAX).optional().describe(TOOLS_DESCRIPTION),
    solicited: z.boolean().optional().describe(SOLICITED_DESCRIPTION),
  };
}

export interface ResolvedFeedbackTool {
  name: string;
  captureComment: boolean;
  description: string;
  definition: FeedbackToolDefinition;
}

/**
 * Resolve registration options into the tool definition.
 * Returns `undefined` for the name when `name` was provided and is not a valid tool name.
 */
export function resolveFeedbackTool(options?: RegisterFeedbackToolOptions): ResolvedFeedbackTool | undefined {
  const requested = options?.name;
  const name = requested == null ? FEEDBACK_TOOL_NAME : TOOL_NAME_PATTERN.test(requested) ? requested : undefined;
  if (name == null) return undefined;

  const captureComment = options?.captureComment === true;
  const custom = options?.description;
  const description =
    typeof custom === 'string' && custom.trim().length > 0 ? custom : defaultDescription(captureComment);

  return {
    name,
    captureComment,
    description,
    definition: {
      name,
      title: FEEDBACK_TOOL_TITLE,
      description,
      inputSchema: inputJsonSchema(captureComment),
      annotations: FEEDBACK_TOOL_ANNOTATIONS,
    },
  };
}

/** Definition for the default tool (`submit_feedback`, comment capture off). */
export const FEEDBACK_TOOL_DEFINITION: FeedbackToolDefinition = {
  name: FEEDBACK_TOOL_NAME,
  title: FEEDBACK_TOOL_TITLE,
  description: defaultDescription(false),
  inputSchema: inputJsonSchema(false),
  annotations: FEEDBACK_TOOL_ANNOTATIONS,
};

/** Definition for a non-default name, description, or comment capture. */
export function feedbackToolDefinition(options?: RegisterFeedbackToolOptions): FeedbackToolDefinition | undefined {
  return resolveFeedbackTool(options)?.definition;
}

function recordedResult(): CallToolResult {
  return { content: [{ type: 'text', text: FEEDBACK_RECORDED_TEXT }] };
}

function invalidHelpfulResult(): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: 'helpful is required and must be a boolean.' }],
  };
}

function registeredToolNames(server: object | undefined): ReadonlySet<string> | undefined {
  if (server == null) return undefined;
  const registry = (server as { _registeredTools?: unknown })._registeredTools;
  if (registry == null || typeof registry !== 'object') return undefined;
  return new Set(Object.keys(registry as Record<string, unknown>));
}

function filterToolNames(value: unknown, known: ReadonlySet<string> | undefined): string[] | undefined {
  if (known == null || !Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !known.has(item) || out.includes(item)) continue;
    out.push(item);
    if (out.length === FEEDBACK_TOOLS_MAX) break;
  }
  return out.length > 0 ? out : undefined;
}

function readReason(value: unknown): FeedbackReason | undefined {
  return typeof value === 'string' && REASON_SET.has(value) ? (value as FeedbackReason) : undefined;
}

function readComment(
  value: unknown,
  captureComment: boolean,
  sanitize: ErrorMessageSanitizer | undefined,
): { hasComment: boolean; comment?: string } {
  if (!captureComment || typeof value !== 'string') return { hasComment: false };
  const capped = value.slice(0, FEEDBACK_COMMENT_MAX);
  if (capped.trim().length === 0) return { hasComment: false };
  const sanitized = sanitizeErrorMessage(capped, sanitize);
  if (sanitized == null) return { hasComment: true };
  const bounded = sanitized.slice(0, FEEDBACK_COMMENT_MAX);
  if (bounded.trim().length === 0) return { hasComment: true };
  return { hasComment: true, comment: bounded };
}

function asArgs(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Build the tool callback. Returns the static recorded result even when
 * analytics is off, so a missing `instrumentServer` never breaks the tool.
 *
 * @internal The supported constructor is {@link createFeedbackToolHandler}
 * on the client module, which supplies these dependencies.
 */
export function createFeedbackHandler(
  deps: FeedbackToolDependencies,
  options?: CreateFeedbackToolHandlerOptions,
): (args: Record<string, unknown>, extra: McpExtra) => CallToolResult {
  const resolved = resolveFeedbackTool(options) ?? resolveFeedbackTool();
  const tool = resolved ?? {
    name: FEEDBACK_TOOL_NAME,
    captureComment: false,
    description: defaultDescription(false),
    definition: FEEDBACK_TOOL_DEFINITION,
  };
  const logger = deps.logger ?? getLogger(deps.amplitude);
  let warnedUnbound = false;

  return (args, extra) => {
    // Reached a callback, so the rejection hook must not also emit.
    markToolCallDispatched(extra);

    const result = recordedResult();
    const input = asArgs(args);
    if (typeof input.helpful !== 'boolean') return invalidHelpfulResult();

    const serverCtx = deps.getServerCtx();
    if (serverCtx === undefined) {
      if (!warnedUnbound) {
        warnedUnbound = true;
        logger.warn(
          `AmplitudeMCPAnalytics: registerFeedbackTool('${tool.name}') ran without instrumentServer(); the tool still responds, but no [MCP] Feedback Submitted event is emitted. Call instrumentServer(server) before connect() to enable tracking.`,
        );
      }
      return result;
    }

    try {
      const ctx = buildToolContext(serverCtx, { name: tool.name }, extra ?? ({} as McpExtra), {
        resolveClientInfo: deps.getClientInfoResolver(),
        serverIdentity: deps.getServerIdentity(),
        logger,
      });
      const comment = readComment(input.comment, tool.captureComment, deps.sanitizeErrorMessage);

      runWithContext(ctx, () => {
        emitFeedbackSubmitted(deps.amplitude, ctx, {
          helpful: input.helpful as boolean,
          reason: readReason(input.reason),
          solicited: typeof input.solicited === 'boolean' ? input.solicited : undefined,
          toolNames: filterToolNames(input.tools, registeredToolNames(options?.server)),
          hasComment: comment.hasComment,
          comment: comment.comment,
        });
      });
    } catch (err) {
      logger.warn(
        `AmplitudeMCPAnalytics: submit_feedback ('${tool.name}') could not emit [MCP] Feedback Submitted: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    return result;
  };
}

function asHighLevelServer(server: McpServerLike): McpServer | undefined {
  const candidate = server as McpServer;
  return typeof candidate.registerTool === 'function' ? candidate : undefined;
}

/**
 * Register the feedback tool on a high-level `McpServer`. Warns and returns
 * the same server when the server is low-level, the name is invalid, or a
 * tool with that name is already registered. Does not throw.
 *
 * @internal Called by `AmplitudeMCPAnalytics.registerFeedbackTool`.
 */
export function registerFeedbackToolOnServer<S extends McpServerLike>(
  server: S,
  deps: FeedbackToolDependencies,
  options?: RegisterFeedbackToolOptions,
): S {
  const logger = deps.logger ?? getLogger(deps.amplitude);
  const highLevel = asHighLevelServer(server);
  if (highLevel == null) {
    logger.warn(
      'AmplitudeMCPAnalytics: registerFeedbackTool() requires an McpServer. A low-level Server has no tool registry to add to, so the feedback tool was not registered.',
    );
    return server;
  }

  if (options?.name != null && !TOOL_NAME_PATTERN.test(options.name)) {
    logger.warn(
      'AmplitudeMCPAnalytics: registerFeedbackTool() did not register a tool. name must be 1-64 characters of letters, numbers, underscores, or hyphens.',
    );
    return server;
  }

  const resolved = resolveFeedbackTool(options);
  if (resolved == null) return server;

  const existing = lookupRegisteredTool(highLevel, resolved.name);
  if (existing === 'enabled' || existing === 'disabled') {
    logger.warn(
      `AmplitudeMCPAnalytics: registerFeedbackTool() skipped registering '${resolved.name}' because that name is already on the server. Pass a different name to register one alongside it.`,
    );
    return server;
  }

  if (options?.description != null && options.description.trim().length === 0) {
    logger.warn(
      `AmplitudeMCPAnalytics: registerFeedbackTool('${resolved.name}') ignored an empty description and used the default.`,
    );
  }

  const handler = createFeedbackHandler(deps, { ...options, name: resolved.name, server });
  try {
    highLevel.registerTool(
      resolved.name,
      {
        title: resolved.definition.title,
        description: resolved.description,
        inputSchema: feedbackInputShape(resolved.captureComment),
        annotations: { ...FEEDBACK_TOOL_ANNOTATIONS },
      },
      handler,
    );
  } catch (err) {
    logger.warn(
      `AmplitudeMCPAnalytics: registerFeedbackTool() could not register '${resolved.name}': ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return server;
}
