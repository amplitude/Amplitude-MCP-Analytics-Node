/**
 * Pure mapper from the typed MCP `ctx` to Amplitude event payload fields. This
 * is the seam every emit site — `trackServerEvent`, `trackToolEvent`, and the
 * forthcoming default-event tracks (MCP-358, MCP-363) — lowers through, so the
 * cross-cutting property names per audit §8 are defined exactly once here.
 *
 * Property naming follows the audit's lowercase-with-spaces convention (e.g.
 * `'org id'`, `'session id'`). Missing fields fall back to documented
 * sentinels (`'no-session'`, `'no-trace-id'`, `'unknown'`) per the audit; no
 * field is ever synthesized from a random value.
 *
 * Per-tenant `extra` enrichment values are spread onto `event_properties`
 * after the typed fields, so a host can surface domain values (e.g. `org url`,
 * `user email`) without a custom emit path. Caller-supplied properties on the
 * `track*` methods always win over both.
 */
import type { McpServerContext, McpToolContext } from '../context/types.js';
import type { AmplitudeFields } from './types.js';

const NO_SESSION = 'no-session';
const NO_TRACE_ID = 'no-trace-id';
const UNKNOWN = 'unknown';

/**
 * Lower an {@link McpServerContext} to the Amplitude payload fields shared by
 * every event the SDK emits. Server-scope events (`trackServerEvent`, plus
 * MCP-363's connection events) consume this directly; tool-scope events go
 * through {@link ctxToAmplitudeFieldsForTool} which extends the result.
 */
export function ctxToAmplitudeFields(ctx: McpServerContext): AmplitudeFields {
  const event_properties: Record<string, unknown> = {
    // Cross-cutting properties per audit §8 (sentinels when absent).
    'session id': ctx.anchor.type === 'session-id' ? ctx.anchor.value : NO_SESSION,
    'trace id': ctx.traceId ?? NO_TRACE_ID,
    'client name': ctx.client?.name ?? UNKNOWN,
    'user agent': ctx.client?.userAgent ?? UNKNOWN,
    // Server identity — attached to every event.
    'server name': ctx.server.name,
    transport: ctx.transport,
    // Identity provenance is a useful debug dimension even when userId is set.
    'identity resolved from': ctx.identity.resolvedFrom,
    // Anchor type lets queries split sessionful vs trace-only vs anonymous floor.
    'anchor type': ctx.anchor.type,
  };

  if (ctx.client?.version != null) event_properties['client version'] = ctx.client.version;
  if (ctx.server.version != null) event_properties['server version'] = ctx.server.version;
  if (ctx.server.type != null) event_properties['server type'] = ctx.server.type;
  if (ctx.protocolVersion != null) event_properties['protocol version'] = ctx.protocolVersion;
  if (ctx.authType != null) event_properties['auth type'] = ctx.authType;
  if (ctx.tenant != null) event_properties[ctx.tenant.groupType] = ctx.tenant.groupValue;

  // Host-supplied enrichment (e.g. `org url`, `user email`) — spread after typed
  // fields so domain values surface, but before caller-supplied properties on
  // the track*-method, which win on collision.
  if (ctx.extra != null) Object.assign(event_properties, ctx.extra);

  const fields: AmplitudeFields = { event_properties };
  if (ctx.identity.userId != null) fields.user_id = ctx.identity.userId;
  if (ctx.identity.deviceId != null) fields.device_id = ctx.identity.deviceId;
  if (ctx.tenant != null) fields.groups = { [ctx.tenant.groupType]: ctx.tenant.groupValue };
  return fields;
}

/**
 * Lower an {@link McpToolContext} — adds the tool-scope properties on top of
 * {@link ctxToAmplitudeFields}. Tool metadata is read from `ctx.tool` via the
 * forward-compatible index access (only `name` and `owner` are typed; the rest
 * — `tags`, `category`, `projectId`, `projectName` — are free-form per the ctx
 * contract).
 */
export function ctxToAmplitudeFieldsForTool(ctx: McpToolContext): AmplitudeFields {
  const base = ctxToAmplitudeFields(ctx);
  base.event_properties['tool name'] = ctx.tool.name;
  if (ctx.tool.owner != null) base.event_properties['tool owner'] = ctx.tool.owner;
  const tags = ctx.tool.tags;
  if (Array.isArray(tags) && tags.length > 0) base.event_properties['tool tags'] = tags;
  const category = ctx.tool.category;
  if (typeof category === 'string' && category.length > 0) {
    base.event_properties['tool category'] = category;
  }
  const projectId = ctx.tool.projectId;
  if (typeof projectId === 'string' && projectId.length > 0) {
    base.event_properties['project id'] = projectId;
  }
  const projectName = ctx.tool.projectName;
  if (typeof projectName === 'string' && projectName.length > 0) {
    base.event_properties['project name'] = projectName;
  }
  if (ctx.request?.method != null) base.event_properties['request method'] = ctx.request.method;
  return base;
}

/**
 * Audit §2 skip rule: drop emission when the subject is anonymous AND no
 * tenant is set — the event would carry neither identity nor org dimension and
 * is unusable. Hosts that need to emit pre-resolution (the two exceptions in
 * audit §2 — `mcp: auth org mismatch` and `mcp: slack identity auth`) build a
 * ctx with a non-anonymous identity through {@link
 * import('../context/index.js').createServerContext} before calling track*.
 */
export function shouldEmit(ctx: McpServerContext): boolean {
  if (ctx.identity.resolvedFrom === 'anonymous' && ctx.tenant == null) return false;
  return true;
}
