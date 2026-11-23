import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createPlayground, type Playground } from '../server.js';
import { createV2ServerFactory } from './v2-server.js';
import { captureAls } from './context.js';
import {
  assertLoopbackSink,
  captureHooks,
  createRecorder,
  parseArgs,
  requiredArg,
  wrapTransport,
  type CaptureContext,
  type Recorder,
} from './context.js';
import { writeManifestOnce, type GroundTruth } from './manifest.js';
import { sanitizeHeaders, sanitizeMessage } from './sanitize.js';

/**
 * Capture-mode Streamable HTTP playground.
 *
 * Two modes:
 *   - `http-session`: session map like `http.ts` — new server + transport per
 *     `initialize`, later POSTs routed by `Mcp-Session-Id` (logged as alias).
 *   - `http-fresh`: stateless — `sessionIdGenerator: undefined`, a fresh
 *     server + transport per POST, GET/DELETE answered 405.
 *
 * All records are sanitized before they reach disk; raw session ids never
 * touch stderr.
 */

export const CAPTURE_HTTP_PATH = '/mcp';

export type CaptureMode = 'http-session' | 'http-fresh' | 'v2-http';

export interface CaptureHttpOptions {
  mode: CaptureMode;
  trial: string;
  outDir: string;
  port?: number;
  groundTruth?: Partial<GroundTruth>;
}

export interface RunningCaptureHttp {
  url: URL;
  playground: Playground;
  recorder: Recorder;
  flush: () => Promise<void>;
  close: () => Promise<void>;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  /** Mutable ALS base: `connection` starts 'pending' and becomes the session alias. */
  ctx: CaptureContext;
  /** Alias of the session id once the transport mints it. */
  sessionAlias?: string;
}

