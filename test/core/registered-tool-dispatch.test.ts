import { describe, expect, it, vi } from 'vitest';
import { observeRegisteredToolDispatch } from '../../src/core/mcp.js';

describe('observeRegisteredToolDispatch', () => {
  it.each(['callback', 'handler', 'executor'])('observes the %s registry slot without changing invocation', (key) => {
    const extra = {};
    const args = {};
    const result = {};
    const dispatched = vi.fn();
    const callback = vi.fn((..._args: unknown[]) => result);
    const tool = { [key]: callback };
    const server = { _registeredTools: { search: tool } };
    observeRegisteredToolDispatch(server, 'search', dispatched);
    const wrapped = tool[key]!;
    observeRegisteredToolDispatch(server, 'search', dispatched);
    expect(tool[key]).toBe(wrapped);
    expect(wrapped.call(tool, args, extra)).toBe(result);
    expect(callback).toHaveBeenCalledWith(args, extra);
    expect(callback.mock.contexts[0]).toBe(tool);
    expect(dispatched).toHaveBeenCalledExactlyOnceWith(extra);
  });

  it('marks a schema-less callback that throws without swallowing the error', () => {
    const extra = {};
    const error = new Error('Invalid arguments: unsupported search operator');
    const dispatched = vi.fn();
    const tool = { callback: (..._args: unknown[]): unknown => { throw error; } };
    observeRegisteredToolDispatch({ _registeredTools: { search: tool } }, 'search', dispatched);
    expect(() => tool.callback(extra)).toThrow(error);
    expect(dispatched).toHaveBeenCalledExactlyOnceWith(extra);
  });

  it('ignores absent tools and unreadable registries', () => {
    const dispatched = vi.fn();
    for (const server of [{}, { _registeredTools: {} }]) {
      observeRegisteredToolDispatch(server, undefined, dispatched);
      observeRegisteredToolDispatch(server, 'missing', dispatched);
    }
    expect(dispatched).not.toHaveBeenCalled();
  });
});
