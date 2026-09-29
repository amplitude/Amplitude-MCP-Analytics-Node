import { randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type OutgoingHttpHeader,
  type OutgoingHttpHeaders,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import { pathToFileURL } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  MAX_LOGGED_ERROR_BODY_BYTES,
  type McpResponseRecord,
  pickLoggedHeaders,
  type RequestLog,
} from './request-log.js';
import { currentRequest, nextSeq, requestContext, type RequestStore } from './run.js';
import { createPlayground, type Playground, type PlaygroundOptions } from './server.js';

export const PLAYGROUND_HTTP_PORT = 8787;
export const PLAYGROUND_HTTP_PATH = '/mcp';

export interface PlaygroundHttpOptions extends Omit<PlaygroundOptions, 'transport'> {
  /** TCP port. `0` asks the OS for one. Default {@link PLAYGROUND_HTTP_PORT}. */
  port?: number;
}

export interface RunningPlaygroundHttp {
  url: URL;
  playground: Playground;
  flush: () => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Session-bearing Streamable HTTP server. One long-lived process, one
 * transport: fine for a single local client (Inspector, Cursor, a test).
 *
 * One transport also means one session. A second `initialize` while a
 * session exists is rejected by the transport with HTTP 400; the request log
 * records that as `initialize_with_existing_session` plus the 400 response.
 */
export async function startPlaygroundHttp(options: PlaygroundHttpOptions = {}): Promise<RunningPlaygroundHttp> {
  const playground = await createPlayground({ ...options, transport: 'streamable-http' });
  const { requests, run } = playground;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      // Runs inside the `initialize` request's store, so later track() calls
      // from this request see the session the transport just minted.
      const store = currentRequest();
      if (store) store.sessionId = sessionId;
      void requests.write({
        type: 'session_opened',
        transport: 'streamable-http',
        runId: run.runId,
        seq: store?.requestSeq,
        at: Date.now(),
        sessionId,
      });
    },
    onsessionclosed: (sessionId) => {
      void requests.write({
        type: 'session_closed',
        transport: 'streamable-http',
        runId: run.runId,
        seq: currentRequest()?.requestSeq,
        at: Date.now(),
        sessionId,
      });
    },
  });
  await playground.server.connect(transport);

  const http = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname !== PLAYGROUND_HTTP_PATH) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    const seq = nextSeq();
    const receivedAt = Date.now();
    const headers = pickLoggedHeaders(req.headers);
    const store: RequestStore = { requestSeq: seq, sessionId: headers['mcp-session-id'] };
    observeResponse(res, { seq, receivedAt, runId: run.runId }, requests);
    requestContext.run(store, () => {
      void handleMcpRequest(req, res, transport, requests, {
        seq,
        receivedAt,
        runId: run.runId,
        path: pathname,
        headers,
      }).catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
  });

  const port = options.port ?? PLAYGROUND_HTTP_PORT;
  await listen(http, port);
  const address = http.address();
  if (address == null || typeof address === 'string') {
    throw new Error('playground HTTP server did not receive a TCP port');
  }
  const url = new URL(`http://127.0.0.1:${address.port}${PLAYGROUND_HTTP_PATH}`);
  process.stderr.write(`[playground] streamable HTTP listening on ${url.href}\n`);

  let closed = false;
  return {
    url,
    playground,
    flush: () => playground.flush(),
    close: async () => {
      if (closed) return;
      closed = true;
      await transport.close();
      await closeHttp(http);
      await playground.close();
    },
  };
}

const MAX_MCP_BODY_BYTES = 1_000_000;

interface RequestEnvelope {
  seq: number;
  receivedAt: number;
  runId: string;
  path: string;
  headers: Record<string, string>;
}

/**
 * Log the client request, then hand it to the MCP transport.
 *
 * The body is read here so it can be written to the request log. The parsed
 * value is passed into `handleRequest` because that stream can only be read once.
 */
async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  transport: StreamableHTTPServerTransport,
  requests: RequestLog,
  envelope: RequestEnvelope,
): Promise<void> {
  const base = {
    type: 'request' as const,
    transport: 'streamable-http' as const,
    runId: envelope.runId,
    seq: envelope.seq,
    receivedAt: envelope.receivedAt,
    path: envelope.path,
    headers: envelope.headers,
    sessionId: envelope.headers['mcp-session-id'],
  };

  if (req.method !== 'POST') {
    await requests.write({ ...base, httpMethod: req.method ?? 'UNKNOWN' });
    await transport.handleRequest(req, res);
    return;
  }

  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    json(res, 413, { error: 'payload too large' });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    await requests.write({ ...base, httpMethod: 'POST', raw });
    await transport.handleRequest(req, res);
    return;
  }

  const messages = Array.isArray(parsed) ? parsed : [parsed];
  if (messages.length === 0) {
    await requests.write({ ...base, httpMethod: 'POST', message: parsed });
  } else {
    for (const message of messages) {
      await requests.write({ ...base, httpMethod: 'POST', message });
    }
  }

  if (transport.sessionId !== undefined && messages.some(isInitializeRequest)) {
    await requests.write({
      type: 'initialize_with_existing_session',
      transport: 'streamable-http',
      runId: envelope.runId,
      seq: envelope.seq,
      at: Date.now(),
      sessionId: base.sessionId,
      existingSessionId: transport.sessionId,
    });
  }

  await transport.handleRequest(req, res, parsed);
}

