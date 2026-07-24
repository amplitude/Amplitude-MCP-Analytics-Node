import { createHash } from 'node:crypto';
import type { CallToolResult } from './core/mcp.js';

/**
 * High-level error category the SDK classifies a failure into. This is a
 * **closed, SDK-owned** set: hosts describe their own failures through
 * `code` (free-form), not by picking a type. Every value here is one the SDK
 * itself assigns:
 *
 * - `returned_error` — a tool returned an in-band error result (`isError: true`).
 * - `thrown_exception` — a handler threw a JS `Error` with no more specific rule.
 * - `timeout` — the thrown error was an `AbortError`.
 * - `transport_error` — the thrown error carried a Node network code.
 * - `protocol_error` — a `tools/call` failed before dispatch (unknown tool,
 *   input-schema validation) — see `[MCP] Tool Call Rejected`.
 * - `unknown` — a non-`Error` value was thrown.
 */
export type McpToolErrorType =
  | 'returned_error'
  | 'thrown_exception'
  | 'transport_error'
  | 'timeout'
  | 'protocol_error'
  | 'unknown';

/**
 * Structured error descriptor attached to `ctx.error` on failure. Powers both
 * the MCP error response returned to the client and the telemetry event
 * emitted by the SDK.
 */
export interface McpToolError {
  /**
   * Machine-readable error identifier, finer-grained than {@link type}. Set when
   * a specific reason is known — a host `code` from `analytics.toolError()`, a
   * Node/syscall `err.code`, or a JSON-RPC code — and left **undefined** when
   * the only thing known is the coarse `type` (a bare thrown exception), so it
   * never just echoes `type`. Emitted as `[MCP] Error Code` when present.
   */
  code?: string;
  /** Human-readable error description. */
  message: string;
  /** High-level, SDK-assigned error category for analytics grouping. */
  type: McpToolErrorType;
  /** Guidance for the LLM client to self-correct and retry. */
  correctionMessage?: string;
  /** Whether the caller can reasonably retry the same request. */
  recoverable?: boolean;
  /** SDK hint that a retry is worth attempting. */
  retrySuggested?: boolean;
  /**
   * HTTP status attached to the tool's failure (e.g. an upstream API
   * response, or a thrown HTTP-shaped error). Note this is NOT the MCP
   * transport status.
   * Sniffed from `err.status` / `err.statusCode` by {@link classifyError};
   * set explicitly via {@link ToolErrorInput.httpStatus} otherwise.
   */
  httpStatus?: number;
  /** Privacy-safe hash of the top stack frames; never contains raw paths. */
  stackHash?: string;
  /** Grouping key derived from `type + normalizedMessage`. Override via {@link ToolErrorInput.fingerprint}. */
  fingerprint?: string;
}

/**
 * User-facing input for {@link buildToolError} (what `analytics.toolError()`
 * takes) — the host-settable subset of {@link McpToolError}. Describe the 
 * specific failure through the required `code`.
 */
export type ToolErrorInput = Pick<
  McpToolError,
  'message' | 'correctionMessage' | 'recoverable' | 'retrySuggested' | 'httpStatus' | 'fingerprint'
> & {
  /** Machine-readable error identifier (e.g. `'missing_chart_id'`). Emitted as `[MCP] Error Code`. */
  code: string;
};

export function buildToolError(input: ToolErrorInput): McpToolError {
  const type: McpToolErrorType = 'returned_error';

  const error: McpToolError = {
    code: input.code,
    message: input.message,
    type,
    fingerprint: input.fingerprint ?? computeFingerprint(type, input.message),
  };

  if (input.correctionMessage != null) {
    error.correctionMessage = input.correctionMessage;
  }

  if (input.recoverable != null) {
    error.recoverable = input.recoverable;
  }

  if (input.retrySuggested != null) {
    error.retrySuggested = input.retrySuggested;
  }

  if (input.httpStatus != null && isHttpStatus(input.httpStatus)) {
    error.httpStatus = input.httpStatus;
  }

  return error;
}

export function toolErrorResult(error: McpToolError): CallToolResult {
  const text = error.correctionMessage
    ? `${error.message} ${error.correctionMessage}`
    : error.message;

  return {
    content: [{ type: 'text', text }],
    isError: true,
  };
}

