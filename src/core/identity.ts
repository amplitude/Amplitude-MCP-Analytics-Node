/**
 * Identity resolution: the fallback chain that always yields a valid
 * Amplitude identity (user_id and/or device_id, each >= 5 chars).
 *
 * Fallback order (first match wins):
 *   1. `setIdentity()` called during this request         → 'explicit'
 *   2. `resolveIdentity(authInfo)` returns non-empty      → 'authInfo'
 *   3. Static identity from `instrumentServer` opts       → 'explicit'
 *   4. Correlation anchor available                       → 'anchor'
 *   5. No anchor (anonymous per-request floor)            → 'anonymous'
 *
 * setIdentity is applied lazily (the handler mutates ctx via setIdentity during
 * execution) — this module handles the fallback chain.
 *
 * @internal
 */
import { createHash, randomUUID } from 'node:crypto';
import type {
  IdentityResolver,
  McpAnchor,
  McpIdentity,
  McpTenant,
} from '../context/types.js';
import type { Logger } from '../utils/logger.js';

const MIN_ID_LENGTH = 5;

/**
 * Private namespace for anchor-derived device ids: `device_id` is
 * `uuidv5(AMP_MCP_NAMESPACE, "<anchorType>:<anchorValue>")`, per RFC 9562 §5.5.
 *
 * This is a randomly minted v4 UUID owned by this SDK, and it has to stay that
 * way. Through v0.4.1 the value was `6ba7b812-9dad-11d1-80b4-00c04fd430c8`,
 * which is not a private namespace at all — it is `NameSpace_OID`, one of the
 * four namespaces reserved by RFC 9562 Appendix A. Hashing under a globally
 * published constant forfeits the only thing the namespace argument buys you:
 * any other system that hashes a colliding name under the same reserved value
 * derives a byte-identical id, and every `device_id` becomes reproducible — and
 * so reversible, wherever the anchor space is small — by anyone who reads the
 * spec.
 *
 * Changing it re-derives every anchor-derived `device_id`, so a server's
 * existing devices all become new ones and continuity with everything already
 * reported breaks. That cost was worth paying once, to get off a public
 * constant; it is not worth paying again. (`user_id` is the raw anchor key, so
 * only `device_id` is derived through here.)
 *
 * The Python `amplitude-mcp-analytics` SDK uses the same namespace and the same
 * derivation, and the two must change together. That parity is not about one
 * subject reaching both SDKs — anchors are server-side (a process id, a session
 * id this server minted), so two servers do not normally share one. It matters
 * when a *server* moves between the SDKs: the same session id or propagated
 * trace id keeps mapping to the same device across the cutover, instead of
 * resetting that server's whole device population.
 */
const AMP_MCP_NAMESPACE = 'f08626eb-3a5c-4f3a-bec2-227ab3178022';

/**
 * Generate a UUID v5 (SHA-1 name-based) from a namespace UUID and a name string.
 * Follows RFC 9562 §5.5.
 *
 * Hand-rolled because this package carries no runtime dependencies. That is
 * worth a word, since name-based UUIDs are easy to get subtly wrong: the
 * classic trap is byte order, and it does not apply here. It bites .NET, where
 * `System.Guid` stores its first three fields in native-endian order and has to
 * be swapped to reach the RFC's network byte order. A UUID's hex text is
 * already network byte order, so parsing it with `Buffer.from(hex)` needs no
 * swap — and none is performed.
 *
 * `test/identity.test.ts` pins this against published RFC v5 vectors so the
 * claim is checked rather than asserted.
 *
 * Note the argument order: **name first, namespace second** — the reverse of
 * the RFC's own phrasing and of most libraries.
 *
 * @internal — not re-exported from `src/index.ts`; exported only for tests.
 */
