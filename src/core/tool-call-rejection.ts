/**
 * Decide whether a `tools/call` request that never reached a tool callback was
 * rejected before dispatch — an unknown or disabled tool name, or schema
 * validation — and recover the JSON-RPC code when the SDK still carries it.
 *
 * ## Why this needs evidence rather than a shape check
 *
 * Through `@modelcontextprotocol/sdk` 1.20, the high-level `McpServer` threw an
 * `McpError` for each of those failures, so a throw was itself the signal. In
 * 1.21 the SDK wrapped its whole `tools/call` handler in a try/catch that
 * funnels every error through `createToolError()`, turning them into in-band
 * `isError` results. From that release on, a pre-dispatch rejection and a tool
 * reporting its own failure are the *same shape* at the handler boundary.
 *
 * The dispatch marker (`wasToolCallDispatched`) separates them whenever the tool
 * is instrumented, and callers must apply it first. It cannot speak for a tool
 * that was registered but never wrapped with `instrumentTool`, though — that
 * callback runs unseen, so an `isError` from it also arrives unmarked. Claiming
 * every unmarked `isError` as a rejection would mis-file those as protocol
 * failures, so this module requires positive evidence instead:
 *
 *   1. the attempted name is absent from (or disabled in) the server's tool
 *      registry — authoritative, and independent of message wording; or
 *   2. the message carries the `MCP error <code>:` prefix that `McpError`
 *      stamps on, which is what a schema-validation failure leaves behind.
 *
 * Anything else is treated as a tool's own error and left alone.
 */
import { classifyError, errorMessageFromResult, isErrorResult } from '../errors.js';
import type { RegisteredToolState, ServerResult } from './mcp.js';

/**
 * The `McpError` message format (`MCP error -32602: Tool x not found`). Matching
 * it is the only way to recover a code the SDK no longer reports structurally —
 * `createToolError()` keeps the text and discards `McpError.code`.
 */
const MCP_ERROR_PREFIX = /^MCP error (-?\d+):/;

/** JSON-RPC internal-error code, the fallback when no code is recoverable. */
const JSON_RPC_INTERNAL_ERROR = -32603;

/**
 * Why a `tools/call` was rejected, as a closed set the SDK assigns.
 *
 * The MCP SDK raises `InvalidParams` (`-32602`) for *every* pre-dispatch failure,
 * so `[MCP] Error Code` cannot tell them apart and the distinction survives only
 * in the message text — which `sanitizeErrorMessage` may rewrite or drop. This
 * carries it structurally instead, free of caller data either way.
 *
 * - `unknown_tool` — the requested name is not registered (hallucinated,
 *   mistyped, or since removed)
 * - `disabled_tool` — registered but turned off via `tool.disable()`
 * - `schema_validation` — the name resolved but the payload failed the tool's
 *   schema
 * - `unrecognized` — a pre-dispatch failure we cannot attribute further, e.g. on
 *   a low-level `Server` with no tool registry to consult
 */
export type RejectionReason =
  | 'unknown_tool'
  | 'disabled_tool'
  | 'schema_validation'
  | 'unrecognized';

/** A `tools/call` request rejected before any tool callback ran. */
export interface PreDispatchRejection {
  /** Message as the client saw it, prefix included (stable across SDK versions). */
  message: string;
  /** JSON-RPC code, when the SDK still carried it or the prefix yielded it. */
  jsonRpcCode?: number;
  /** Structured cause — see {@link RejectionReason}. */
  reason: RejectionReason;
}

/**
 * Wording the SDK uses for a schema rejection. Deliberately an alternation
 * rather than one phrase: upstream has already reworded this once (1.14's
 * `Invalid arguments for tool x` became `Input validation error: ...` by 1.21),
 * so matching several forms is what keeps the fallback working across releases.
 *
 * This is the sole route to `schema_validation` — a deliberate call, not an
 * oversight. The structural alternative (re-running the tool's stored
 * `inputSchema` against `params.arguments`, which would *prove* a validation
 * failure) was considered and rejected: it trades prose coupling for a deeper
 * read into `McpServer`'s private registry, whose shape is itself not frozen
 * (`callback` became `handler` in 1.30). If this wording drifts, the value
 * degrades to `unrecognized` rather than becoming wrong — see the docs note
 * under "Telling rejections apart". Revisit only with that tradeoff in mind.
 */
