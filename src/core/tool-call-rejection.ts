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

/** A `tools/call` request rejected before any tool callback ran. */
export interface PreDispatchRejection {
  /** Message as the client saw it, prefix included (stable across SDK versions). */
  message: string;
  /** JSON-RPC code, when the SDK still carried it or the prefix yielded it. */
  jsonRpcCode?: number;
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
    };
  }

  // Registered and live: a rejection here is schema validation, identifiable
  // only by the McpError prefix. Without it, assume the tool ran and failed on
  // its own — `[MCP] Tool Call Response` owns that (or nothing does, when the
  // tool is uninstrumented).
  const jsonRpcCode = readMcpErrorCode(text);
  if (jsonRpcCode == null || text == null) return undefined;

  return { message: text, jsonRpcCode };
}
