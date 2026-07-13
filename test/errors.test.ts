import { describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  buildToolError,
  classifyError,
  computeFingerprint,
  hashStack,
  normalizeMessage,
  toolErrorResult,
} from '../src/errors.js';
import type { McpToolError } from '../src/errors.js';
import { AmplitudeMCPAnalytics } from '../src/client.js';
import { createServerContext, getCurrentContext } from '../src/context/index.js';
import type { McpServerContext, McpToolContext } from '../src/context/types.js';
import type { McpExtra } from '../src/core/mcp.js';

function makeAnalytics() {
  const tracked: unknown[] = [];
  const amplitude = { track: (e: unknown) => void tracked.push(e), flush: () => undefined };
  const analytics = new AmplitudeMCPAnalytics({
    amplitude,
    serverName: 'test-mcp',
    serverVersion: '9.9.9',
  });
  return { analytics, tracked };
}

function bind(analytics: AmplitudeMCPAnalytics) {
  (analytics as unknown as { _serverCtx?: McpServerContext })._serverCtx = createServerContext({
    server: { name: 'test-mcp', version: '9.9.9' },
    transport: 'streamable-http',
  });
}

function mkExtra(partial: Record<string, unknown> = {}): McpExtra {
  return {
    signal: new AbortController().signal,
    requestId: 1,
    sendNotification: async () => undefined,
    sendRequest: async () => ({}),
    ...partial,
  } as unknown as McpExtra;
}

const extra = mkExtra({
  sessionId: 'test-session-id',
  _meta: { clientInfo: { name: 'cursor', version: '1.2.3' } },
});

describe('buildToolError', () => {
  it('applies defaults for type and source', () => {
    const err = buildToolError({ code: 'missing_id', message: 'No ID provided.' });

    expect(err.type).toBe('returned_error');
    expect(err.source).toBe('mcp_server');
    expect(err.code).toBe('missing_id');
    expect(err.message).toBe('No ID provided.');
  });

  it('preserves all user-supplied fields', () => {
    const err = buildToolError({
      code: 'upstream_timeout',
      message: 'API timed out.',
      type: 'upstream_error',
      source: 'upstream_api',
      correctionMessage: 'Try again in a moment.',
      recoverable: true,
      retrySuggested: true,
    });

    expect(err).toMatchObject({
      code: 'upstream_timeout',
      message: 'API timed out.',
      type: 'upstream_error',
      source: 'upstream_api',
      correctionMessage: 'Try again in a moment.',
      recoverable: true,
      retrySuggested: true,
    });
    expect(err.fingerprint).toMatch(/^[0-9a-f]{12}$/);
  });

  it('uses caller-supplied fingerprint when provided', () => {
    const err = buildToolError({
      code: 'custom',
      message: 'Something broke.',
      fingerprint: 'my-custom-group',
    });

    expect(err.fingerprint).toBe('my-custom-group');
  });

  it('carries an explicit httpStatus through', () => {
    const err = buildToolError({
      code: 'upstream_denied',
      message: 'Access denied by upstream.',
      httpStatus: 403,
    });

    expect(err.httpStatus).toBe(403);
  });

  it('drops an out-of-range explicit httpStatus', () => {
    const err = buildToolError({
      code: 'weird',
      message: 'Bad status.',
      httpStatus: 12345,
    });

    expect(err.httpStatus).toBeUndefined();
  });
});

describe('toolErrorResult', () => {
  it('returns a valid MCP CallToolResult with isError: true', () => {
    const err: McpToolError = {
      code: 'missing_chart_id',
      message: 'No chart ID was provided.',
      type: 'returned_error',
      source: 'mcp_server',
      correctionMessage: 'Search for a chart first, then retry with the chart ID.',
    };

    const result = toolErrorResult(err);

    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({
      type: 'text',
      text: 'No chart ID was provided. Search for a chart first, then retry with the chart ID.',
    });
  });

  it('omits correction when not provided', () => {
    const err: McpToolError = {
      code: 'fail',
      message: 'Something went wrong.',
      type: 'thrown_exception',
      source: 'unknown',
    };

    const result = toolErrorResult(err);

    expect(result.content[0]).toEqual({
      type: 'text',
      text: 'Something went wrong.',
    });
  });
});