export async function startCaptureHttp(options: CaptureHttpOptions): Promise<RunningCaptureHttp> {
  delete process.env.AMPLITUDE_API_KEY;
  const recorder = await createRecorder(options.outDir);
  const playground = await createPlayground({
    delivery: 'sink',
    logPath: join(options.outDir, 'ingestion.ndjson'),
    capture: captureHooks(recorder),
  });
  if (playground.sink) assertLoopbackSink(playground.sink.serverUrl);

  await writeManifestOnce(options.outDir, {
    trial: options.trial,
    mode: options.mode,
    serverLine: options.mode === 'v2-http' ? 'v2' : 'v1',
    groundTruth: {
      clientProduct: options.groundTruth?.clientProduct ?? null,
      clientSurface: options.groundTruth?.clientSurface ?? null,
      clientVersion: options.groundTruth?.clientVersion ?? null,
      topology: options.groundTruth?.topology ?? null,
    },
  });
  await recorder.lifecycle({ event: 'process-start', mode: options.mode, trial: options.trial });

  const sessions = new Map<string, Session>();
  let requestCount = 0;
  const serverCount = { n: 0 };

  // v2 line: `createMcpHandler` owns era routing — modern (2026-07-28)
  // requests are answered per the envelope, 2025-era traffic falls back to a
  // fresh stateless instance per request (`legacy: 'stateless'`).
  const v2Handler =
    options.mode === 'v2-http' ? createMcpHandler(createV2ServerFactory(playground), { legacy: 'stateless' }) : undefined;

  const forwardResponse = async (response: Response, res: ServerResponse): Promise<void> => {
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      if (key !== 'transfer-encoding' && key !== 'content-length') headers[key] = value;
    });
    res.writeHead(response.status, headers);
    if (response.body == null) {
      res.end();
      return;
    }
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      res.write(chunk);
    }
    res.end();
  };

  const handleV2Request = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const requestAlias = `${recorder.aliaser.prefix}-req-${++requestCount}`;
    let raw = '';
    try {
      raw = await readBody(req);
    } catch {
      json(res, 413, { error: 'payload too large' });
      return;
    }
    let parsed: unknown;
    if (raw.length > 0) {
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        await recordRequest(req, [], 'n/a', requestAlias, { raw: 'unparsed' });
        jsonRpcError(res, 400, -32700, 'Parse error: invalid JSON');
        return;
      }
    }
    const messages = parsed === undefined ? [] : Array.isArray(parsed) ? parsed : [parsed];
    const batch = Array.isArray(parsed) && parsed.length > 1;
    await recordRequest(req, messages, 'n/a', requestAlias, { batch });

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value == null) continue;
      headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
    const request = new Request(`http://127.0.0.1${req.url ?? CAPTURE_HTTP_PATH}`, {
      method: req.method ?? 'POST',
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' || raw.length === 0 ? undefined : raw,
    });
    const first = messages[0] as Record<string, unknown> | undefined;
    const shape = {
      id: first && (typeof first.id === 'string' || typeof first.id === 'number' || first.id === null) ? first.id : undefined,
      method: first && typeof first.method === 'string' ? first.method : undefined,
    };
    const response = await captureAls.run(
      { connection: 'n/a', serverInstance: 'v2-handler', requestAlias, rpcId: shape.id, method: shape.method },
      () => v2Handler?.fetch(request) ?? Promise.resolve(new Response(null, { status: 500 })),
    );

    const summary: Record<string, unknown> = {
      requestAlias,
      httpStatus: response.status,
      requestMethod: shape.method,
    };
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      try {
        const body: unknown = JSON.parse(await response.clone().text());
        if (body != null && typeof body === 'object' && !Array.isArray(body)) {
          const b = body as Record<string, unknown>;
          if (b.id !== undefined) summary.id = b.id;
          if (b.error != null && typeof b.error === 'object') {
            summary.errorCode = (b.error as Record<string, unknown>).code;
          }
          if (b.result != null && typeof b.result === 'object') {
            const result = b.result as Record<string, unknown>;
            if (typeof result.protocolVersion === 'string') {
              summary.initialize = { protocolVersion: result.protocolVersion };
            }
            if (Array.isArray(result.supportedVersions)) {
              summary.discover = { supportedVersions: result.supportedVersions };
            }
            if (typeof result.isError === 'boolean') summary.toolIsError = result.isError;
          }
        }
      } catch {
        summary.unparsed = true;
      }
    } else if (contentType.includes('text/event-stream')) {
      summary.sse = true;
    }
    await recorder.write('responses', summary);
    await forwardResponse(response, res);
  };

  const recordRequest = async (
    req: IncomingMessage,
    messages: unknown[],
    connection: string,
    requestAlias: string,
    extra?: { raw?: string; batch?: boolean },
  ): Promise<void> => {
    const record: Record<string, unknown> = {
      trial: options.trial,
      mode: options.mode,
      transport: 'streamable-http',
      httpMethod: req.method ?? 'UNKNOWN',
      connection,
      requestAlias,
      headers: sanitizeHeaders(req.headers as Record<string, string | string[] | undefined>, recorder.aliaser),
      messages: messages.map((message) => sanitizeMessage(message, recorder.aliaser)),
    };
    if (extra?.batch) record.batch = true;
    if (extra?.raw !== undefined) record.raw = extra.raw.length > 300 ? `<len=${extra.raw.length}>` : extra.raw;
    await recorder.write('requests', record);
  };

  const handleMcpRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const sessionId = headerValue(req.headers['mcp-session-id']);
    const existing = sessionId === undefined ? undefined : sessions.get(sessionId);
    const requestAlias = `${recorder.aliaser.prefix}-req-${++requestCount}`;

    if (options.mode === 'http-fresh') {
      if (req.method !== 'POST') {
        await recordRequest(req, [], 'n/a', requestAlias);
        res.writeHead(405, { Allow: 'POST' }).end();
        return;
      }
      const parsed = await readParsedBody(req, res);
      if (parsed === undefined) {
        await recordRequest(req, [], 'n/a', requestAlias, { raw: 'unparsed' });
        return;
      }
      const messages = Array.isArray(parsed) ? parsed : [parsed];
      await recordRequest(req, messages, 'n/a', requestAlias);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = playground.createServer();
      const ctx: CaptureContext = {
        connection: 'n/a',
        serverInstance: `${recorder.aliaser.prefix}-srv-${++serverCount.n}`,
        requestAlias,
      };
      try {
        await server.connect(transport);
        wrapTransport(transport, ctx, recorder);
        await transport.handleRequest(req, res, parsed);
      } finally {
        await transport.close().catch(() => undefined);
        await server.close().catch(() => undefined);
      }
      return;
    }

    // http-session
    if (req.method !== 'POST') {
      await recordRequest(
        req,
        [],
        sessionId === undefined ? 'none' : recorder.aliaser.alias('sess', sessionId),
        requestAlias,
      );
      if (existing == null) {
        sessionError(res, sessionId);
        return;
      }
      existing.ctx.requestAlias = requestAlias;
      await existing.transport.handleRequest(req, res);
      return;
    }

    const parsed = await readParsedBody(req, res);
    if (parsed === undefined) {
      await recordRequest(req, [], 'none', requestAlias, { raw: 'unparsed' });
      return;
    }
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    const connection = sessionId === undefined ? 'pending' : recorder.aliaser.alias('sess', sessionId);
    await recordRequest(req, messages, connection, requestAlias);

    if (messages.some((message) => isInitializeRequest(message))) {
      const session = await openSession(sessions, playground, recorder, serverCount);
      session.ctx.requestAlias = requestAlias;
      await session.transport.handleRequest(req, res, parsed);
      if (session.transport.sessionId === undefined) {
        await session.server.close().catch(() => undefined);
      }
      return;
    }

    if (existing == null) {
      sessionError(res, sessionId);
      return;
    }
    existing.ctx.requestAlias = requestAlias;
    await existing.transport.handleRequest(req, res, parsed);
  };

  const http = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname !== CAPTURE_HTTP_PATH) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    void (v2Handler ? handleV2Request(req, res) : handleMcpRequest(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });

  const port = options.port ?? 8787;
  await listen(http, port);
  const address = http.address();
  if (address == null || typeof address === 'string') {
    throw new Error('capture HTTP server did not receive a TCP port');
  }
  const url = new URL(`http://127.0.0.1:${address.port}${CAPTURE_HTTP_PATH}`);
  process.stderr.write(`[capture] ${options.mode} listening on ${url.href} (trial ${options.trial})\n`);

  let closed = false;
  return {
    url,
    playground,
    recorder,
    flush: () => playground.flush(),
    close: async () => {
      if (closed) return;
      closed = true;
      await Promise.allSettled([...sessions.values()].map((session) => session.transport.close()));
      await v2Handler?.close().catch(() => undefined);
      await closeHttp(http);
      await playground.close();
      await recorder.lifecycle({ event: 'process-stop', mode: options.mode, trial: options.trial });
      await recorder.close();
    },
  };

  async function openSession(
    map: Map<string, Session>,
    pg: Playground,
    rec: Recorder,
    counter: { n: number },
  ): Promise<Session> {
    const server = pg.createServer();
    const ctx: CaptureContext = {
      connection: 'pending',
      serverInstance: `${rec.aliaser.prefix}-srv-${++counter.n}`,
    };
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        const sessionAlias = rec.aliaser.alias('sess', id);
        session.sessionAlias = sessionAlias;
        ctx.connection = sessionAlias;
        map.set(id, session);
        void rec.lifecycle({ event: 'session-open', session: sessionAlias });
      },
    });
    const session: Session = { transport, server, ctx };
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id === undefined || !map.delete(id)) return;
      void rec.lifecycle({ event: 'session-close', session: rec.aliaser.alias('sess', id) });
    };
    await server.connect(transport);
    wrapTransport(transport, ctx, rec);
    return session;
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined || first.length === 0 ? undefined : first;
}

