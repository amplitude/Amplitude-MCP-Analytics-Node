import { randomBytes } from 'node:crypto';

/**
 * Capture-mode sanitization.
 *
 * Everything the capture harness retains passes through here BEFORE it touches
 * disk or stderr. Two mechanisms:
 *
 *   - aliases: opaque ids (session ids, insert ids, user ids, progress
 *     tokens) become `p<hex>-<kind>-<n>` so records can still be joined
 *     without exposing the raw value. The raw→alias map lives in memory only
 *     and is never persisted.
 *   - scrubbing: retained strings get local path names, emails, and long
 *     tokens replaced, and are truncated.
 */

const MAX_STRING = 300;

export interface Aliaser {
  /** `p` + 6 random hex chars, unique per process. */
  prefix: string;
  /** Stable per-raw-value alias: `<prefix>-<kind>-<n>`. */
  alias: (kind: string, raw: string) => string;
}

export function createAliaser(prefix: string = `p${randomBytes(3).toString('hex')}`): Aliaser {
  const seen = new Map<string, string>();
  const counters = new Map<string, number>();
  return {
    prefix,
    alias: (kind, raw) => {
      const key = `${kind}${raw}`;
      const existing = seen.get(key);
      if (existing !== undefined) return existing;
      const n = (counters.get(kind) ?? 0) + 1;
      counters.set(kind, n);
      const aliased = `${prefix}-${kind}-${n}`;
      seen.set(key, aliased);
      return aliased;
    },
  };
}

const HOME_PATH = /\/(Users|home)\/[^/\s]+/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const UUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const TOKEN = /[A-Za-z0-9+/=_-]{24,}/g;

/** Replace identifying substrings, then cap the length. */
export function scrubString(value: string): string {
  const scrubbed = value
    .replace(HOME_PATH, '/Users/<user>')
    .replace(EMAIL, '<email>')
    .replace(UUID, '<id>')
    .replace(TOKEN, (match) => (/[0-9+/=]/.test(match) ? `<id len=${match.length}>` : match));
  return scrubbed.length > MAX_STRING ? `${scrubbed.slice(0, MAX_STRING)}…<truncated>` : scrubbed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Scrub a retained scalar without coercing. Missing keys are handled by the
 * caller; this preserves `null`, `''`, and non-strings so a missing field
 * stays distinguishable from an empty one.
 */
function scrubField(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return `<${Array.isArray(value) ? 'array' : typeof value}>`;
}

const CLIENT_INFO_KEYS = ['name', 'version', 'title'] as const;

/** `{name, version, title}` only, each scrubbed; other keys dropped. */
function sanitizeClientInfo(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value === undefined ? undefined : scrubField(value);
  const out: Record<string, unknown> = {};
  for (const key of CLIENT_INFO_KEYS) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      out[key] = scrubField((value as Record<string, unknown>)[key]);
    }
  }
  return out;
}

const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo';
const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_PROGRESS_TOKEN = 'progressToken';
const BASELINE_MESSAGE = /^baseline-[A-Za-z0-9_.-]+-call-[0-9]+$/;

function sanitizeMeta(meta: Record<string, unknown>, aliaser: Aliaser): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const otherKeys: string[] = [];
  for (const key of Object.keys(meta).sort()) {
    const value = meta[key];
    if (key === META_CLIENT_INFO || key === 'clientInfo') {
      out[key] = sanitizeClientInfo(value);
    } else if (key === META_PROTOCOL_VERSION) {
      out[key] = scrubField(value);
    } else if (key === META_PROGRESS_TOKEN) {
      out[key] = typeof value === 'string' || typeof value === 'number' ? aliaser.alias('tok', String(value)) : value;
    } else {
      otherKeys.push(key);
    }
  }
  if (otherKeys.length > 0) out.metaKeys = otherKeys;
  return out;
}

