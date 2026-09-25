import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
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

/**
 * Session-bearing Streamable HTTP server. One long-lived process, one
 * transport: fine for a single local client (Inspector, Cursor, a test).
 */
export async function startPlaygroundHttp(options: PlaygroundHttpOptions = {}): Promise<RunningPlaygroundHttp> {
  const playground = await createPlayground(options);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await playground.server.connect(transport);

  const http = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname !== PLAYGROUND_HTTP_PATH) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    void transport.handleRequest(req, res).catch(() => {
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
      await transport.close();
      await closeHttp(http);
      await playground.close();
    },
  };
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