export function uuidv5(name: string, namespace: string): string {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1').update(nsBytes).update(name).digest();
  const b6 = hash[6] ?? 0;
  const b8 = hash[8] ?? 0;
  hash[6] = (b6 & 0x0f) | 0x50;
  hash[8] = (b8 & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Static identity passed to `instrumentServer()` — server identity of the chain. */
export interface ServerIdentity {
  userId?: string;
  deviceId?: string;
  tenant?: McpTenant;
}

/** All inputs the fallback chain needs to resolve identity for one request. */
export interface ResolveIdentityInput {
  resolveIdentity?: IdentityResolver;
  authInfo?: Record<string, unknown>;
  serverIdentity?: ServerIdentity;
  anchor: McpAnchor;
  logger?: Logger;
}

/** The result of identity resolution: identity + optional tenant override. */
export interface ResolvedIdentity {
  identity: McpIdentity;
  tenant?: McpTenant;
}

/**
 * Run the fallback chain. setIdentity is handled lazily
 * by the ALS module during handler execution.
 */
export function resolveIdentityFromChain(input: ResolveIdentityInput): ResolvedIdentity {
  // resolveIdentity callback (Streamable HTTP / OAuth path)
  if (input.resolveIdentity != null) {
    try {
      const resolved = input.resolveIdentity(input.authInfo);
      if (resolved.userId != null || resolved.deviceId != null) {
        const identity = applyAnchorFallback(
          { resolvedFrom: 'authInfo', userId: resolved.userId, deviceId: resolved.deviceId },
          input.anchor,
        );
        warnShortIds(input.logger, identity, 'resolveIdentity');

        return { identity, tenant: resolved.tenant };
      }
      input.logger?.warn('resolveIdentity callback returned empty — falling through to next identity level.');
    } catch (err) {
      input.logger?.warn(
        `resolveIdentity callback threw: ${err instanceof Error ? err.message : String(err)} — falling back to next identity level.`,
      );
    }
  }

  // server identity from instrumentServer opts (stdio / single-user)
  if (input.serverIdentity != null) {
    const si = input.serverIdentity;
    if (si.userId != null || si.deviceId != null) {
      const identity = applyAnchorFallback(
        { resolvedFrom: 'explicit', userId: si.userId, deviceId: si.deviceId },
        input.anchor,
      );
      warnShortIds(input.logger, identity, 'instrumentServer');

      return { identity, tenant: si.tenant };
    }
  }

  // anchor-based identity
  if (input.anchor.type !== 'anonymous') {
    const anchorKey = `${input.anchor.type}:${input.anchor.value}`;
    return {
      identity: {
        resolvedFrom: 'anchor',
        userId: anchorKey,
        deviceId: uuidv5(anchorKey, AMP_MCP_NAMESPACE),
      },
    };
  }

  // anonymous per-request floor
  const deviceId = randomUUID();
  return {
    identity: {
      resolvedFrom: 'anonymous',
      deviceId,
      userId: `anonymous:${deviceId}`,
    },
  };
}

function warnShortIds(log: Logger | undefined, identity: McpIdentity, source: string): void {
  const description = `Amplitude silently drops IDs shorter than ${MIN_ID_LENGTH} characters.`;
  if (identity.userId != null && identity.userId.length < MIN_ID_LENGTH) {
    log?.warn(
      `${source} returned userId "${identity.userId}" (${identity.userId.length} chars) — ${description}`,
    );
  }

  if (identity.deviceId != null && identity.deviceId.length < MIN_ID_LENGTH) {
    log?.warn(
      `${source} returned deviceId "${identity.deviceId}" (${identity.deviceId.length} chars) — ${description}`,
    );
  }
}

/**
 * If the resolved identity has a userId but no deviceId, derive deviceId from
 * the anchor for cross-call correlation. Explicit deviceId is used as-is.
 */
function applyAnchorFallback(
  identity: McpIdentity,
  anchor: McpAnchor,
): McpIdentity {
  if (identity.deviceId != null) return identity;
  if (anchor.type === 'anonymous') return identity;

  const anchorKey = `${anchor.type}:${anchor.value}`;

  return {
    ...identity,
    deviceId: uuidv5(anchorKey, AMP_MCP_NAMESPACE),
  };
}
