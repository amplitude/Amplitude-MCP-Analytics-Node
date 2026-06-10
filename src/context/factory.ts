/**
 * Construction of the MCP context. Caller-supplied values win; unset fields
 * fall back to the always-emit floor (anonymous identity/anchor, stdio).
 */
import type {
  McpRequestInfo,
  McpServerContext,
  McpServerInfo,
  McpToolContext,
  McpToolMeta,
} from './types.js';

/** Inputs to {@link createServerContext}: `server` required, the rest floored when unset. */
export interface CreateServerContextInput
  extends Partial<Omit<McpServerContext, 'server'>> {
  server: McpServerInfo;
}

/** Build a server-scope context, filling unset fields with the floor. */
export function createServerContext(input: CreateServerContextInput): McpServerContext {
  return {
    tenant: input.tenant,
    identity: input.identity ?? { resolvedFrom: 'anonymous' },
    anchor: input.anchor ?? { type: 'anonymous', value: '' },
    transport: input.transport ?? 'stdio',
    protocolVersion: input.protocolVersion,
    client: input.client,
    server: input.server,
  };
}

/**
 * Build a tool-scope context. Pass a resolved server context to extend, or
 * server fields inline to build both at once.
 */
export function createToolContext(
  base: McpServerContext | CreateServerContextInput,
  tool: McpToolMeta,
  extra?: { request?: McpRequestInfo; error?: unknown },
): McpToolContext {
  const server = isServerContext(base) ? base : createServerContext(base);
  return {
    ...server,
    tool,
    request: extra?.request,
    error: extra?.error,
  };
}

function isServerContext(
  base: McpServerContext | CreateServerContextInput,
): base is McpServerContext {
  // Resolved contexts have identity, anchor, and transport filled; raw inputs may not.
  return base.identity != null && base.anchor != null && base.transport != null;
}
