import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Follow one `tools/call` from the client request to the Amplitude ingestion
 * body using the three playground logs. Pure functions do the joining so the
 * same code runs on hand-written fixtures in tests.
 */

/** Key names that look like a correlation id, in `_meta` and in event properties. */
export const CORRELATION_KEY_PATTERN = /(conversation|thread|session|turn|run|job|call|item)_?id/i;

/** How far apart a `track()` call and its ingested event's `time` may be. */
const INGESTION_TIME_WINDOW_MS = 15_000;

const MAX_META_DEPTH = 6;

export interface ChainLogs {
  requests: unknown[];
  tracks: unknown[];
  ingestion: unknown[];
}

export interface CorrelationId {
  /** Dotted key path, e.g. `codex.conversation_id`. */
  path: string;
  value: string | number | boolean | null;
}

export interface ChainRow {
  seq: number | null;
  receivedAt: number | null;
  transport: string | null;
  jsonrpcId: unknown;
  tool: string | null;
  /** Session id the request carried (HTTP header), or the transport assigned during `initialize`. */
  sessionId: string | null;
  response: {
    status: number;
    durationMs: number;
    sessionId: string | null;
    sse: boolean;
    errorBody: string | null;
  } | null;
  metaIds: CorrelationId[];
  track: {
    seq: number;
    at: number;
    event_type: string;
    user_id: string | null;
    device_id: string | null;
    sessionId: string | null;
  } | null;
  ingested: {
    receivedAt: number | null;
    time: number | null;
    insert_id: string | null;
    event_type: string;
    user_id: string | null;
  } | null;
  /** Correlation-shaped properties on the ingested event (or the track record when nothing was ingested). */
  eventIds: CorrelationId[];
  flags: string[];
}

export interface RunSummary {
  runId: string;
  at: number | null;
  pid: number | null;
  transport: string | null;
}

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function parseNdjson(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      out.push(JSON.parse(line) as unknown);
    } catch {
      // Not our line to judge; the chain skips it.
    }
  }
  return out;
}

/** All `run_started` markers in a log, oldest first. */
export function listRuns(records: unknown[]): RunSummary[] {
  const runs: RunSummary[] = [];
  for (const record of records) {
    if (!isDict(record) || record.type !== 'run_started') continue;
    const runId = str(record.runId);
    if (!runId) continue;
    runs.push({ runId, at: num(record.at), pid: num(record.pid), transport: str(record.transport) });
  }
  return runs;
}

/** The run to display: an explicit id, else the most recent marker in the request log. */
export function selectRun(requests: unknown[], explicitRunId?: string): RunSummary | undefined {
  const runs = listRuns(requests);
  if (explicitRunId) {
    return runs.find((run) => run.runId === explicitRunId) ?? { runId: explicitRunId, at: null, pid: null, transport: null };
  }
  return runs[runs.length - 1];
}

/**
 * Records that belong to `runId`. Lines with a `runId` field are matched on
 * it. Lines without one (older logs, or a body the sink could not stamp) are
 * attributed to the run whose marker precedes them in the file.
 */
export function recordsForRun(records: unknown[], runId: string): unknown[] {
  const out: unknown[] = [];
  let inRun = false;
  for (const record of records) {
    if (!isDict(record)) continue;
    if (record.type === 'run_started') {
      inRun = record.runId === runId;
      continue;
    }
    if ('runId' in record) {
      if (record.runId === runId) out.push(record);
    } else if (inRun) {
      out.push(record);
    }
  }
  return out;
}

/**
 * Correlation ids in a `_meta` object: any matching top-level key and any
 * matching key inside nested objects. Only the key path and the value are
 * returned; sibling fields are never read into the result.
 */
export function findCorrelationIds(meta: unknown, prefix = '', depth = 0): CorrelationId[] {
  if (!isDict(meta) || depth > MAX_META_DEPTH) return [];
  const found: CorrelationId[] = [];
  for (const [key, value] of Object.entries(meta)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (CORRELATION_KEY_PATTERN.test(key)) {
      found.push({ path, value: scalar(value) });
    }
    if (isDict(value)) found.push(...findCorrelationIds(value, path, depth + 1));
  }
  return found;
}

function scalar(value: unknown): CorrelationId['value'] {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return '[non-scalar]';
}

function normalizeKey(key: string): string {
  return key
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/^mcp/, '');
}

