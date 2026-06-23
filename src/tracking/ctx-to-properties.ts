/**
 * Pure mapper from the typed MCP `ctx` to Amplitude event payload fields. This
 * is the seam every emit site — `trackServerEvent`, `trackToolEvent`, and the
 * forthcoming default-event tracks — lowers through.
 *
 * Per-tenant `extra` enrichment values are spread onto `event_properties`
 * after the typed fields, so a host can surface domain values without a custom 
 * emit path. Caller-supplied properties on the `track*` methods always win over both.
 */
import type { McpServerContext, McpToolContext } from '../context/types.js';
import { EVENT_PROPERTY_KEYS, NO_SESSION, UNKNOWN } from './constants.js';
import type { AmplitudeFields, DefaultServerFields, DefaultToolFields } from './types.js';


/**
 * Lower an {@link McpServerContext} to the Amplitude payload fields shared by
 * every event the SDK emits. Server-scope events (e.g. `trackServerEvent) consume 
 * this directly; tool-scope events go through {@link ctxToAmplitudeFieldsForTool} 
 * which extends the result.
 */
export function ctxToAmplitudeFields(ctx: McpServerContext): AmplitudeFields<DefaultServerFields> {
  const eventFields: DefaultServerFields = {
    sessionId: ctx.anchor.type === 'session-id' ? ctx.anchor.value : NO_SESSION,
    clientName: ctx.client?.name ?? UNKNOWN,
    userAgent: ctx.client?.userAgent ?? UNKNOWN,
    serverName: ctx.server.name,
    transport: ctx.transport,
    anchorType: ctx.anchor.type,
  };

  if (ctx.client?.version != null) eventFields.clientVersion = ctx.client.version;
  if (ctx.server.version != null) eventFields.serverVersion = ctx.server.version;
  if (ctx.server.type != null) eventFields.serverType = ctx.server.type;
  if (ctx.protocolVersion != null) eventFields.protocolVersion = ctx.protocolVersion;
  if (ctx.authType != null) eventFields.authType = ctx.authType;

  const fields: AmplitudeFields<DefaultServerFields> = {
    event_properties: eventFields,
    extraProperties: { ...ctx.extra },
  };
  if (ctx.identity.userId != null) fields.user_id = ctx.identity.userId;
  if (ctx.identity.deviceId != null) fields.device_id = ctx.identity.deviceId;
  if (ctx.tenant != null) fields.groups = { [ctx.tenant.groupType]: ctx.tenant.groupValue };
  return fields;
}

/**
 * Lower an {@link McpToolContext} — adds the tool-scope properties on top of
 * {@link ctxToAmplitudeFields}. Tool metadata is read from `ctx.tool` via the
 * forward-compatible index access.
 */
export function ctxToAmplitudeFieldsForTool(ctx: McpToolContext): AmplitudeFields<DefaultToolFields> {
  const base = ctxToAmplitudeFields(ctx);
  const fields: DefaultToolFields = { ...base.event_properties, toolName: ctx.tool.name };

  if (ctx.tool.owner != null) fields.toolOwner = ctx.tool.owner;
  const tags = ctx.tool.tags;
  if (Array.isArray(tags) && tags.length > 0) fields.toolTags = tags as string[];
  const category = ctx.tool.category;
  if (typeof category === 'string' && category.length > 0) {
    fields.toolCategory = category;
  }

  return {
    ...base,
    event_properties: fields,
    extraProperties: { ...base.extraProperties, ...(ctx.tool.extra ?? {}) }
  };
}

/**
 * Convert reserved fields to their wire property names via
 * {@link EVENT_PROPERTY_KEYS}. Undefined fields are skipped. @internal
 */
export function reservedFieldsToProperties(
  fields: DefaultServerFields | DefaultToolFields,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value == null) continue;
    const wireKey = EVENT_PROPERTY_KEYS[key as keyof typeof EVENT_PROPERTY_KEYS];
    if (wireKey != null) out[wireKey] = value;
  }
  return out;
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
