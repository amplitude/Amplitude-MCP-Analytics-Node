import type { IncomingHttpHeaders } from 'node:http';
import { Transform, type Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { type NdjsonLog, openNdjsonLog } from './ndjson-log.js';
import {
  nextSeq,
  type PlaygroundTransportName,
  type RunInfo,
  type RunStartedRecord,
  runStartedRecord,
} from './run.js';

export type { PlaygroundTransportName } from './run.js';

/**
 * Request headers copied into the log. Nothing else is ever logged, so
 * `authorization`, `cookie`, and any custom header stay out of the file.
 */
export const LOGGED_REQUEST_HEADERS: readonly string[] = [
  'mcp-session-id',
  'mcp-protocol-version',
  'user-agent',
  'content-type',
  'accept',
  'last-event-id',
];

/** Non-2xx response bodies are kept up to this many bytes. */
export const MAX_LOGGED_ERROR_BODY_BYTES = 4096;

/** One client-to-server MCP message. Tool arguments and `_meta` are kept on purpose. */
export interface McpRequestRecord {
  type?: 'request';
  transport: PlaygroundTransportName;
  httpMethod?: string;
  /** Parsed JSON-RPC message, when the body was JSON. */
  message?: unknown;
  /** Original text when the body was not JSON. */
  raw?: string;
  runId?: string;
  /** Per-process counter. A response and any `track()` calls for this request carry the same value. */
  seq?: number;
  receivedAt?: number;
  /** HTTP only. */
  path?: string;
  /** HTTP only. Only {@link LOGGED_REQUEST_HEADERS}. */
  headers?: Record<string, string>;
  /** The `mcp-session-id` request header, when present. */
  sessionId?: string;
}

/** The HTTP response to the request with the same `seq`. */
export interface McpResponseRecord {
  type: 'response';
  transport: 'streamable-http';
  runId: string;
  seq: number;
  at: number;
  status: number;
  /** The `mcp-session-id` response header, when present. */
  sessionId?: string;
  durationMs: number;
  /** True when the response was a `text/event-stream`. Only the status is recorded for those. */
  sse?: boolean;
  /** Non-2xx JSON bodies, truncated to {@link MAX_LOGGED_ERROR_BODY_BYTES}. */
  errorBody?: string;
  /** The connection closed before the response finished. */
  aborted?: boolean;
}

export interface McpSessionRecord {
  type: 'session_opened' | 'session_closed' | 'initialize_with_existing_session';
  transport: PlaygroundTransportName;
  runId: string;
  /** The request that caused it, when there is one. */
  seq?: number;
  at: number;
  sessionId?: string;
  /** For `initialize_with_existing_session`: the session the transport already holds. */
  existingSessionId?: string;
}

export type RequestLogRecord = RunStartedRecord | McpRequestRecord | McpResponseRecord | McpSessionRecord;

export type RequestLog = NdjsonLog<RequestLogRecord>;

export function defaultRequestLogPath(): string {
  return fileURLToPath(new URL('./mcp-requests.ndjson', import.meta.url));
}

/**
 * Append-only NDJSON log of MCP traffic. Opens with a `run_started` marker so
 * one process's lines can be told apart from an earlier run's.
 */
export async function openRequestLog(logPath: string, run: RunInfo): Promise<RequestLog> {
  const log = await openNdjsonLog<RequestLogRecord>(logPath, {
    onWritten: (record) => {
      const summary = summarize(record);
      if (summary) process.stderr.write(`[playground] mcp ${summary}\n`);
    },
  });
  await log.write(runStartedRecord(run));
  return log;
}

/** Copy only {@link LOGGED_REQUEST_HEADERS}, lowercased, first value when repeated. */
export function pickLoggedHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of LOGGED_REQUEST_HEADERS) {
    const value = headers[name];
    if (typeof value === 'string') {
      picked[name] = value;
    } else if (Array.isArray(value) && typeof value[0] === 'string') {
      picked[name] = value[0];
    }
  }
  return picked;
}