export function buildChain(logs: ChainLogs, runId: string): ChainRow[] {
  const requests = recordsForRun(logs.requests, runId).filter(isDict);
  const tracks = recordsForRun(logs.tracks, runId).filter(isDict);
  const ingested = flattenIngestion(recordsForRun(logs.ingestion, runId));

  const responsesBySeq = new Map<number, Dict>();
  const sessionOpenedBySeq = new Map<number, string>();
  for (const record of requests) {
    const seq = num(record.seq);
    if (seq == null) continue;
    if (record.type === 'response') responsesBySeq.set(seq, record);
    if (record.type === 'session_opened' && typeof record.sessionId === 'string') {
      sessionOpenedBySeq.set(seq, record.sessionId);
    }
  }

  const usedTracks = new Set<Dict>();
  const usedIngested = new Set<IngestedEvent>();
  const rows: ChainRow[] = [];

  for (const record of requests) {
    if (record.type != null && record.type !== 'request') continue;
    const message = record.message;
    if (!isDict(message) || message.method !== 'tools/call') continue;
    const params = isDict(message.params) ? message.params : {};
    const seq = num(record.seq);
    const tool = str(params.name);
    const metaIds = findCorrelationIds(params._meta);

    const response = seq == null ? undefined : responsesBySeq.get(seq);
    const sessionId = str(record.sessionId) ?? (seq == null ? null : sessionOpenedBySeq.get(seq) ?? null);

    const track = seq == null ? undefined : pickTrack(tracks, seq, tool, usedTracks);
    if (track) usedTracks.add(track);
    const event = track ? pickIngested(ingested, track, usedIngested) : undefined;
    if (event) usedIngested.add(event);

    const eventProps = event ? event.event_properties : track ? asDict(track.event_properties) : {};
    const eventIds = correlationProps(eventProps);

    const flags: string[] = [];
    for (const meta of metaIds) {
      const outcome = metaOutcome(meta, eventProps);
      if (outcome === 'missing') flags.push(`meta id not on event: ${meta.path}`);
      if (outcome === 'differs') flags.push(`meta id differs from event property: ${meta.path}`);
    }
    if (!track) flags.push('no track() record for this request');
    if (track && !event) flags.push('track() record has no ingestion record');
    if (response && (num(response.status) ?? 0) >= 300) flags.push(`response status ${String(response.status)}`);

    rows.push({
      seq,
      receivedAt: num(record.receivedAt),
      transport: str(record.transport),
      jsonrpcId: 'id' in message ? message.id : null,
      tool,
      sessionId,
      response: response
        ? {
            status: num(response.status) ?? 0,
            durationMs: num(response.durationMs) ?? 0,
            sessionId: str(response.sessionId),
            sse: response.sse === true,
            errorBody: str(response.errorBody),
          }
        : null,
      metaIds,
      track: track
        ? {
            seq: num(track.seq) ?? 0,
            at: num(track.at) ?? 0,
            event_type: str(track.event_type) ?? 'unknown',
            user_id: str(track.user_id),
            device_id: str(track.device_id),
            sessionId: str(track.sessionId),
          }
        : null,
      ingested: event
        ? {
            receivedAt: event.receivedAt,
            time: event.time,
            insert_id: event.insert_id,
            event_type: event.event_type,
            user_id: event.user_id,
          }
        : null,
      eventIds,
      flags,
    });
  }
  return rows;
}

function asDict(value: unknown): Dict {
  return isDict(value) ? value : {};
}

const TOOL_EVENT_TYPES = new Set(['[MCP] Tool Call Response', '[MCP] Tool Call Rejected']);

function pickTrack(tracks: Dict[], seq: number, tool: string | null, used: Set<Dict>): Dict | undefined {
  const candidates = tracks.filter(
    (track) => (track.type == null || track.type === 'track') && track.requestSeq === seq && !used.has(track),
  );
  const named = candidates.find((track) => {
    const props = asDict(track.event_properties);
    return TOOL_EVENT_TYPES.has(str(track.event_type) ?? '') && (tool == null || props['[MCP] Tool Name'] === tool);
  });
  return named ?? candidates.find((track) => TOOL_EVENT_TYPES.has(str(track.event_type) ?? '')) ?? candidates[0];
}

interface IngestedEvent {
  receivedAt: number | null;
  time: number | null;
  insert_id: string | null;
  event_type: string;
  user_id: string | null;
  event_properties: Dict;
}

function flattenIngestion(bodies: unknown[]): IngestedEvent[] {
  const out: IngestedEvent[] = [];
  for (const body of bodies) {
    if (!isDict(body) || !Array.isArray(body.events)) continue;
    for (const event of body.events) {
      if (!isDict(event)) continue;
      out.push({
        receivedAt: num(body.receivedAt),
        time: num(event.time),
        insert_id: str(event.insert_id),
        event_type: str(event.event_type) ?? 'unknown',
        user_id: str(event.user_id),
        event_properties: asDict(event.event_properties),
      });
    }
  }
  return out;
}

/**
 * The SDK does not set `insert_id` or `time`; `@amplitude/analytics-node`
 * adds both after `track()`. So the join is event type, user id, tool name
 * when both sides have one, and the closest `time` to the `track()` call.
 */
function pickIngested(events: IngestedEvent[], track: Dict, used: Set<IngestedEvent>): IngestedEvent | undefined {
  const at = num(track.at);
  const eventType = str(track.event_type);
  const userId = str(track.user_id);
  const toolName = str(asDict(track.event_properties)['[MCP] Tool Name']);
  let best: IngestedEvent | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const event of events) {
    if (used.has(event)) continue;
    if (event.event_type !== eventType) continue;
    if (event.user_id !== userId) continue;
    const eventTool = str(event.event_properties['[MCP] Tool Name']);
    if (toolName != null && eventTool != null && eventTool !== toolName) continue;
    const reference = event.time ?? event.receivedAt;
    const distance = at == null || reference == null ? 0 : Math.abs(reference - at);
    if (distance > INGESTION_TIME_WINDOW_MS) continue;
    if (distance < bestDistance) {
      best = event;
      bestDistance = distance;
    }
  }
  return best;
}

