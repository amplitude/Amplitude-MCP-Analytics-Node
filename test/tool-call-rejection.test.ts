/**
 * `classifyPreDispatchRejection` — deciding whether an undispatched
 * `tools/call` outcome was a rejection before dispatch.
 *
 * These are pure unit tests over the two failure shapes the MCP SDK uses, so
 * both contracts are covered regardless of which SDK version is installed:
 *
 *   - `error` set        → the handler threw (SDK <= 1.20, plus surviving throws)
 *   - `result.isError`   → in-band conversion (SDK >= 1.21)
 *
 * Callers must already have excluded dispatched requests; every case here is
 * one the dispatch marker did not claim.
 */
import { describe, expect, it } from 'vitest';
import { classifyPreDispatchRejection } from '../src/core/tool-call-rejection.js';
import type { ServerResult } from '../src/core/mcp.js';

/** An `McpError`-shaped throw, as the SDK raises for pre-dispatch failures. */
function mcpError(code: number, message: string): Error & { code: number } {
  return Object.assign(new Error(`MCP error ${code}: ${message}`), { code });
}

/** An in-band error result, as SDKs >= 1.21 return for the same failures. */
function errorResult(text: string): ServerResult {
  return { content: [{ type: 'text', text }], isError: true } as unknown as ServerResult;
}

describe('classifyPreDispatchRejection — thrown (SDK <= 1.20)', () => {
  it('claims any undispatched throw and keeps the numeric code', () => {
    const out = classifyPreDispatchRejection({
      error: mcpError(-32602, 'Tool nope not found'),
      registryState: 'missing',
    });

    expect(out).toEqual({
      message: 'MCP error -32602: Tool nope not found',
      jsonRpcCode: -32602,
    });
  });

  it('claims a throw even when the registry cannot be read', () => {
    const out = classifyPreDispatchRejection({ error: mcpError(-32602, 'bad args') });
    expect(out?.jsonRpcCode).toBe(-32602);
  });

  it('recovers the code from the message when the error carries none', () => {
    const out = classifyPreDispatchRejection({
      error: new Error('MCP error -32601: Method not found'),
    });
    expect(out?.jsonRpcCode).toBe(-32601);
  });

  it('reports no code rather than inventing one for a bare throw', () => {
    const out = classifyPreDispatchRejection({ error: new Error('something broke') });
    expect(out).toEqual({ message: 'something broke', jsonRpcCode: undefined });
  });

  it('ignores a non-integer code on the error', () => {
    const out = classifyPreDispatchRejection({
      error: Object.assign(new Error('weird'), { code: 1.5 }),
    });
    expect(out?.jsonRpcCode).toBeUndefined();
  });
});

describe('classifyPreDispatchRejection — in-band isError (SDK >= 1.21)', () => {
  it('claims an unknown tool on registry evidence', () => {
    const out = classifyPreDispatchRejection({
      result: errorResult('MCP error -32602: Tool nope not found'),
      registryState: 'missing',
    });

    expect(out).toEqual({
      message: 'MCP error -32602: Tool nope not found',
      jsonRpcCode: -32602,
    });
  });

  it('claims a disabled tool on registry evidence', () => {
    const out = classifyPreDispatchRejection({
      result: errorResult('MCP error -32602: Tool off disabled'),
      registryState: 'disabled',
    });
    expect(out?.jsonRpcCode).toBe(-32602);
  });

  it('claims a schema failure on a live tool via the McpError prefix', () => {
    const out = classifyPreDispatchRejection({
      result: errorResult('MCP error -32602: Invalid arguments for tool echo: ...'),
      registryState: 'enabled',
    });
    expect(out?.jsonRpcCode).toBe(-32602);
  });

  it('declines a live tool’s own error — no prefix, so it actually ran', () => {
    const out = classifyPreDispatchRejection({
      result: errorResult('upstream returned 500'),
      registryState: 'enabled',
    });
    expect(out).toBeUndefined();
  });

  it('declines a live tool’s error when the registry is unreadable', () => {
    // Without registry evidence the prefix is the only signal, and absent it the
    // safe reading is "the tool ran" — misfiling this would inflate protocol_error.
    const out = classifyPreDispatchRejection({ result: errorResult('upstream returned 500') });
    expect(out).toBeUndefined();
  });

  it('declines a successful result', () => {
    const out = classifyPreDispatchRejection({
      result: { content: [{ type: 'text', text: 'ok' }] } as unknown as ServerResult,
      registryState: 'enabled',
    });
    expect(out).toBeUndefined();
  });

  it('declines when nothing settled at all', () => {
    expect(classifyPreDispatchRejection({})).toBeUndefined();
  });

  it('still claims a missing tool when the message carries no usable prefix', () => {
    // Registry evidence stands on its own; the code falls back rather than the
    // whole rejection being dropped.
    const out = classifyPreDispatchRejection({
      result: errorResult('Tool nope not found'),
      registryState: 'missing',
    });
    expect(out?.message).toBe('Tool nope not found');
    expect(out?.jsonRpcCode).toBe(-32603);
  });

  it('substitutes a message when a missing tool’s result has no text', () => {
    const out = classifyPreDispatchRejection({
      result: { content: [], isError: true } as unknown as ServerResult,
      registryState: 'missing',
    });
    expect(out?.message).toBe('Tool call rejected before dispatch');
  });
});
