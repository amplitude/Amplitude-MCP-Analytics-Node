import { describe, expect, it } from 'vitest';
import { resolveIdentityFromChain } from '../src/core/identity.js';
import type { McpAnchor, IdentityResolver, McpTenant } from '../src/context/types.js';

const processAnchor: McpAnchor = { type: 'process', value: '12345' };
const sessionAnchor: McpAnchor = { type: 'session-id', value: 'sess-abc' };
const traceAnchor: McpAnchor = { type: 'trace', value: '4bf92f3577b34da6a3ce929d0e0e4736' };
const anonAnchor: McpAnchor = { type: 'anonymous', value: 'aaa-bbb-ccc' };

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
      expect(result.identity.deviceId!.length).toBeGreaterThanOrEqual(5);
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
      expect(result.identity.deviceId!.length).toBeGreaterThanOrEqual(5);
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
});