const VALIDATION_WORDING = /validation|invalid arguments|invalid structured content/i;

/**
 * Attribute a rejection, preferring the tool registry and using the SDK's own
 * wording only where the registry cannot answer.
 *
 * `enabled` deliberately does **not** imply `schema_validation`. The registry
 * proves the name resolved, not *why* the call failed, and `McpServer`'s handler
 * has other pre-dispatch throw paths for a live tool (task-support
 * misconfiguration, output-schema checks) with more likely to be added. Assuming
 * validation there would relabel any future cause as a schema problem — a
 * confidently wrong value, which is worse than an honest `unrecognized`.
 *
 * For the same reason wording is never allowed to overrule the registry: a tool
 * whose own message says "not found" must not become `unknown_tool` when the
 * registry says it is live.
 */
function attribute(
  registryState: RegisteredToolState | undefined,
  message: string | undefined,
): RejectionReason {
  if (registryState === 'missing') return 'unknown_tool';
  if (registryState === 'disabled') return 'disabled_tool';

  if (message != null) {
    if (VALIDATION_WORDING.test(message)) return 'schema_validation';
    // Only with no registry to consult are these the best available evidence.
    if (registryState == null) {
      if (/\bnot found\b/i.test(message)) return 'unknown_tool';
      if (/\bdisabled\b/i.test(message)) return 'disabled_tool';
    }
  }
  return 'unrecognized';
}

/** The `MCP error <code>:` code, when the text carries one. */
function readMcpErrorCode(text: string | undefined): number | undefined {
  const match = text?.match(MCP_ERROR_PREFIX);
  if (match?.[1] == null) return undefined;
  const code = Number(match[1]);
  return Number.isSafeInteger(code) ? code : undefined;
}

/**
 * Classify one settled `tools/call` outcome, for a request already known not to
 * have been dispatched. Returns `undefined` when the outcome is not a
 * pre-dispatch rejection and no event should be emitted here.
 *
 * @internal
 */
export function classifyPreDispatchRejection(input: {
  error?: unknown;
  result?: ServerResult;
  /** The attempted name's state in the server's registry, when readable. */
  registryState?: RegisteredToolState;
}): PreDispatchRejection | undefined {
  // The handler threw. On SDKs <= 1.20 that is every pre-dispatch failure; on
  // later ones the paths that still bypass the catch (e.g. an elicitation
  // McpError re-thrown by design). Undispatched + threw is unambiguous.
  if (input.error != null) {
    const classified = classifyError(input.error);
    const code = (input.error as { code?: unknown }).code;
    return {
      message: classified.message,
      jsonRpcCode:
        typeof code === 'number' && Number.isSafeInteger(code)
          ? code
          : readMcpErrorCode(classified.message),
      reason: attribute(input.registryState, classified.message),
    };
  }

  // SDK >= 1.21 reports these as resolved `isError` results. Anything that is
  // not one settled successfully and is not our concern.
  if (!isErrorResult(input.result)) return undefined;

  const text = errorMessageFromResult(input.result);

  // The tool is not there to have run — no message parsing needed.
  if (input.registryState === 'missing' || input.registryState === 'disabled') {
    return {
      message: text ?? 'Tool call rejected before dispatch',
      jsonRpcCode: readMcpErrorCode(text) ?? JSON_RPC_INTERNAL_ERROR,
      reason: attribute(input.registryState, text),
    };
  }

  // Registered and live: a rejection here is schema validation, identifiable
  // only by the McpError prefix. Without it, assume the tool ran and failed on
  // its own — `[MCP] Tool Call Response` owns that (or nothing does, when the
  // tool is uninstrumented).
  const jsonRpcCode = readMcpErrorCode(text);
  if (jsonRpcCode == null || text == null) return undefined;

  return { message: text, jsonRpcCode, reason: attribute(input.registryState, text) };
}
