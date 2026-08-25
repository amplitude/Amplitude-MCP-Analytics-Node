import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { resolveIdentityFromChain, uuidv5 } from '../src/core/identity.js';
import type { McpAnchor, IdentityResolver, McpTenant } from '../src/context/types.js';
import type { Logger } from '../src/utils/logger.js';

function mockLogger(): Logger & { calls: { warn: string[]; error: string[] } } {
  const calls = { warn: [] as string[], error: [] as string[] };
  return {
    calls,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn((msg: string) => calls.warn.push(msg)),
    error: vi.fn((msg: string) => calls.error.push(msg)),
  };
}

const processAnchor: McpAnchor = { type: 'process', value: '12345' };
const sessionAnchor: McpAnchor = { type: 'session-id', value: 'sess-abc' };
const traceAnchor: McpAnchor = { type: 'trace', value: '4bf92f3577b34da6a3ce929d0e0e4736' };
const anonAnchor: McpAnchor = { type: 'anonymous', value: 'aaa-bbb-ccc' };

describe('uuidv5 — RFC 9562 §5.5 conformance', () => {
  // This package hand-rolls uuidv5 to stay dependency-free, so it needs to be
  // tied to an external standard, not just to itself. The suite's other
  // assertions pin our own derivations, which proves the two SDKs agree — but
  // agreement is not conformance: a mirrored mistake would satisfy both.
  //
  // These are published RFC v5 vectors, each cross-checked against Python's
  // `uuid.uuid5` (an independent reference implementation).
  //
  // Argument order is (name, namespace) — see the note on uuidv5.
  const DNS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
  const URL = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

  it.each([
    ['DNS', 'python.org', DNS, '886313e1-3b8a-5372-9b90-0c9aee199e5d'],
    ['DNS', 'www.example.com', DNS, '2ed6657d-e927-568b-95e1-2665a8aea6a2'],
    ['URL', 'http://python.org/', URL, '4c565f0d-3f5a-5890-b41b-20cf47701c5e'],
  ])('matches the published vector for %s / "%s"', (_label, name, namespace, expected) => {
    expect(uuidv5(name, namespace)).toBe(expected);
  });

  it('sets the version nibble to 5 and the RFC 4122 variant bits', () => {
    // Guards the two bit-twiddles independently of any single vector: byte 6's
    // high nibble must be 5, and byte 8's top two bits must be 10xx.
    const id = uuidv5('any name', DNS);
    expect(id[14]).toBe('5');
    expect(['8', '9', 'a', 'b']).toContain(id[19]);
  });

  it('hashes the namespace as bytes, not as its hex text', () => {
    // The most likely way to get this wrong: feeding the namespace string
    // straight into the hash instead of its 16 decoded bytes. That would still
    // be deterministic and still look like a valid v5 UUID, so only a vector
    // catches it — this asserts the two are not the same value.
    const wrong = createHash('sha1').update(DNS).update('python.org').digest();
    expect(uuidv5('python.org', DNS).replace(/-/g, '')).not.toBe(
      wrong.subarray(0, 16).toString('hex'),
    );
  });
});

describe('anchor-derived device id namespace', () => {
  // Golden values for the anchor key `session-id:sess-abc`. The Python SDK
  // asserts the same derivation, so these pin the cross-SDK wire contract.
  const EXPECTED = '5fce1aa7-c7c0-53ad-a89b-7a43e0e8dea5';
  // What the same key derived to through v0.4.1, when the namespace constant
  // was NameSpace_OID (6ba7b812-…) — one of the four RFC 9562 Appendix A
  // reserved namespaces, and therefore not private to this SDK at all.
  const RFC_RESERVED_OID_DERIVED = '1ab62820-d031-5f96-ab16-083102f13787';

  it('derives device ids under the private namespace', () => {
    const result = resolveIdentityFromChain({ anchor: sessionAnchor });
    expect(result.identity.deviceId).toBe(EXPECTED);
  });

  it('no longer derives under the RFC-reserved OID namespace', () => {
    const result = resolveIdentityFromChain({ anchor: sessionAnchor });
    expect(result.identity.deviceId).not.toBe(RFC_RESERVED_OID_DERIVED);
  });
});

