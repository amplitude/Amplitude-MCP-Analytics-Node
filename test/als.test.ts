import { describe, expect, it } from 'vitest';
import {
  createServerContext,
  getCurrentContext,
  runWithContext,
} from '../src/context/index.js';

const ctx = createServerContext({
  server: { name: 'my-server' },
  transport: 'stdio',
});

describe('ambient context (als)', () => {
  it('is undefined outside any scope', () => {
    expect(getCurrentContext()).toBeUndefined();
  });

  it('exposes the context inside the scope and returns the fn result', () => {
    const result = runWithContext(ctx, () => {
      expect(getCurrentContext()).toBe(ctx);
      return 42;
    });
    expect(result).toBe(42);
  });

  it('propagates across awaited async work within the scope', async () => {
    await runWithContext(ctx, async () => {
      await Promise.resolve();
      expect(getCurrentContext()).toBe(ctx);
    });
  });

  it('restores the outer context after a nested scope', () => {
    const inner = createServerContext({
      server: { name: 'inner' },
      transport: 'stdio',
    });
    runWithContext(ctx, () => {
      runWithContext(inner, () => {
        expect(getCurrentContext()).toBe(inner);
      });
      expect(getCurrentContext()).toBe(ctx);
    });
  });

  it('is undefined again after the scope exits', () => {
    runWithContext(ctx, () => {});
    expect(getCurrentContext()).toBeUndefined();
  });
});