function sanitizeToolCallParams(params: Record<string, unknown>, aliaser: Aliaser): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (Object.prototype.hasOwnProperty.call(params, 'name')) out.name = scrubField(params.name);
  const args = params.arguments;
  if (isRecord(args)) {
    out.argumentKeys = Object.keys(args).sort();
    if (Object.prototype.hasOwnProperty.call(args, 'message')) {
      const message = args.message;
      if (typeof message === 'string') {
        out.message = BASELINE_MESSAGE.test(message) ? message : `<redacted len=${message.length}>`;
      } else {
        out.message = scrubField(message);
      }
    }
  }
  // _meta rides inside params on requests, same allowlist as top level.
  if (isRecord(params._meta)) out._meta = sanitizeMeta(params._meta, aliaser);
  return out;
}

/**
 * One client→server JSON-RPC message, reduced to an allowlisted shape.
 * Requests keep `id`, `method`, and selected `params` fields; responses keep
 * `id`, `hasResult`, and `errorCode`. Non-object input is recorded scrubbed.
 */
export function sanitizeMessage(message: unknown, aliaser: Aliaser): Record<string, unknown> {
  if (!isRecord(message)) {
    return { unparsed: typeof message === 'string' ? scrubString(message) : `<${typeof message}>` };
  }
  const out: Record<string, unknown> = {};
  if (Object.prototype.hasOwnProperty.call(message, 'id')) {
    const id = message.id;
    out.id = typeof id === 'string' || typeof id === 'number' || id === null ? id : '<id>';
  }
  if (typeof message.method === 'string') {
    out.method = message.method;
    const params = message.params;
    if (isRecord(params)) {
      const sanitized =
        message.method === 'tools/call' ? sanitizeToolCallParams(params, aliaser) : sanitizeRequestParams(params, aliaser);
      if (Object.keys(sanitized).length > 0) out.params = sanitized;
    }
    return out;
  }
  // A response from the client (e.g. sampling/roots result): shape only.
  out.hasResult = isRecord(message) && Object.prototype.hasOwnProperty.call(message, 'result');
  if (isRecord(message.error)) out.errorCode = scrubField(message.error.code);
  return out;
}

function sanitizeRequestParams(params: Record<string, unknown>, aliaser: Aliaser): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (Object.prototype.hasOwnProperty.call(params, 'protocolVersion')) {
    out.protocolVersion = scrubField(params.protocolVersion);
  }
  if (Object.prototype.hasOwnProperty.call(params, 'clientInfo')) {
    out.clientInfo = sanitizeClientInfo(params.clientInfo);
  }
  if (isRecord(params.capabilities)) {
    out.capabilities = { keys: Object.keys(params.capabilities).sort() };
  }
  if (isRecord(params._meta)) {
    out._meta = sanitizeMeta(params._meta, aliaser);
  }
  return out;
}

const KEEP_VALUE_HEADERS = new Set(['user-agent', 'mcp-protocol-version', 'accept', 'content-type']);
const PRESENCE_HEADERS = new Set(['authorization', 'cookie', 'last-event-id', 'traceparent']);

export function sanitizeHeaders(
  headers: Record<string, string | string[] | undefined>,
  aliaser: Aliaser,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const names = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort();
  out.headerNames = names;
  for (const name of names) {
    const raw = headers[name];
    const value = Array.isArray(raw) ? raw.join(', ') : raw;
    if (value === undefined) continue;
    if (KEEP_VALUE_HEADERS.has(name)) {
      out[name] = scrubString(value);
    } else if (name === 'mcp-session-id') {
      out[name] = aliaser.alias('sess', value);
    } else if (PRESENCE_HEADERS.has(name)) {
      out[name] = true;
    }
  }
  return out;
}

