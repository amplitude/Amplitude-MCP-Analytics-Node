/**
 * Pure mapper from the typed MCP `ctx` to Amplitude event payload fields. This
 * is the seam every emit site — `trackServerEvent`, `trackToolEvent`, and the
 * forthcoming default-event tracks — lowers through.
 *
 * Per-tenant `extra` enrichment values are spread onto `event_properties`
 * after the typed fields, so a host can surface domain values without a custom 
 * emit path. Caller-supplied properties on the `track*` methods always win over both.
 */
import { clientNameSource, clientString, resolveClientFamily } from '../context/client-attribution.js';
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
  const client = ctx.client;
  const { family, surface, familySource } = resolveClientFamily(client);
  const eventFields: DefaultServerFields = {
    sessionId: ctx.anchor.type === 'session-id' ? ctx.anchor.value : NO_SESSION,
    clientName: clientString(client?.name) ?? UNKNOWN,
    clientNameSource: clientNameSource(client),
    clientFamilySource: familySource,
    serverName: ctx.server.name,
    transport: ctx.transport,
    anchorType: ctx.anchor.type,
  };

  const version = clientString(client?.version);
  if (version != null) eventFields.clientVersion = version;
  const userAgent = clientString(client?.userAgent);
  if (userAgent != null) eventFields.userAgent = userAgent;
  const oauthClientId = clientString(client?.oauthClientId);
  if (oauthClientId != null) eventFields.oauthClientId = oauthClientId;
  if (family != null) eventFields.clientFamily = family;
  if (surface != null) eventFields.clientSurface = surface;
  if (ctx.server.version != null) eventFields.serverVersion = ctx.server.version;
  if (ctx.server.type != null) eventFields.serverType = ctx.server.type;
  const protocolVersion = clientString(ctx.protocolVersion);
  if (protocolVersion != null) eventFields.protocolVersion = protocolVersion;
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
  const rationale = ctx.request?.rationale;
  if (typeof rationale === 'string' && rationale.length > 0) {
    fields.rationale = rationale;
  }
  const responseHttpStatus = ctx.request?.responseHttpStatus;
  if (typeof responseHttpStatus === 'number') {
    fields.responseHttpStatus = responseHttpStatus;
  }
  if (ctx.correlation != null) {
    if (ctx.correlation.conversationId != null) {
      fields.conversationId = ctx.correlation.conversationId;
    }
    if (ctx.correlation.runId != null) fields.runId = ctx.correlation.runId;
    if (ctx.correlation.turnId != null) fields.turnId = ctx.correlation.turnId;
    if (ctx.correlation.subjectId != null) fields.subjectId = ctx.correlation.subjectId;
    fields.episodeAnchorType = ctx.correlation.episodeAnchorType;
    fields.episodeAnchorConfidence = ctx.correlation.episodeAnchorConfidence;
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
 * Emit gate for the fully anonymous floor. When the subject resolved to the
 * per-request anonymous floor (`resolvedFrom === 'anonymous'`) and there is no
 * tenant, the event carries only a synthetic `device_id` that never recurs
 * (a fresh id per request, no cross-call stitching). Emitting these by default
 * inflates unique-user/device counts with noise, so they are dropped unless the
 * consumer opts in via `config.emitAnonymousEvent` (stamped onto the ctx as
 * {@link McpServerContext.emitAnonymousEvent}). Any non-anonymous subject or any
 * tenant always emits.
 */
export function shouldEmit(ctx: McpServerContext): boolean {
  if (ctx.emitAnonymousEvent) return true;
  if (ctx.identity.resolvedFrom === 'anonymous' && ctx.tenant == null) return false;
  return true;
}
