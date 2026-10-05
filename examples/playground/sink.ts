import { appendFile, mkdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { dirname } from 'node:path';

/** Bytes of one ingestion POST we will buffer. Playground batches are small. */
const MAX_BODY_BYTES = 1_000_000;

export interface IngestionSink {
  /** Pass this to `@amplitude/analytics-node` as `serverUrl`. */
  serverUrl: string;
  logPath: string;
  close: () => Promise<void>;
}

/**
 * Local stand-in for Amplitude's HTTP V2 endpoint.
 *
 * `@amplitude/analytics-node` POSTs `{ api_key, events, options }` and decides
 * success from the JSON `code` field, not the HTTP status. It also never
 * resolves the request if the body is empty, so every response is JSON.
 */
export async function startIngestionSink(options: { logPath: string }): Promise<IngestionSink> {
  await mkdir(dirname(options.logPath), { recursive: true });
  // Create the file up front so `tail -f` works before the first event.
  await appendFile(options.logPath, '');

  let writes = Promise.resolve();
  const enqueue = (line: string): Promise<void> => {
    writes = writes.then(() => appendFile(options.logPath, line, 'utf8'));
    return writes;
  };

  const server = createServer((req, res) => {
    void handleIngestion(req, res, enqueue, options.logPath);
  });

  await listen(server);
  const address = server.address();
  if (address == null || typeof address === 'string') {
    throw new Error('ingestion sink did not receive a TCP port');
  }

  return {
    serverUrl: `http://127.0.0.1:${address.port}/2/httpapi`,
    logPath: options.logPath,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function listen(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // Port 0: the playground does not need a stable sink port, only the URL
    // it hands to analytics-node.
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

async function handleIngestion(
  req: IncomingMessage,
  res: ServerResponse,
  enqueue: (line: string) => Promise<void>,
  logPath: string,
): Promise<void> {
  if (req.method !== 'POST') {
    json(res, 405, { code: 405, error: 'method not allowed' });
    return;
  }

  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    json(res, 413, { code: 413, error: 'payload too large' });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    json(res, 400, { code: 400, error: 'invalid json' });
    return;
  }

  const line = raw.endsWith('\n') ? raw : `${raw}\n`;
  try {
    await enqueue(line);
  } catch (error) {
    process.stderr.write(`[playground] failed to write ${logPath}: ${String(error)}\n`);
    json(res, 500, { code: 500, error: 'failed to write log' });
    return;
  }
  const events = eventTypes(parsed);
  const count = events.length;
  process.stderr.write(
    `[playground] ingested ${count} ${count === 1 ? 'event' : 'events'}${
      count > 0 ? `: ${events.join(', ')}` : ''
    }\n`,
  );
  json(res, 200, {
    code: 200,
    events_ingested: count,
    payload_size_bytes: Buffer.byteLength(raw),
    server_upload_time: Date.now(),
  });
}

function eventTypes(body: unknown): string[] {
  if (body == null || typeof body !== 'object' || !('events' in body)) return [];
  const events = body.events;
  if (!Array.isArray(events)) return [];
  return events.map((event) => {
    if (event != null && typeof event === 'object' && 'event_type' in event) {
      const eventType = event.event_type;
      if (typeof eventType === 'string' && eventType.length > 0) return eventType;
    }
    return 'unknown';
  });
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
