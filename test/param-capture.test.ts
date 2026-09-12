import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import {
  captureParamProperties,
  resolveToolParamCapture,
} from '../src/tracking/param-capture.js';
import type { Logger } from '../src/utils/logger.js';

const logger: Logger = {
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
};

function capture(
  params: Record<string, unknown>,
  overrides: Partial<Parameters<typeof captureParamProperties>[1]> = {},
) {
  return captureParamProperties(params, {
    shape: true,
    neverKeys: ['rationale', 'context'],
    logger,
    toolName: 'search',
    ...overrides,
  });
}

describe('Tier 1 parameter shape capture', () => {
  it('describes every JSON type without including values or nested content', () => {
    const result = capture({
      bool: true,
      num: 42,
      empty: '',
      short: 'secret',
      medium: 'x'.repeat(33),
      long: 'x'.repeat(257),
      array: ['secret', 2],
      object: { nested: 'secret', other: true },
      nil: null,
    });

    expect(result.tier1['[MCP] Param Shape']).toBe(
      'array:arr[2];bool:bool;empty:str[0];long:str[257+];medium:str[33-256];nil:null;num:num;object:obj[2];short:str[1-32]',
    );
    expect(result.tier1['[MCP] Param Count']).toBe(9);
    expect(result.tier1['[MCP] Param Keys']).toEqual([
      'array',
      'bool',
      'empty',
      'long',
      'medium',
      'nil',
      'num',
      'object',
      'short',
    ]);
  });

  it('is deterministic across input key order', () => {
    const a = capture({ z: true, a: [1, 2] }).tier1;
    const b = capture({ a: [9, 8], z: false }).tier1;

    expect(a['[MCP] Param Shape']).toBe(b['[MCP] Param Shape']);
    expect(a['[MCP] Param Fingerprint']).toBe(
      b['[MCP] Param Fingerprint'],
    );
  });

  it('excludes global and tool-level never keys', () => {
    const result = capture(
      { rationale: 'why', context: 'where', secret: 'hidden', safe: true },
      {
        policy: { never: ['secret'] },
      },
    );

    expect(result.tier1['[MCP] Param Keys']).toEqual(['safe']);
    expect(result.tier1['[MCP] Param Count']).toBe(1);
    expect(result.tier1['[MCP] Param Shape']).toBe('safe:bool');
  });

  it('allows consumers to override the default exclusions', () => {
    const result = capture(
      { rationale: 'why', context: 'where' },
      { neverKeys: [] },
    );

    expect(result.tier1['[MCP] Param Keys']).toEqual([
      'context',
      'rationale',
    ]);
  });

  it('bounds key names and the keys list while retaining the supplied count', () => {
    const overlong = 'x'.repeat(65);
    const params = Object.fromEntries([
      ...Array.from({ length: 33 }, (_, index) => [`key${index}`, index]),
      [overlong, true],
    ]);
    const result = capture(params);

    expect(result.tier1['[MCP] Param Keys']).toHaveLength(32);
    expect(result.tier1['[MCP] Param Count']).toBe(34);
    expect(result.tier1['[MCP] Param Shape']).not.toContain(overlong);
    expect(
      (result.tier1['[MCP] Param Keys'] as string[]).some(
        (key) => key.length > 64,
      ),
    ).toBe(false);

    const boundary = 'y'.repeat(64);
    expect(
      capture({ [boundary]: true }).tier1['[MCP] Param Keys'],
    ).toContain(boundary);
  });

  it('caps shape at 1,024 characters including a visible marker', () => {
    const params = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [
        `${String(index).padStart(2, '0')}-${'x'.repeat(60)}`,
        'value',
      ]),
    );
    const shape = capture(params).tier1['[MCP] Param Shape'] as string;

    expect(shape.length).toBeLessThanOrEqual(1024);
    expect(shape.endsWith('…')).toBe(true);
    for (const token of shape.slice(0, -1).split(';')) {
      expect(token.endsWith(':str[1-32]')).toBe(true);
    }
  });

  it('uses only safe route values and honors never', () => {
    const accepted = capture(
      { action: 'list-items', q: true },
      { policy: { routeKey: 'action', never: [] } },
    ).tier1['[MCP] Param Shape'];
    expect(accepted).toBe('route=list-items;action:str[1-32];q:bool');

    const rejected = capture(
      { action: 'email@example.com', q: true },
      { policy: { routeKey: 'action', never: [] } },
    ).tier1['[MCP] Param Shape'];
    const undeclared = capture({
      action: 'email@example.com',
      q: true,
    }).tier1['[MCP] Param Shape'];
    expect(rejected).toBe(undeclared);

    const excluded = capture(
      { action: 'list-items', q: true },
      {
        policy: { routeKey: 'action', never: ['action'] },
      },
    ).tier1['[MCP] Param Shape'];
    expect(excluded).toBe('q:bool');
  });

  it('hashes the exact shape, preserving arity', () => {
    const two = capture({ command: [1, 2] }).tier1;
    const three = capture({ command: [1, 2, 3] }).tier1;

    expect(two['[MCP] Param Fingerprint']).not.toBe(
      three['[MCP] Param Fingerprint'],
    );
    expect(two['[MCP] Param Fingerprint']).toMatch(/^[a-f0-9]{12}$/);
  });

  it('does not emit parameter value substrings', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.emailAddress(),
          fc.uuid(),
          fc.string({ minLength: 20, maxLength: 200 }),
        ),
        ([email, uuid, text]) => {
          const tier1 = capture({ p1: email, p2: uuid, p3: text }).tier1;
          // Compare human-readable emitted values. The fingerprint is a
          // non-reversible hash and can coincidentally contain a short input
          // substring without having emitted that content.
          const output = JSON.stringify([
            tier1['[MCP] Param Keys'],
            tier1['[MCP] Param Count'],
            tier1['[MCP] Param Shape'],
          ]);
          for (const value of [email, uuid, text]) {
            for (let index = 0; index <= value.length - 4; index += 1) {
              expect(output).not.toContain(value.slice(index, index + 4));
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('Tier 2 derived parameter metadata', () => {
  it('emits safe scalar values in stable key order', () => {
    const result = capture(
      { raw: 'ignored' },
      {
        policy: {
          never: [],
          derive: () => ({ range: 30, destructive: false, metric: 'formula' }),
        },
      },
    );

    expect(result.tier2).toEqual({
      '[MCP] Param: destructive': false,
      '[MCP] Param: metric': 'formula',
      '[MCP] Param: range': 30,
    });
  });

  it('drops unsafe values, keys, and non-scalars', () => {
    const result = capture(
      {},
      {
        policy: {
          never: ['excluded'],
          derive: () =>
            ({
              email: 'user@example.com',
              newline: 'hello\nworld',
              doubleQuote: 'say "hello"',
              singleQuote: "say 'hello'",
              tooLong: 'x'.repeat(257),
              object: { unsafe: true },
              excluded: true,
              ['x'.repeat(65)]: true,
              safe: 'ok',
            }) as unknown as Record<string, string | number | boolean>,
        },
      },
    );

    expect(result.tier2).toEqual({ '[MCP] Param: safe': 'ok' });
  });

  it('caps derived properties at eight', () => {
    const result = capture(
      {},
      {
        policy: {
          never: [],
          derive: () =>
            Object.fromEntries(
              Array.from({ length: 10 }, (_, index) => [`key${index}`, index]),
            ),
        },
      },
    );

    expect(Object.keys(result.tier2)).toHaveLength(8);
  });

  it('fails closed when derive throws', () => {
    const debug = vi.fn();
    const result = capture(
      {},
      {
        logger: { ...logger, debug },
        policy: {
          never: [],
          derive: () => {
            throw new Error('boom');
          },
        },
      },
    );

    expect(result.tier2).toEqual({});
    expect(debug).toHaveBeenCalledOnce();
  });
});

describe('capture declaration validation', () => {
  it('disables malformed declarations without throwing', () => {
    expect(
      resolveToolParamCapture({ routeKey: 42 } as unknown),
    ).toMatchObject({ disabled: true });
    expect(
      resolveToolParamCapture({ derive: 'nope' } as unknown),
    ).toMatchObject({ disabled: true });
    expect(
      resolveToolParamCapture({ never: 'secret' } as unknown),
    ).toMatchObject({ disabled: true });
  });

  it('ignores invalid never entries but keeps the declaration enabled', () => {
    const result = resolveToolParamCapture({
      never: ['secret', 42],
    } as unknown);

    expect(result.disabled).toBe(false);
    expect(result.policy?.never).toEqual(['secret']);
    expect(result.warnings).toHaveLength(1);
  });
});