/**
 * Whether a tool result signals an in-band protocol error — a `CallToolResult`
 * with `isError: true`. Accepts `unknown` (a handler's raw return) and narrows.
 *
 * @internal
 */
export function isErrorResult(value: unknown): value is CallToolResult & { isError: true } {
  return (
    value != null && typeof value === 'object' && (value as CallToolResult).isError === true
  );
}

/**
 * Best-effort human-readable message from an `isError` result's `content` text
 * parts. Falls back to undefined when the content carries no text.
 *
 * @internal
 */
export function errorMessageFromResult(result: CallToolResult): string | undefined {
  const content = result.content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => (part?.type === 'text' ? part.text : ''))
      .filter((t) => t.length > 0)
      .join(' ')
      .trim();
    if (text.length > 0) return text;
  }
  return undefined;
}

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
]);

/** Valid HTTP status range guard for the sniffed/explicit values. @internal */
function isHttpStatus(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599;
}

/**
 * Sniff an HTTP status off a thrown error via the dominant Node conventions
 * (`err.status`, then `err.statusCode` — http-errors, Koa/Express-style
 * errors, got, and most API clients). Same spirit as the `err.code` /
 * `err.name` sniffing above; errors with other shapes go through
 * {@link ToolErrorInput.httpStatus} instead. @internal
 */
function httpStatusFrom(err: Error): number | undefined {
  const candidate = err as Error & { status?: unknown; statusCode?: unknown };
  if (isHttpStatus(candidate.status)) return candidate.status;
  if (isHttpStatus(candidate.statusCode)) return candidate.statusCode;
  return undefined;
}

export function classifyError(err: unknown): McpToolError {
  if (!(err instanceof Error)) {
    const message = typeof err === 'string' ? err : 'Unknown error';
    const type = 'unknown';

    return {
      message,
      type,
      fingerprint: computeFingerprint(type, message),
    };
  }

  const errWithCode = err as Error & { code?: string | number };
  const stack = hashStack(err.stack);
  const httpStatus = httpStatusFrom(err);

  if (err.name === 'AbortError') {
    const type = 'timeout';

    return {
      message: err.message,
      type,
      stackHash: stack,
      ...(httpStatus != null ? { httpStatus } : {}),
      fingerprint: computeFingerprint(type, err.message),
    };
  }

  if (typeof errWithCode.code === 'string' && NETWORK_CODES.has(errWithCode.code)) {
    const type = 'transport_error';

    return {
      code: errWithCode.code.toLowerCase(),
      message: err.message,
      type,
      stackHash: stack,
      ...(httpStatus != null ? { httpStatus } : {}),
      fingerprint: computeFingerprint(type, err.message),
    };
  }

  const type = 'thrown_exception';

  // Carry the error's own `code` (Node/syscall string, or a host-thrown
  // McpError's numeric code) when present; otherwise omit it
  return {
    message: err.message,
    type,
    ...(errWithCode.code != null ? { code: String(errWithCode.code) } : {}),
    stackHash: stack,
    ...(httpStatus != null ? { httpStatus } : {}),
    fingerprint: computeFingerprint(type, err.message),
  };
}

/** @internal */
export function normalizeMessage(message: string): string {
  return message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/"[^"]*"/g, '"<str>"')
    .replace(/'[^']*'/g, "'<str>'");
}

/** @internal */
export function computeFingerprint(type: string, message: string): string {
  const normalized = normalizeMessage(message);

  return createHash('sha256')
    .update(`${type}:${normalized}`)
    .digest('hex')
    .slice(0, 12);
}

/** @internal */
export function hashStack(stack: string | undefined): string | undefined {
  if (!stack) {
    return undefined;
  }

  const lines = stack.split('\n');
  const frames = lines
    .filter((line) => line.trimStart().startsWith('at '))
    .slice(0, 3)
    .map((line) => {
      const match = line.match(/([^/\\]+:\d+:\d+)/);
      return match ? match[1] : line.trim();
    });

  if (frames.length === 0) {
    return undefined;
  }

  return createHash('sha256').update(frames.join('\n')).digest('hex').slice(0, 12);
}
