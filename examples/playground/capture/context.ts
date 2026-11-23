import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { AmplitudeEvent } from '../../../src/types.js';
import { createAliaser, sanitizeEvent, sanitizeIngestionBody, type Aliaser } from './sanitize.js';

/**
 * Ambient join context for the capture harness. Every record written while a
 * message is being dispatched inherits the connection, server instance, rpc
 * id, and request alias of that message, so `events.ndjson` can be joined to
 * `requests.ndjson` without guessing.
 */
export interface CaptureContext {
  /** Session alias, process alias, 'n/a', or 'pending' pre-initialize. */
  connection: string;
  /** Per-server-instance alias, e.g. `p3f9a1-srv-2`. */
  serverInstance: string;
  rpcId?: string | number | null;
  method?: string;
  /** Per-HTTP-request or per-stdio-line alias set by the entry point. */
  requestAlias?: string;
}

export const captureAls = new AsyncLocalStorage<CaptureContext>();

export interface Recorder {
  aliaser: Aliaser;
  /** Serialize one record onto a named ndjson file. */
  write: (file: string, record: Record<string, unknown>) => Promise<void>;
  lifecycle: (record: Record<string, unknown>) => Promise<void>;
  /** Wait for all queued appends. */
  close: () => Promise<void>;
}

/**
 * Append-serialized ndjson writer for one trial directory. A single queue
 * keeps lines ordered even when many async sources write at once; `seq` is
 * per process and shared across files so cross-file ordering is visible.
 */
export async function createRecorder(outDir: string, prefix?: string): Promise<Recorder> {
  await mkdir(outDir, { recursive: true });
  const aliaser = createAliaser(prefix);
  let seq = 0;
  let queue = Promise.resolve();
  const write = (file: string, record: Record<string, unknown>): Promise<void> => {
    const line = `${JSON.stringify({ ts: new Date().toISOString(), seq: ++seq, ...record })}\n`;
    queue = queue.then(() => appendFile(join(outDir, `${file}.ndjson`), line, 'utf8'));
    return queue;
  };
  return {
    aliaser,
    write,
    lifecycle: (record) => write('lifecycle', record),
    close: () => queue,
  };
}

interface RequestShape {
  id?: string | number | null;
  method?: string;
}

function requestShape(message: unknown): RequestShape {
  if (message == null || typeof message !== 'object') return {};
  const m = message as Record<string, unknown>;
  return {
    id: typeof m.id === 'string' || typeof m.id === 'number' || m.id === null ? m.id : undefined,
    method: typeof m.method === 'string' ? m.method : undefined,
  };
}

/**
 * Wrap a connected transport so each inbound message dispatches inside the
 * ALS store and each outbound send is summarized into `responses.ndjson`.
 *
 * `Protocol.connect` already replaced `transport.onmessage` with its own
 * dispatcher, so wrapping afterwards intercepts every message. `base` is
 * captured by reference — the HTTP entry mutates `connection` (pending →
 * session alias) and `requestAlias` (current POST) between messages.
 */
export function wrapTransport(transport: Transport, base: CaptureContext, recorder: Recorder): void {
  const requestMethods = new Map<string | number, string>();
  const originalOnMessage = transport.onmessage;
  transport.onmessage = (message, extra) => {
    const shape = requestShape(message);
    const ctx: CaptureContext = { ...base, rpcId: shape.id, method: shape.method };
    if (shape.id !== undefined && shape.id !== null && shape.method) {
      requestMethods.set(shape.id, shape.method);
    }
    captureAls.run(ctx, () => originalOnMessage?.(message, extra));
  };

  const originalSend = transport.send.bind(transport);
  transport.send = (message, options) => {
    recordSend(base, recorder, requestMethods, message);
    return originalSend(message, options);
  };
}

function recordSend(
  base: CaptureContext,
  recorder: Recorder,
  requestMethods: Map<string | number, string>,
  message: unknown,
): void {
  const record: Record<string, unknown> = {
    connection: base.connection,
    serverInstance: base.serverInstance,
  };
  const body: Record<string, unknown> = message as unknown as Record<string, unknown>;
  if (isRecord(body)) {
    if (Object.prototype.hasOwnProperty.call(body, 'id')) {
      const id = body.id;
      record.id = typeof id === 'string' || typeof id === 'number' || id === null ? id : '<id>';
      if (typeof id === 'string' || typeof id === 'number') {
        record.requestMethod = requestMethods.get(id);
      }
    }
    if (isRecord(body.result)) {
      const result = body.result;
      if (typeof result.protocolVersion === 'string') {
        record.initialize = { protocolVersion: result.protocolVersion };
      }
      if (Array.isArray(result.supportedVersions)) {
        record.discover = { supportedVersions: result.supportedVersions };
      }
      if (typeof result.isError === 'boolean') record.toolIsError = result.isError;
      if (Array.isArray(result.tools)) record.toolsCount = result.tools.length;
    }
    if (isRecord(body.error)) {
      record.errorCode = typeof body.error.code === 'number' ? body.error.code : '<code>';
    }
    if (typeof body.method === 'string') record.method = body.method;
  }
  void recorder.write('responses', record).catch((error: unknown) => {
    process.stderr.write(`[capture] failed to write responses log: ${String(error)}\n`);
  });
}

