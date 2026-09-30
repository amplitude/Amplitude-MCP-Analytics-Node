import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createPlayground, type Playground, type PlaygroundOptions } from './server.js';

export const PLAYGROUND_HTTP_PORT = 8787;
export const PLAYGROUND_HTTP_PATH = '/mcp';

export interface PlaygroundHttpOptions extends PlaygroundOptions {
  /** TCP port. `0` asks the OS for one. Default {@link PLAYGROUND_HTTP_PORT}. */
  port?: number;
}

export interface RunningPlaygroundHttp {
  url: URL;
  playground: Playground;
  flush: () => Promise<void>;
  close: () => Promise<void>;
}

/** One MCP session: a transport serves exactly one session, a server one transport. */
interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

/**
 * Session-bearing Streamable HTTP server. One long-lived process serving any
 * number of sessions over its lifetime.
 *
 * Each `initialize` gets its own transport and server, looked up afterwards by
 * `Mcp-Session-Id`. A single shared transport would be unusable after the first
 * session ends: clients such as Codex probe with a short session, `DELETE` it,
 * and reconnect when a tool is first called.
 */
export async function startPlaygroundHttp(options: PlaygroundHttpOptions = {}): Promise<RunningPlaygroundHttp> {
  const playground = await createPlayground(options);
  const sessions = new Map<string, Session>();

  const http = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname !== PLAYGROUND_HTTP_PATH) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    void handleMcpRequest(req, res, sessions, playground).catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
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
      // Closing a transport ends its session, so `[MCP] Session Ended` fires.
      await Promise.allSettled([...sessions.values()].map((session) => session.transport.close()));
      await closeHttp(http);
      await playground.close();
    },
  };
}

const MAX_MCP_BODY_BYTES = 1_000_000;

/**
 * Log the client request, then hand it to the session's transport.
 *
 * The body is read here so it can be written to the request log. The parsed
 * value is passed into `handleRequest` because that stream can only be read once.
 */
async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  sessions: Map<string, Session>,
  playground: Playground,
): Promise<void> {
  const requests = playground.requests;
  const sessionId = headerValue(req.headers['mcp-session-id']);
  const existing = sessionId === undefined ? undefined : sessions.get(sessionId);

  if (req.method !== 'POST') {
    await requests.write({ transport: 'streamable-http', httpMethod: req.method ?? 'UNKNOWN' });
    if (existing == null) {
      sessionError(res, sessionId);
      return;
    }
    await existing.transport.handleRequest(req, res);
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
    await requests.write({ transport: 'streamable-http', httpMethod: 'POST', raw });
    jsonRpcError(res, 400, -32700, 'Parse error: invalid JSON');
    return;
  }

  const messages = Array.isArray(parsed) ? parsed : [parsed];
  if (messages.length === 0) {
    await requests.write({ transport: 'streamable-http', httpMethod: 'POST', message: parsed });
  } else {
    for (const message of messages) {
      await requests.write({ transport: 'streamable-http', httpMethod: 'POST', message });
    }
  }

  // An `initialize` always opens a new session, even when the client still
  // sends the id of one this process no longer knows (for example after a
  // restart). Anything else needs a session that exists.
  if (messages.some((message) => isInitializeRequest(message))) {
    const session = await openSession(sessions, playground);
    await session.transport.handleRequest(req, res, parsed);
    // A rejected initialize never produced a session id: release its server.
    if (session.transport.sessionId === undefined) {
      await session.server.close().catch(() => undefined);
    }
    return;
  }

  if (existing == null) {
    sessionError(res, sessionId);
    return;
  }
  await existing.transport.handleRequest(req, res, parsed);
}

async function openSession(sessions: Map<string, Session>, playground: Playground): Promise<Session> {
  const server = playground.createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      sessions.set(id, session);
      process.stderr.write(`[playground] session opened ${id} (${sessions.size} active)\n`);
    },
  });
  const session: Session = { transport, server };
  // Set before `connect`, which chains onto an existing `onclose`.
  transport.onclose = () => {
    const id = transport.sessionId;
    if (id === undefined || !sessions.delete(id)) return;
    process.stderr.write(`[playground] session closed ${id} (${sessions.size} active)\n`);
  };
  await server.connect(transport);
  return session;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined || first.length === 0 ? undefined : first;
}

/** MCP Streamable HTTP: an unknown session is 404 so the client re-initializes. */
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
