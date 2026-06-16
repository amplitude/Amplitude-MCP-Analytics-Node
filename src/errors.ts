import { createHash } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export type McpToolErrorType =
  | 'returned_error'
  | 'thrown_exception'
  | 'validation_error'
  | 'auth_error'
  | 'upstream_error'
  | 'transport_error'
  | 'timeout'
  | 'unknown';

export type McpErrorSource =
  | 'mcp_server'
  | 'upstream_api'
  | 'auth'
  | 'client'
  | 'sdk_wrapper'
  | 'unknown';

/**
 * Structured error descriptor attached to `ctx.error` on failure. Powers both
 * the MCP error response returned to the client and the telemetry event
 * emitted by the SDK.
 */
export interface McpToolError {
  /** Machine-readable error identifier (e.g. `'missing_chart_id'`). */
  code: string;
  /** Human-readable error description. */
  message: string;
  /** High-level error category for analytics grouping. */
  type: McpToolErrorType;
  /** Where the error originated. */
  source: McpErrorSource;
  /** Guidance for the LLM client to self-correct and retry. */
  correctionMessage?: string;
  /** Whether the caller can reasonably retry the same request. */
  recoverable?: boolean;
  /** SDK hint that a retry is worth attempting. */
  retrySuggested?: boolean;
  /** Privacy-safe hash of the top stack frames; never contains raw paths. */
  stackHash?: string;
  /** Grouping key derived from `type + normalizedMessage`. Override via {@link ToolErrorInput.fingerprint}. */
  fingerprint?: string;
}

/**
 * User-facing input for {@link buildToolError}. Only `code` and `message` are
 * required; everything else has sensible defaults (`type: 'returned_error'`,
 * `source: 'mcp_server'`).
 */
export interface ToolErrorInput {
  /** Machine-readable error identifier (e.g. `'missing_chart_id'`). */
  code: string;
  /** Human-readable error description shown to the LLM client. */
  message: string;
  /** @defaultValue `'returned_error'` */
  type?: McpToolErrorType;
  /** @defaultValue `'mcp_server'` */
  source?: McpErrorSource;
  /** Guidance for the LLM client to self-correct and retry. */
  correctionMessage?: string;
  /** Whether the caller can reasonably retry the same request. */
  recoverable?: boolean;
  /** SDK hint that a retry is worth attempting. */
  retrySuggested?: boolean;
  /** Custom grouping key. When omitted, auto-derived from `type + normalizedMessage`. */
  fingerprint?: string;
}

export function buildToolError(input: ToolErrorInput): McpToolError {
  const type = input.type ?? 'returned_error';

  const error: McpToolError = {
    code: input.code,
    message: input.message,
    type,
    source: input.source ?? 'mcp_server',
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

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
]);

export function classifyError(err: unknown): McpToolError {
  if (!(err instanceof Error)) {
    const message = typeof err === 'string' ? err : 'Unknown error';
    const type = 'unknown';

    return {
      code: 'unknown_error',
      message,
      type,
      source: 'unknown',
      fingerprint: computeFingerprint(type, message),
    };
  }

  const errWithCode = err as Error & { code?: string };
  const stack = hashStack(err.stack);

  if (err.name === 'AbortError') {
    const type = 'timeout';

    return {
      code: 'timeout',
      message: err.message,
      type,
      source: 'sdk_wrapper',
      stackHash: stack,
      fingerprint: computeFingerprint(type, err.message),
    };
  }

  if (errWithCode.code && NETWORK_CODES.has(errWithCode.code)) {
    const type = 'transport_error';

    return {
      code: errWithCode.code.toLowerCase(),
      message: err.message,
      type,
      source: 'unknown',
      stackHash: stack,
      fingerprint: computeFingerprint(type, err.message),
    };
  }

  const type = 'thrown_exception';

  return {
    code: errWithCode.code ?? 'thrown_exception',
    message: err.message,
    type,
    source: 'unknown',
    stackHash: stack,
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
