import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export interface ListeningServer {
  url: URL;
  close: () => Promise<void>;
}

/**
 * Serve a Web `fetch` handler (v2 `createMcpHandler` or a streamable HTTP
 * transport) on an ephemeral localhost port.
 */
export async function listenFetch(
  handle: (request: Request) => Promise<Response>,
): Promise<ListeningServer> {
  const server = createServer((req, res) => {
    serve(req, res, handle).catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address == null || typeof address === 'string') throw new Error('no port assigned');
  return {
    url: new URL(`http://127.0.0.1:${address.port}/mcp`),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function serve(
  req: IncomingMessage,
  res: ServerResponse,
  handle: (request: Request) => Promise<Response>,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const body = Buffer.concat(chunks);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  const host = headers.get('host') ?? '127.0.0.1';
  const request = new Request(`http://${host}${req.url ?? '/mcp'}`, {
    method: req.method,
    headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
  });
  const response = await handle(request);
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });
  res.writeHead(response.status, responseHeaders);
  res.end(Buffer.from(await response.arrayBuffer()));
}
