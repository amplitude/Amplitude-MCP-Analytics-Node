import type { McpClientInfo } from './types.js';

type ClientIdentity = Pick<McpClientInfo, 'name' | 'version' | 'nameSource'>;
type ClientFamily = { family: string; surface?: string };
export type FamilySource = 'client-name' | 'user-agent' | 'none';

const NAME_FAMILIES = new Map<string, ClientFamily>([
  ['claude-code', { family: 'claude-code' }],
  ['anthropic/claudeai', { family: 'claude' }],
  ['anthropic/toolbox', { family: 'claude' }],
  ['codex-mcp-client', { family: 'codex' }],
  ['cursor', { family: 'cursor' }],
  ['cursor-vscode', { family: 'cursor', surface: 'vscode' }],
  ['openai-mcp', { family: 'chatgpt' }],
  ['cline', { family: 'cline' }],
  ['gemini-cli-mcp-client', { family: 'gemini-cli' }],
  ['opencode', { family: 'opencode' }],
  ['roo code', { family: 'roo-code' }],
  ['visual studio code', { family: 'vscode' }],
  ['code - oss', { family: 'vscode' }],
  ['zed', { family: 'zed' }],
]);
const UA_FAMILIES = new Map<string, string>([
  ['claude-code', 'claude-code'],
  ['codex-mcp-client', 'codex'],
  ['cursor', 'cursor'],
  ['openai-mcp', 'chatgpt'],
]);

/** Validate a signal without changing the value reported by the client or host. @internal */
export function clientString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/** Read the raw identity pair from a single source. @internal */
export function readClientIdentity(
  value: unknown,
  nameSource: ClientIdentity['nameSource'],
): ClientIdentity {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return {};
  const name = 'name' in value ? clientString(value.name) : undefined;
  return { name, version: 'version' in value ? clientString(value.version) : undefined, nameSource };
}

/** A named identity wins as a pair. Keep a standalone version only without a name. @internal */
export function selectClientIdentity(...candidates: ClientIdentity[]): ClientIdentity {
  return candidates.find((candidate) => candidate.name != null)
    ?? candidates.find((candidate) => candidate.version != null)
    ?? {};
}

/** Default an unlabelled host-supplied name to host attribution. @internal */
export function clientNameSource(client: McpClientInfo | undefined): NonNullable<McpClientInfo['nameSource']> {
  if (clientString(client?.name) == null) return 'none';
  switch (client?.nameSource) {
    case 'request-metadata':
    case 'handshake':
    case 'oauth':
      return client.nameSource;
    default:
      return 'host';
  }
}

function matchName(value: unknown): ClientFamily | undefined {
  const name = clientString(value)?.trim().toLowerCase();
  if (name == null) return undefined;
  const unbridged = name.replace(/ \(via mcp-remote [0-9][a-z0-9.+-]*\)$/, '');
  if (/^local-agent-mode-\S+$/.test(unbridged)) return { family: 'claude', surface: 'desktop' };
  return NAME_FAMILIES.get(unbridged);
}

function matchUserAgent(value: unknown): ClientFamily | undefined {
  const ua = clientString(value)?.trim().toLowerCase();
  if (ua === 'claude-user') return { family: 'claude' };
  const match = /^([a-z-]+)\/[0-9][a-z0-9.+-]*(?:\s+\(([^()]*)\))?$/.exec(ua ?? '');
  const family = match?.[1] != null ? UA_FAMILIES.get(match[1]) : undefined;
  if (family == null) return undefined;
  return { family, surface: family === 'claude-code' && match?.[2] === 'sdk-cli' ? 'cli' : undefined };
}

/** Shared by default and custom events. Does not modify the raw client fields. @internal */
export function resolveClientFamily(
  client: McpClientInfo | undefined,
): ClientFamily & { familySource: FamilySource } {
  const fromName = matchName(client?.name);
  const fromUserAgent = matchUserAgent(client?.userAgent);
  if (fromName != null) {
    return {
      family: fromName.family,
      surface: fromName.surface ?? (fromName.family === fromUserAgent?.family ? fromUserAgent?.surface : undefined),
      familySource: 'client-name',
    };
  }
  if (fromUserAgent != null) return { ...fromUserAgent, familySource: 'user-agent' };
  return { family: 'Other', familySource: 'none' };
}