describe('classifyError', () => {
  it('classifies a regular thrown Error as thrown_exception', () => {
    const err = new Error('kaboom');
    const classified = classifyError(err);

    expect(classified.type).toBe('thrown_exception');
    expect(classified.message).toBe('kaboom');
    expect(classified.code).toBe('thrown_exception');
    expect(classified.stackHash).toBeDefined();
  });

  it('classifies AbortError as timeout', () => {
    const err = new DOMException('signal aborted', 'AbortError');
    const classified = classifyError(err);

    expect(classified.type).toBe('timeout');
    expect(classified.source).toBe('sdk_wrapper');
  });

  it('classifies network errors as transport_error', () => {
    const err = new Error('connect ECONNREFUSED');
    (err as Error & { code: string }).code = 'ECONNREFUSED';

    const classified = classifyError(err);
   
    expect(classified.type).toBe('transport_error');
    expect(classified.code).toBe('econnrefused');
  });

  it('classifies ECONNRESET as transport_error', () => {
    const err = new Error('socket hang up');
    (err as Error & { code: string }).code = 'ECONNRESET';

    const classified = classifyError(err);

    expect(classified.type).toBe('transport_error');
  });

  it('classifies a non-Error thrown value as unknown', () => {
    const classified = classifyError('just a string');

    expect(classified.type).toBe('unknown');
    expect(classified.source).toBe('unknown');
    expect(classified.message).toBe('just a string');
    expect(classified.stackHash).toBeUndefined();
  });

  it('handles a thrown null/undefined gracefully', () => {
    expect(classifyError(null).type).toBe('unknown');
    expect(classifyError(undefined).type).toBe('unknown');
    expect(classifyError(null).message).toBe('Unknown error');
  });

  it('preserves err.code when present on a regular error', () => {
    const err = new Error('validation failed');
    (err as Error & { code: string }).code = 'ERR_VALIDATION';

    const classified = classifyError(err);

    expect(classified.code).toBe('ERR_VALIDATION');
    expect(classified.type).toBe('thrown_exception');
  });

  it('sniffs httpStatus from err.status', () => {
    const err = new Error('Forbidden');
    (err as Error & { status: number }).status = 403;

    const classified = classifyError(err);

    expect(classified.httpStatus).toBe(403);
    expect(classified.type).toBe('thrown_exception');
  });

  it('sniffs httpStatus from err.statusCode when err.status is absent', () => {
    const err = new Error('Server error');
    (err as Error & { statusCode: number }).statusCode = 502;

    expect(classifyError(err).httpStatus).toBe(502);
  });

  it('prefers err.status over err.statusCode', () => {
    const err = new Error('Conflicting shapes');
    (err as Error & { status: number; statusCode: number }).status = 404;
    (err as Error & { status: number; statusCode: number }).statusCode = 500;

    expect(classifyError(err).httpStatus).toBe(404);
  });

  it('ignores non-HTTP-shaped status values', () => {
    const stringStatus = new Error('stringy');
    (stringStatus as Error & { status: string }).status = 'oops';
    const outOfRange = new Error('rangey');
    (outOfRange as Error & { status: number }).status = 42;

    expect(classifyError(stringStatus).httpStatus).toBeUndefined();
    expect(classifyError(outOfRange).httpStatus).toBeUndefined();
  });

  it('omits httpStatus when the error carries none', () => {
    expect(classifyError(new Error('plain')).httpStatus).toBeUndefined();
  });

  it('attaches httpStatus on the transport_error branch too', () => {
    const err = new Error('socket closed mid-response');
    (err as Error & { code: string; statusCode: number }).code = 'ECONNRESET';
    (err as Error & { code: string; statusCode: number }).statusCode = 502;

    const classified = classifyError(err);

    expect(classified.type).toBe('transport_error');
    expect(classified.httpStatus).toBe(502);
  });
});