interface AccessorTransport {
  onmessage?: (message: unknown, extra?: unknown) => void;
  send: (message: unknown) => unknown;
}

/**
 * Variant for `serveStdio`: it assigns `wire.onmessage` itself, AFTER the
 * transport is handed over, so a value-wrap installed beforehand would be
 * overwritten. An accessor on the instance intercepts the assignment and
 * wraps the dispatcher serveStdio installs, so each inbound message still
 * dispatches inside the ALS store. `send` is wrapped by value as usual.
 */
export function wrapTransportAccessor(
  transport: AccessorTransport,
  base: CaptureContext,
  recorder: Recorder,
): void {
  const requestMethods = new Map<string | number, string>();
  let dispatcher: ((message: unknown, extra?: unknown) => void) | undefined = transport.onmessage;
  Object.defineProperty(transport, 'onmessage', {
    configurable: true,
    enumerable: true,
    get: () => dispatcher,
    set: (fn: ((message: unknown, extra?: unknown) => void) | undefined) => {
      dispatcher =
        fn === undefined
          ? undefined
          : (message: unknown, extra?: unknown) => {
              const shape = requestShape(message);
              const ctx: CaptureContext = { ...base, rpcId: shape.id, method: shape.method };
              if (shape.id !== undefined && shape.id !== null && shape.method) {
                requestMethods.set(shape.id, shape.method);
              }
              captureAls.run(ctx, () => fn(message, extra));
            };
    },
  });

  const originalSend = transport.send.bind(transport);
  transport.send = (message: unknown) => {
    recordSend(base, recorder, requestMethods, message);
    return originalSend(message);
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Build the `capture` hooks `createPlayground` accepts. `onTrack` stamps an
 * insert id when the SDK did not set one so the event joins to
 * `ingestion.ndjson`, and records the ALS store of the message that produced
 * it — or `join: 'none'` when there is none, which is expected for events
 * emitted outside message dispatch (e.g. transport close).
 */
export function captureHooks(recorder: Recorder): {
  onTrack: (event: AmplitudeEvent) => void;
  sanitizeIngestion: (body: unknown) => unknown;
} {
  return {
    onTrack: (event) => {
      if (event.insert_id === undefined) event.insert_id = randomUUID();
      const ctx = captureAls.getStore();
      const record: Record<string, unknown> = ctx
        ? {
            connection: ctx.connection,
            serverInstance: ctx.serverInstance,
            rpcId: ctx.rpcId,
            method: ctx.method,
            requestAlias: ctx.requestAlias,
          }
        : { join: 'none' };
      record.event = sanitizeEvent(event as unknown as Record<string, unknown>, recorder.aliaser);
      void recorder.write('events', record).catch((error: unknown) => {
        process.stderr.write(`[capture] failed to write events log: ${String(error)}\n`);
      });
    },
    sanitizeIngestion: (body) => sanitizeIngestionBody(body, recorder.aliaser),
  };
}

/** Minimal `--flag value` parser shared by the capture entry points. */
export function parseArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg !== undefined && arg.startsWith('--')) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out.set(arg.slice(2), next);
        i++;
      } else {
        out.set(arg.slice(2), 'true');
      }
    }
  }
  return out;
}

export function requiredArg(args: Map<string, string>, name: string): string {
  const value = args.get(name);
  if (value === undefined || value === 'true') {
    process.stderr.write(`[capture] missing required --${name}\n`);
    process.exit(2);
  }
  return value;
}

/**
 * Capture runs sink-only. Belt and suspenders: delete a real key so a stray
 * environment cannot route events to Amplitude, then verify the sink URL the
 * playground came up with is loopback.
 */
export function assertLoopbackSink(serverUrl: string): void {
  const host = new URL(serverUrl).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    process.stderr.write(`[capture] ingestion sink is not loopback (${host}); refusing to run\n`);
    process.exit(1);
  }
}