function isInitializeRequest(message: unknown): boolean {
  return message != null && typeof message === 'object' && 'method' in message && message.method === 'initialize';
}

/**
 * Record how the request with `seq` was answered.
 *
 * Wraps `writeHead`, `write`, and `end` on the response. Nothing is buffered
 * for 2xx responses or `text/event-stream`; an SSE response is recorded as soon
 * as its headers go out, with only the status. Non-2xx bodies are kept up to
 * {@link MAX_LOGGED_ERROR_BODY_BYTES}.
 */
function observeResponse(
  res: ServerResponse,
  request: { seq: number; receivedAt: number; runId: string },
  requests: RequestLog,
): void {
  let status: number | undefined;
  let responseHeaders: Record<string, string> = {};
  let sse = false;
  let recorded = false;
  const bodyChunks: Buffer[] = [];
  let bodyBytes = 0;

  const record = (extra: Partial<McpResponseRecord> = {}): void => {
    if (recorded) return;
    recorded = true;
    const finalStatus = status ?? res.statusCode;
    const entry: McpResponseRecord = {
      type: 'response',
      transport: 'streamable-http',
      runId: request.runId,
      seq: request.seq,
      at: Date.now(),
      status: finalStatus,
      durationMs: Date.now() - request.receivedAt,
      ...extra,
    };
    const sessionId = responseHeaders['mcp-session-id'] ?? headerValue(res.getHeader('mcp-session-id'));
    if (sessionId) entry.sessionId = sessionId;
    if (sse) entry.sse = true;
    if (!sse && (finalStatus < 200 || finalStatus >= 300) && bodyBytes > 0) {
      entry.errorBody = Buffer.concat(bodyChunks).subarray(0, MAX_LOGGED_ERROR_BODY_BYTES).toString('utf8');
    }
    void requests.write(entry);
  };

  // Observation only: a bug here must not stall the client's response.
  const capture = (chunk: unknown): void => {
    try {
      if (sse) return;
      const current = status ?? res.statusCode;
      if (current >= 200 && current < 300) return;
      if (bodyBytes >= MAX_LOGGED_ERROR_BODY_BYTES) return;
      const buffer = toBuffer(chunk);
      if (!buffer) return;
      bodyChunks.push(buffer);
      bodyBytes += buffer.length;
    } catch (error) {
      process.stderr.write(`[playground] failed to capture response body: ${String(error)}\n`);
    }
  };

  const originalWriteHead = res.writeHead.bind(res);
  res.writeHead = ((code: number, ...rest: unknown[]) => {
    try {
      status = code;
      responseHeaders = normalizeHeaders(rest.find((arg) => arg != null && typeof arg === 'object'));
      const contentType = responseHeaders['content-type'] ?? headerValue(res.getHeader('content-type'));
      sse = typeof contentType === 'string' && contentType.toLowerCase().includes('text/event-stream');
    } catch (error) {
      process.stderr.write(`[playground] failed to read response headers: ${String(error)}\n`);
    }
    const result = (originalWriteHead as (...args: unknown[]) => ServerResponse)(code, ...rest);
    if (sse) record();
    return result;
  }) as typeof res.writeHead;

  const originalWrite = res.write.bind(res);
  res.write = ((chunk: unknown, ...rest: unknown[]) => {
    capture(chunk);
    return (originalWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof res.write;

  const originalEnd = res.end.bind(res);
  res.end = ((chunk?: unknown, ...rest: unknown[]) => {
    if (chunk != null && typeof chunk !== 'function') capture(chunk);
    return (originalEnd as (...args: unknown[]) => ServerResponse)(chunk, ...rest);
  }) as typeof res.end;

  res.once('finish', () => record());
  res.once('close', () => {
    if (!res.writableFinished) record({ aborted: true });
  });
}

/** Hono hands Node plain `Uint8Array`s, not `Buffer`s. */
function toBuffer(chunk: unknown): Buffer | undefined {
  if (typeof chunk === 'string') return Buffer.from(chunk);
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return undefined;
}

function normalizeHeaders(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers == null || typeof headers !== 'object') return out;
  if (Array.isArray(headers)) {
    // Node's flat `[name, value, name, value]` form.
    for (let i = 0; i + 1 < headers.length; i += 2) {
      const name = headers[i];
      const value = headerValue(headers[i + 1] as OutgoingHttpHeader | undefined);
      if (typeof name === 'string' && value !== undefined) out[name.toLowerCase()] = value;
    }
    return out;
  }
  for (const [name, value] of Object.entries(headers as OutgoingHttpHeaders)) {
    const text = headerValue(value);
    if (text !== undefined) out[name.toLowerCase()] = text;
  }
  return out;
}

function headerValue(value: OutgoingHttpHeader | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value[0];
  return undefined;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_MCP_BODY_BYTES) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function listen(server: HttpServer, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

function closeHttp(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(entry).href === import.meta.url;
}

if (isDirectRun()) {
  const running = await startPlaygroundHttp();
  const stop = (): void => {
    void running.close().then(
      () => process.exit(0),
      (error: unknown) => {
        process.stderr.write(`[playground] shutdown failed: ${String(error)}\n`);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