describe('hashStack', () => {
  it('returns undefined for undefined input', () => {
    expect(hashStack(undefined)).toBeUndefined();
  });

  it('returns undefined for a stack with no frames', () => {
    expect(hashStack('Error: boom')).toBeUndefined();
  });

  it('produces a 12-char hex string', () => {
    const stack = `Error: boom
    at myFunc (file.ts:10:5)
    at otherFunc (file.ts:20:3)
    at thirdFunc (file.ts:30:1)`;

    const hash = hashStack(stack);

    expect(hash).toBeDefined();
    expect(hash).toHaveLength(12);
    expect(hash).toMatch(/^[0-9a-f]{12}$/);
  });

  it('is deterministic for the same stack', () => {
    const stack = `Error: boom
    at myFunc (file.ts:10:5)
    at otherFunc (file.ts:20:3)`;

    expect(hashStack(stack)).toBe(hashStack(stack));
  });

  it('differs for different stacks', () => {
    const stack1 = `Error: boom
    at funcA (a.ts:1:1)`;
    const stack2 = `Error: boom
    at funcB (b.ts:2:2)`;

    expect(hashStack(stack1)).not.toBe(hashStack(stack2));
  });

  it('never includes raw stack frames in output', () => {
    const stack = `Error: boom
    at Object.<anonymous> (/Users/secret/project/src/handler.ts:42:13)`;

    const hash = hashStack(stack);

    expect(hash).not.toContain('secret');
    expect(hash).not.toContain('handler');
    expect(hash).not.toContain('/Users');
  });
});

describe('normalizeMessage', () => {
  it('replaces UUIDs with <uuid>', () => {
    expect(normalizeMessage('Chart 550e8400-e29b-41d4-a716-446655440000 not found'))
      .toBe('Chart <uuid> not found');
  });

  it('replaces numbers with <n>', () => {
    expect(normalizeMessage('Row 42 in table 7 failed')).toBe('Row <n> in table <n> failed');
  });

  it('replaces double-quoted strings with <str>', () => {
    expect(normalizeMessage('Unknown column "user_name"')).toBe('Unknown column "<str>"');
  });

  it('replaces single-quoted strings with <str>', () => {
    expect(normalizeMessage("Key 'abc' not found")).toBe("Key '<str>' not found");
  });

  it('normalizes a complex message consistently', () => {
    const a = normalizeMessage('User 123 chart "sales" error 550e8400-e29b-41d4-a716-446655440000');
    const b = normalizeMessage('User 456 chart "revenue" error a1b2c3d4-e5f6-7890-abcd-ef1234567890');

    expect(a).toBe(b);
  });
});

describe('computeFingerprint', () => {
  it('produces a 12-char hex string', () => {
    const fp = computeFingerprint('thrown_exception', 'boom');

    expect(fp).toMatch(/^[0-9a-f]{12}$/);
  });

  it('is deterministic', () => {
    const a = computeFingerprint('timeout', 'timed out');
    const b = computeFingerprint('timeout', 'timed out');

    expect(a).toBe(b);
  });

  it('differs by error type', () => {
    const a = computeFingerprint('thrown_exception', 'boom');
    const b = computeFingerprint('timeout', 'boom');

    expect(a).not.toBe(b);
  });

  it('groups same-template messages with different dynamic values', () => {
    const a = computeFingerprint('thrown_exception', 'Chart 123 not found');
    const b = computeFingerprint('thrown_exception', 'Chart 456 not found');

    expect(a).toBe(b);
  });
});