/**
 * Forward `input` unchanged, and log each newline-delimited JSON-RPC message
 * before the bytes are readable downstream.
 *
 * The stdio transport does not expose a message hook. This stream is the
 * stdin it reads. Waiting for the log write before forwarding means a tool
 * call is on disk before the server handles it.
 */
export function logStdioMessages(input: Readable, log: RequestLog, run: RunInfo): Readable {
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  const transform = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      pending = Buffer.concat([pending, chunk]);
      void flushCompleteLines(pending, log, run)
        .then((rest) => {
          pending = rest.pending;
          callback(null, rest.forward.length > 0 ? rest.forward : undefined);
        })
        .catch((error: unknown) => {
          process.stderr.write(`[playground] failed to log MCP request: ${String(error)}\n`);
          const forward = pending;
          pending = Buffer.alloc(0);
          callback(null, forward);
        });
    },
    flush(callback) {
      const leftover = pending.toString('utf8').replace(/\r$/, '');
      pending = Buffer.alloc(0);
      void (async () => {
        if (leftover.length > 0) {
          await log.write({ ...stdioEnvelope(run), raw: leftover });
        }
      })()
        .then(() => callback())
        .catch((error: unknown) => {
          process.stderr.write(`[playground] failed to log MCP request: ${String(error)}\n`);
          callback();
        });
    },
  });
  input.pipe(transform);
  return transform;
}

async function flushCompleteLines(
  pending: Buffer,
  log: RequestLog,
  run: RunInfo,
): Promise<{ pending: Buffer; forward: Buffer }> {
  let consumed = 0;
  let newline = pending.indexOf(0x0a);
  while (newline !== -1) {
    const line = pending.subarray(consumed, newline).toString('utf8').replace(/\r$/, '');
    consumed = newline + 1;
    if (line.length > 0) await log.write(stdioRecord(line, run));
    newline = pending.indexOf(0x0a, consumed);
  }
  return {
    pending: pending.subarray(consumed),
    forward: consumed > 0 ? pending.subarray(0, consumed) : Buffer.alloc(0),
  };
}

function stdioEnvelope(run: RunInfo): McpRequestRecord {
  return { type: 'request', transport: 'stdio', runId: run.runId, seq: nextSeq(), receivedAt: Date.now() };
}

function stdioRecord(line: string, run: RunInfo): McpRequestRecord {
  const envelope = stdioEnvelope(run);
  try {
    return { ...envelope, message: JSON.parse(line) as unknown };
  } catch {
    return { ...envelope, raw: line };
  }
}

function summarize(record: RequestLogRecord): string | undefined {
  switch (record.type) {
    case 'run_started':
      return `run ${record.runId} started (${record.transport}, pid ${record.pid})`;
    case 'response':
      return `#${record.seq} -> ${record.status}${record.sse ? ' sse' : ''}${record.aborted ? ' aborted' : ''} ${record.durationMs}ms`;
    case 'session_opened':
      return `session opened ${record.sessionId ?? ''}`.trimEnd();
    case 'session_closed':
      return `session closed ${record.sessionId ?? ''}`.trimEnd();
    case 'initialize_with_existing_session':
      return `#${record.seq} initialize while session ${record.existingSessionId ?? ''} exists`.replace(/\s+$/, '');
    default:
      return summarizeRequest(record);
  }
}

function summarizeRequest(record: McpRequestRecord): string {
  const prefix = record.seq == null ? '' : `#${record.seq} `;
  const message = record.message;
  if (message != null && typeof message === 'object' && 'method' in message) {
    const method = message.method;
    if (typeof method === 'string') {
      const name = toolName(message);
      return `${prefix}${name == null ? method : `${method} ${name}`}`;
    }
  }
  if (record.httpMethod) return `${prefix}${record.httpMethod}`;
  return `${prefix}message`;
}

function toolName(message: object): string | undefined {
  if (!('params' in message)) return undefined;
  const params = message.params;
  if (params == null || typeof params !== 'object' || !('name' in params)) return undefined;
  return typeof params.name === 'string' ? params.name : undefined;
}