function correlationProps(props: Dict): CorrelationId[] {
  return Object.entries(props)
    .filter(([key]) => CORRELATION_KEY_PATTERN.test(key.replace(/[^a-zA-Z0-9_]/g, '')))
    .map(([key, value]) => ({ path: key, value: scalar(value) }));
}

function metaOutcome(meta: CorrelationId, props: Dict): 'present' | 'differs' | 'missing' {
  const metaValue = meta.value === null ? null : String(meta.value);
  if (metaValue != null && Object.values(props).some((value) => value != null && String(value) === metaValue)) {
    return 'present';
  }
  const leaf = meta.path.split('.').pop() ?? meta.path;
  const wanted = normalizeKey(leaf);
  const keyMatch = Object.keys(props).some((key) => normalizeKey(key) === wanted);
  return keyMatch ? 'differs' : 'missing';
}

export function formatChain(run: RunSummary, rows: ChainRow[]): string {
  const lines: string[] = [];
  const started = run.at == null ? 'unknown start' : new Date(run.at).toISOString();
  lines.push(`run ${run.runId} (${run.transport ?? 'unknown transport'}, pid ${run.pid ?? '?'}, ${started})`);
  lines.push(`${rows.length} tools/call ${rows.length === 1 ? 'request' : 'requests'}`);
  for (const row of rows) {
    lines.push('');
    const when = row.receivedAt == null ? '?' : new Date(row.receivedAt).toISOString();
    lines.push(
      `#${row.seq ?? '?'}  ${when}  tools/call ${row.tool ?? '?'}  jsonrpc id ${JSON.stringify(row.jsonrpcId)}  session ${row.sessionId ?? '-'}`,
    );
    if (row.response) {
      const parts = [`${row.response.status}`, row.response.sse ? 'sse' : 'json', `${row.response.durationMs}ms`];
      if (row.response.sessionId) parts.push(`session ${row.response.sessionId}`);
      lines.push(`  response   ${parts.join(' ')}`);
      if (row.response.errorBody) lines.push(`  error body ${row.response.errorBody}`);
    } else {
      lines.push('  response   -');
    }
    lines.push(`  _meta ids  ${formatIds(row.metaIds)}`);
    if (row.track) {
      const offset = row.receivedAt == null ? '' : ` +${row.track.at - row.receivedAt}ms`;
      lines.push(
        `  track      #${row.track.seq}${offset}  ${row.track.event_type}  user_id ${row.track.user_id ?? '-'}  session ${row.track.sessionId ?? '-'}`,
      );
    } else {
      lines.push('  track      -');
    }
    if (row.ingested) {
      const offset =
        row.track && row.ingested.time != null ? ` +${row.ingested.time - row.track.at}ms` : '';
      lines.push(
        `  ingested  ${offset}  ${row.ingested.event_type}  insert_id ${row.ingested.insert_id ?? '-'}  time ${row.ingested.time ?? '-'}`,
      );
    } else {
      lines.push('  ingested   -');
    }
    lines.push(`  event ids  ${formatIds(row.eventIds)}`);
    if (row.flags.length > 0) {
      for (const flag of row.flags) lines.push(`  FLAG       ${flag}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function formatIds(ids: CorrelationId[]): string {
  if (ids.length === 0) return '-';
  return ids.map((id) => `${id.path}=${JSON.stringify(id.value)}`).join('  ');
}

async function readLog(path: string): Promise<unknown[]> {
  try {
    return parseNdjson(await readFile(path, 'utf8'));
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT') return [];
    throw error;
  }
}

async function main(argv: string[]): Promise<number> {
  let runId: string | undefined;
  let dir = fileURLToPath(new URL('.', import.meta.url));
  let asJson = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--run') {
      runId = argv[i + 1];
      i += 1;
    } else if (arg === '--dir') {
      const next = argv[i + 1];
      if (next) dir = next;
      i += 1;
    } else if (arg === '--json') {
      asJson = true;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write('Usage: pnpm playground:chain [--run <runId>] [--dir <log dir>] [--json]\n');
      return 0;
    }
  }

  const logs: ChainLogs = {
    requests: await readLog(join(dir, 'mcp-requests.ndjson')),
    tracks: await readLog(join(dir, 'sdk-track.ndjson')),
    ingestion: await readLog(join(dir, 'events.ndjson')),
  };
  const run = selectRun(logs.requests, runId);
  if (!run) {
    process.stderr.write(`no run_started marker found in ${join(dir, 'mcp-requests.ndjson')}\n`);
    return 1;
  }
  const rows = buildChain(logs, run.runId);
  process.stdout.write(asJson ? `${JSON.stringify({ run, rows }, null, 2)}\n` : formatChain(run, rows));
  return 0;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(entry).href === import.meta.url;
}

if (isDirectRun()) {
  process.exitCode = await main(process.argv.slice(2));
}