describe('classifyError fingerprints', () => {
  it('includes a fingerprint on classified errors', () => {
    expect(classifyError(new Error('boom')).fingerprint).toMatch(/^[0-9a-f]{12}$/);
  });

  it('groups same-type errors with template-equivalent messages', () => {
    const a = classifyError(new Error('Chart 123 not found'));
    const b = classifyError(new Error('Chart 456 not found'));

    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it('includes a fingerprint on non-Error values', () => {
    expect(classifyError('oops').fingerprint).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('AmplitudeMCPAnalytics.toolError', () => {
  it('returns a valid MCP error response and stores error on ctx', () => {
    const { analytics } = makeAnalytics();
    bind(analytics);

    let ctx: McpToolContext | undefined;
    let result: CallToolResult | undefined;

    const wrapped = analytics.instrumentTool(
      async (_extra: McpExtra) => {
        ctx = getCurrentContext() as McpToolContext | undefined;
        result = analytics.toolError(ctx!, {
          code: 'missing_chart_id',
          message: 'No chart ID was provided.',
          correctionMessage: 'Search for a chart first.',
          recoverable: true,
        });
        return result;
      },
      { name: 'search_docs' },
    );

    return wrapped(extra).then(() => {
      expect(result!.isError).toBe(true);
      expect(result!.content[0]).toEqual({
        type: 'text',
        text: 'No chart ID was provided. Search for a chart first.',
      });

      expect(ctx!.error).toBeDefined();
      expect(ctx!.error!.code).toBe('missing_chart_id');
      expect(ctx!.error!.type).toBe('returned_error');
      expect(ctx!.error!.recoverable).toBe(true);
    });
  });
});

describe('instrumentTool error classification', () => {
  it('classifies thrown sync errors and re-throws', () => {
    const { analytics } = makeAnalytics();
    bind(analytics);

    let ctx: McpToolContext | undefined;
    const wrapped = analytics.instrumentTool(
      (_extra: McpExtra): CallToolResult => {
        ctx = getCurrentContext() as McpToolContext | undefined;
        throw new Error('kaboom');
      },
      { name: 'boom' },
    );

    expect(() => wrapped(extra)).toThrow('kaboom');
    expect(ctx!.error).toBeDefined();
    expect(ctx!.error!.type).toBe('thrown_exception');
    expect(ctx!.error!.message).toBe('kaboom');
    expect(ctx!.error!.stackHash).toBeDefined();
  });

  it('classifies thrown async errors and re-throws', async () => {
    const { analytics } = makeAnalytics();
    bind(analytics);

    let ctx: McpToolContext | undefined;
    const wrapped = analytics.instrumentTool(
      async (_extra: McpExtra): Promise<CallToolResult> => {
        ctx = getCurrentContext() as McpToolContext | undefined;
        throw new Error('async kaboom');
      },
      { name: 'boom' },
    );

    await expect(wrapped(extra)).rejects.toThrow('async kaboom');

    expect(ctx!.error).toBeDefined();
    expect(ctx!.error!.type).toBe('thrown_exception');
    expect(ctx!.error!.message).toBe('async kaboom');
  });

  it('does not set ctx.error on successful calls', async () => {
    const { analytics } = makeAnalytics();
    bind(analytics);

    let ctx: McpToolContext | undefined;
    const wrapped = analytics.instrumentTool(
      async (_extra: McpExtra): Promise<CallToolResult> => {
        ctx = getCurrentContext() as McpToolContext | undefined;
        return { content: [{ type: 'text', text: 'ok' }] };
      },
      { name: 'ok-tool' },
    );

    await wrapped(extra);

    expect(ctx!.error).toBeUndefined();
  });

  it('classifies AbortError from cancelled signal', async () => {
    const { analytics } = makeAnalytics();
    bind(analytics);

    let ctx: McpToolContext | undefined;
    const wrapped = analytics.instrumentTool(
      async (_extra: McpExtra): Promise<CallToolResult> => {
        ctx = getCurrentContext() as McpToolContext | undefined;
        throw new DOMException('signal aborted', 'AbortError');
      },
      { name: 'timeout-tool' },
    );

    await expect(wrapped(extra)).rejects.toThrow('signal aborted');

    expect(ctx!.error!.type).toBe('timeout');
  });

  it('carries the sniffed httpStatus from a thrown HTTP-shaped error onto ctx.error', async () => {
    const { analytics } = makeAnalytics();
    bind(analytics);

    let ctx: McpToolContext | undefined;
    const wrapped = analytics.instrumentTool(
      async (_extra: McpExtra): Promise<CallToolResult> => {
        ctx = getCurrentContext() as McpToolContext | undefined;
        const err = new Error('upstream said no');
        (err as Error & { status: number }).status = 403;
        throw err;
      },
      { name: 'denied-tool' },
    );

    await expect(wrapped(extra)).rejects.toThrow('upstream said no');

    expect(ctx!.error!.type).toBe('thrown_exception');
    expect(ctx!.error!.httpStatus).toBe(403);
  });
});