const MAX_BODY_BYTES = 1_000_000;

async function readParsedBody(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    json(res, 413, { error: 'payload too large' });
    return undefined;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    jsonRpcError(res, 400, -32700, 'Parse error: invalid JSON');
    return undefined;
  }
}

function sessionError(res: ServerResponse, sessionId: string | undefined): void {
  if (sessionId === undefined) {
    jsonRpcError(res, 400, -32000, 'Bad Request: Mcp-Session-Id header is required');
    return;
  }
  jsonRpcError(res, 404, -32001, 'Session not found');
}

function jsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  json(res, status, { jsonrpc: '2.0', error: { code, message }, id: null });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
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
  const args = parseArgs(process.argv.slice(2));
  const mode = args.get('mode') ?? 'http-session';
  if (mode !== 'http-session' && mode !== 'http-fresh' && mode !== 'v2-http') {
    process.stderr.write(`[capture] unknown --mode ${mode}\n`);
    process.exit(2);
  }
  const running = await startCaptureHttp({
    mode,
    trial: requiredArg(args, 'trial'),
    outDir: requiredArg(args, 'out'),
    port: args.get('port') === undefined ? 8787 : Number(args.get('port')),
    groundTruth: {
      clientProduct: args.get('client-product') ?? null,
      clientSurface: args.get('client-surface') ?? null,
      clientVersion: args.get('client-version') ?? null,
      topology: args.get('topology') ?? null,
    },
  });
  const stop = (): void => {
    void running.close().then(
      () => process.exit(0),
      (error: unknown) => {
        process.stderr.write(`[capture] shutdown failed: ${String(error)}\n`);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