describe('resolveIdentityFromChain', () => {
  describe('resolveIdentity callback', () => {
    it('uses userId from resolveIdentity when present', () => {
      const resolver: IdentityResolver = (authInfo) => ({
        userId: authInfo?.email as string,
      });

      const result = resolveIdentityFromChain({
        resolveIdentity: resolver,
        authInfo: { email: 'alice@example.com' },
        anchor: sessionAnchor,
      });

      expect(result.identity.userId).toBe('alice@example.com');
      expect(result.identity.resolvedFrom).toBe('authInfo');
    });

    it('derives deviceId from anchor when resolveIdentity returns only userId', () => {
      const resolver: IdentityResolver = () => ({ userId: 'alice' });

      const result = resolveIdentityFromChain({
        resolveIdentity: resolver,
        authInfo: {},
        anchor: sessionAnchor,
      });

      expect(result.identity.userId).toBe('alice');
      expect(result.identity.deviceId).toBeDefined();
      expect(result.identity.deviceId?.length).toBeGreaterThanOrEqual(5);
    });

    it('uses explicit deviceId from resolveIdentity (skips anchor derivation)', () => {
      const resolver: IdentityResolver = () => ({
        userId: 'alice',
        deviceId: 'my-device-123',
      });

      const result = resolveIdentityFromChain({
        resolveIdentity: resolver,
        authInfo: {},
        anchor: sessionAnchor,
      });

      expect(result.identity.deviceId).toBe('my-device-123');
    });

    it('passes tenant through from resolveIdentity', () => {
      const tenant: McpTenant = { groupType: 'org id', groupValue: '42' };
      const resolver: IdentityResolver = () => ({ userId: 'alice', tenant });

      const result = resolveIdentityFromChain({
        resolveIdentity: resolver,
        authInfo: {},
        anchor: sessionAnchor,
      });

      expect(result.tenant).toEqual(tenant);
    });

    it('falls through when resolveIdentity returns empty (no userId or deviceId)', () => {
      const resolver: IdentityResolver = () => ({});

      const result = resolveIdentityFromChain({
        resolveIdentity: resolver,
        authInfo: {},
        anchor: sessionAnchor,
      });

      expect(result.identity.resolvedFrom).toBe('anchor');
    });
  });

  describe('server identity from instrumentServer', () => {
    it('uses static userId from serverIdentity', () => {
      const result = resolveIdentityFromChain({
        serverIdentity: { userId: 'operator@example.com' },
        anchor: processAnchor,
      });

      expect(result.identity.userId).toBe('operator@example.com');
      expect(result.identity.resolvedFrom).toBe('explicit');
    });

    it('derives deviceId from anchor when serverIdentity has only userId', () => {
      const result = resolveIdentityFromChain({
        serverIdentity: { userId: 'operator@example.com' },
        anchor: processAnchor,
      });

      expect(result.identity.deviceId).toBeDefined();
    });

    it('uses explicit deviceId from serverIdentity', () => {
      const result = resolveIdentityFromChain({
        serverIdentity: { userId: 'op', deviceId: 'dev-static' },
        anchor: processAnchor,
      });

      expect(result.identity.deviceId).toBe('dev-static');
    });

    it('passes tenant from serverIdentity', () => {
      const tenant: McpTenant = { groupType: 'org id', groupValue: '99' };
      const result = resolveIdentityFromChain({
        serverIdentity: { userId: 'op', tenant },
        anchor: processAnchor,
      });

      expect(result.tenant).toEqual(tenant);
    });
  });

  describe('anchor-based identity', () => {
    it('derives userId and deviceId from a process anchor', () => {
      const result = resolveIdentityFromChain({ anchor: processAnchor });

      expect(result.identity.resolvedFrom).toBe('anchor');
      expect(result.identity.userId).toBe('process:12345');
      expect(result.identity.deviceId).toBeDefined();
      expect(result.identity.deviceId?.length).toBeGreaterThanOrEqual(5);
    });

    it('derives userId and deviceId from a session anchor', () => {
      const result = resolveIdentityFromChain({ anchor: sessionAnchor });

      expect(result.identity.resolvedFrom).toBe('anchor');
      expect(result.identity.userId).toBe('session-id:sess-abc');
    });

    it('derives userId and deviceId from a trace anchor', () => {
      const result = resolveIdentityFromChain({ anchor: traceAnchor });

      expect(result.identity.resolvedFrom).toBe('anchor');
      expect(result.identity.userId).toBe(`trace:${traceAnchor.value}`);
    });

    it('produces stable deviceId for the same anchor (deterministic uuidv5)', () => {
      const a = resolveIdentityFromChain({ anchor: sessionAnchor });
      const b = resolveIdentityFromChain({ anchor: sessionAnchor });

      expect(a.identity.deviceId).toBe(b.identity.deviceId);
    });

    it('produces different deviceIds for different anchors', () => {
      const a = resolveIdentityFromChain({ anchor: processAnchor });
      const b = resolveIdentityFromChain({ anchor: sessionAnchor });

      expect(a.identity.deviceId).not.toBe(b.identity.deviceId);
    });
  });

  describe('anonymous floor', () => {
    it('falls to anonymous when anchor is anonymous', () => {
      const result = resolveIdentityFromChain({ anchor: anonAnchor });

      expect(result.identity.resolvedFrom).toBe('anonymous');
    });

    it('synthesizes userId with anonymous: prefix and deviceId', () => {
      const result = resolveIdentityFromChain({ anchor: anonAnchor });

      expect(result.identity.deviceId).toBeDefined();
      expect(result.identity.userId).toBe(`anonymous:${result.identity.deviceId}`);
    });

    it('produces a fresh deviceId per call (no stitching)', () => {
      const a = resolveIdentityFromChain({ anchor: anonAnchor });
      const b = resolveIdentityFromChain({ anchor: anonAnchor });

      expect(a.identity.deviceId).not.toBe(b.identity.deviceId);
    });
  });

  describe('precedence', () => {
    it('resolveIdentity wins over serverIdentity', () => {
      const resolver: IdentityResolver = () => ({ userId: 'from-auth' });

      const result = resolveIdentityFromChain({
        resolveIdentity: resolver,
        authInfo: {},
        serverIdentity: { userId: 'from-server' },
        anchor: processAnchor,
      });

      expect(result.identity.userId).toBe('from-auth');
      expect(result.identity.resolvedFrom).toBe('authInfo');
    });

    it('serverIdentity wins over anchor', () => {
      const result = resolveIdentityFromChain({
        serverIdentity: { userId: 'from-server' },
        anchor: processAnchor,
      });

      expect(result.identity.userId).toBe('from-server');
      expect(result.identity.resolvedFrom).toBe('explicit');
    });
  });

  describe('error resilience', () => {
    it('falls through to next level when resolveIdentity throws', () => {
      const log = mockLogger();
      const resolver: IdentityResolver = () => {
        throw new Error('auth service down');
      };

      const result = resolveIdentityFromChain({
        resolveIdentity: resolver,
        authInfo: {},
        serverIdentity: { userId: 'fallback-server' },
        anchor: sessionAnchor,
        logger: log,
      });

      expect(result.identity.userId).toBe('fallback-server');
      expect(result.identity.resolvedFrom).toBe('explicit');
      expect(log.calls.warn).toHaveLength(1);
      expect(log.calls.warn[0]).toContain('auth service down');
    });

    it('falls through to anchor when resolveIdentity throws and no serverIdentity', () => {
      const log = mockLogger();
      const resolver: IdentityResolver = () => {
        throw new TypeError('cannot read property');
      };

      const result = resolveIdentityFromChain({
        resolveIdentity: resolver,
        authInfo: {},
        anchor: sessionAnchor,
        logger: log,
      });

      expect(result.identity.resolvedFrom).toBe('anchor');
      expect(log.calls.warn).toHaveLength(1);
    });

    it('warns when resolveIdentity returns empty', () => {
      const log = mockLogger();
      const resolver: IdentityResolver = () => ({});

      resolveIdentityFromChain({
        resolveIdentity: resolver,
        authInfo: {},
        anchor: sessionAnchor,
        logger: log,
      });

      expect(log.calls.warn).toHaveLength(1);
      expect(log.calls.warn[0]).toContain('returned empty');
    });

    it('warns when resolveIdentity returns a too-short userId', () => {
      const log = mockLogger();
      const resolver: IdentityResolver = () => ({ userId: 'ab' });

      const result = resolveIdentityFromChain({
        resolveIdentity: resolver,
        authInfo: {},
        anchor: sessionAnchor,
        logger: log,
      });

      expect(result.identity.userId).toBe('ab');
      expect(result.identity.resolvedFrom).toBe('authInfo');
      expect(log.calls.warn).toHaveLength(1);
      expect(log.calls.warn[0]).toContain('shorter than 5');
    });

    it('warns when serverIdentity has a too-short deviceId', () => {
      const log = mockLogger();

      resolveIdentityFromChain({
        serverIdentity: { userId: 'valid-user', deviceId: 'xy' },
        anchor: processAnchor,
        logger: log,
      });

      expect(log.calls.warn).toHaveLength(1);
      expect(log.calls.warn[0]).toContain('deviceId');
      expect(log.calls.warn[0]).toContain('shorter than 5');
    });

    it('does not warn when IDs are long enough', () => {
      const log = mockLogger();
      const resolver: IdentityResolver = () => ({ userId: 'alice@example.com' });

      resolveIdentityFromChain({
        resolveIdentity: resolver,
        authInfo: {},
        anchor: sessionAnchor,
        logger: log,
      });

      expect(log.calls.warn).toHaveLength(0);
    });
  });
});