/** event_properties keys whose values are safe to keep (scrubbed). */
const KEEP_VALUE_PROPS = new Set([
  '[MCP] Client Name',
  '[MCP] Client Version',
  '[MCP] User Agent',
  '[MCP] Protocol Version',
  '[MCP] Transport',
  '[MCP] Server Name',
  '[MCP] Server Version',
  '[MCP] Server Type',
  '[MCP] Tool Name',
  '[MCP] Is Error',
  '[MCP] Anchor Type',
  '[MCP] Episode Anchor Type',
  '[MCP] Episode Anchor Confidence',
  '[MCP] Auth Type',
  '[MCP] Error Code',
]);

/** event_properties keys that hold opaque ids → alias. */
const ALIAS_PROPS = new Map<string, string>([
  ['[MCP] Session ID', 'sess'],
  ['[MCP] Run ID', 'run'],
  ['[MCP] Conversation ID', 'conv'],
  ['[MCP] Turn ID', 'turn'],
  ['[MCP] Subject ID', 'subj'],
  ['[MCP] OAuth Client ID', 'oauth'],
]);

/** Future identity-related fields we want the value of even before they exist. */
const KEEP_VALUE_PROP_PATTERN = /client|agent|attribution|family|surface|provenance|source/i;

/** One Amplitude event, reduced to what the harness needs to verify delivery. */
export function sanitizeEvent(event: Record<string, unknown>, aliaser: Aliaser): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const otherKeys: string[] = [];
  for (const key of Object.keys(event).sort()) {
    const value = event[key];
    if (key === 'event_type' || key === 'time') {
      out[key] = scrubField(value);
    } else if (key === 'insert_id') {
      out[key] = typeof value === 'string' ? aliaser.alias('ins', value) : scrubField(value);
    } else if (key === 'user_id' || key === 'device_id' || key === 'session_id') {
      out[key] = typeof value === 'string' ? aliaser.alias(key.replace('_id', ''), value) : scrubField(value);
    } else if (key === 'event_properties' && isRecord(value)) {
      out[key] = sanitizeEventProperties(value, aliaser);
    } else if (key === 'user_properties' || key === 'groups') {
      out[key === 'groups' ? 'groupKeys' : 'userPropertyKeys'] = isRecord(value) ? Object.keys(value).sort() : [];
    } else {
      otherKeys.push(key);
    }
  }
  if (otherKeys.length > 0) out.otherKeys = otherKeys;
  return out;
}

function sanitizeEventProperties(props: Record<string, unknown>, aliaser: Aliaser): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const otherPropertyKeys: string[] = [];
  for (const key of Object.keys(props).sort()) {
    const value = props[key];
    if (KEEP_VALUE_PROPS.has(key) || KEEP_VALUE_PROP_PATTERN.test(key)) {
      out[key] = scrubField(value);
    } else if (ALIAS_PROPS.has(key)) {
      const kind = ALIAS_PROPS.get(key) ?? 'id';
      out[key] = typeof value === 'string' ? aliaser.alias(kind, value) : scrubField(value);
    } else {
      otherPropertyKeys.push(key);
    }
  }
  if (otherPropertyKeys.length > 0) out.otherPropertyKeys = otherPropertyKeys;
  return out;
}

/**
 * One HTTP V2 ingestion body (`{api_key, events, options}`) reduced to its
 * sanitized events so a batch can be joined to `events.ndjson` by insert id.
 */
export function sanitizeIngestionBody(body: unknown, aliaser: Aliaser): Record<string, unknown> {
  const out: Record<string, unknown> = { otherKeys: [] as string[] };
  const otherKeys: string[] = [];
  const events: unknown[] = [];
  if (isRecord(body)) {
    for (const key of Object.keys(body).sort()) {
      if (key === 'events' && Array.isArray(body.events)) {
        for (const event of body.events) {
          events.push(sanitizeEvent(isRecord(event) ? event : {}, aliaser));
        }
      } else if (key === 'api_key') {
        out.api_key = body.api_key !== undefined;
      } else {
        otherKeys.push(key);
      }
    }
  }
  out.events = events;
  if (otherKeys.length > 0) out.otherKeys = otherKeys;
  else delete out.otherKeys;
  return out;
}
