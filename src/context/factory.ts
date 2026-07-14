/**
 * Construction of the MCP context. Caller-supplied values win; unset fields
 * fall back to the anonymous floor (anonymous identity/anchor).
 */
import type { McpToolError } from '../errors.js';
import type {
  McpRequestInfo,
  McpServerContext,
  McpServerInfo,
  McpToolContext,
  McpToolMeta,
  McpTransport,
} from './types.js';

/**
 * Inputs to {@link createServerContext}. `server` and `transport` are required;
 * identity and anchor fall back to the anonymous floor when unset.
 */
export interface CreateServerContextInput
  extends Partial<Omit<McpServerContext, 'server' | 'transport'>> {
  server: McpServerInfo;
  transport: McpTransport;
}

/** Build a server-scope context, flooring identity/anchor when unset. */
export function createServerContext(input: CreateServerContextInput): McpServerContext {
  return {
    tenant: input.tenant,
    identity: input.identity ?? { resolvedFrom: 'anonymous' },
    anchor: input.anchor ?? { type: 'anonymous', value: '' },
    transport: input.transport,
    protocolVersion: input.protocolVersion,
    client: input.client,
    server: input.server,
    authType: input.authType,
    extra: input.extra,
    emitAnonymousEvent: input.emitAnonymousEvent,
  };
}

/**
 * Build a tool-scope context. Pass a resolved server context or server fields
 * inline — either is normalized through {@link createServerContext}, so the
 * floor always applies (a resolved context passes through idempotently).
 */
export function createToolContext(
  base: McpServerContext | CreateServerContextInput,
  tool: McpToolMeta,
  opts?: { request?: McpRequestInfo; error?: McpToolError },
): McpToolContext {
  return {
    ...createServerContext(base),
    tool,
    request: opts?.request,
    error: opts?.error,
  };
}
