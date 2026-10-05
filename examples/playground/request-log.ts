import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

export type PlaygroundTransportName = 'stdio' | 'streamable-http';

/** One client-to-server MCP message. Tool arguments are kept on purpose. */
export interface McpRequestRecord {
  transport: PlaygroundTransportName;
  httpMethod?: string;
  /** Parsed JSON-RPC message, when the body was JSON. */
  message?: unknown;
  /** Original text when the body was not JSON. */
  raw?: string;
}

export interface RequestLog {
  logPath: string;
  write: (record: McpRequestRecord) => Promise<void>;
  close: () => Promise<void>;
}

export function defaultRequestLogPath(): string {
  return fileURLToPath(new URL('./mcp-requests.ndjson', import.meta.url));
}

/**
 * Append-only NDJSON log of MCP requests the client sends.
 *
 * Writes are serialized so lines do not interleave. `close()` waits for the
 * queue to drain.
 */
export async function openRequestLog(logPath: string): Promise<RequestLog> {
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, '');

  let writes = Promise.resolve();
  let closed = false;
  const write = (record: McpRequestRecord): Promise<void> => {
    const line = `${JSON.stringify(record)}\n`;
    writes = writes.then(async () => {
      if (closed) return;
      try {
        await appendFile(logPath, line, 'utf8');
      } catch (error) {
        process.stderr.write(`[playground] failed to write ${logPath}: ${String(error)}\n`);
        return;
      }
      process.stderr.write(`[playground] mcp ${summarize(record)}\n`);
    });
    return writes;
  };

  return {
    logPath,
    write,
    close: async () => {
      await writes;
      closed = true;
    },
  };
}

/**
 * Forward `input` unchanged, and log each newline-delimited JSON-RPC message
 * before the bytes are readable downstream.
 *
 * The stdio transport does not expose a message hook. This stream is the
 * stdin it reads. Waiting for the log write before forwarding means a tool
 * call is on disk before the server handles it.
 */
export function logStdioMessages(input: Readable, log: RequestLog): Readable {
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  const transform = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      pending = Buffer.concat([pending, chunk]);
      void flushCompleteLines(pending, log)
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
          await log.write({ transport: 'stdio', raw: leftover });
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
): Promise<{ pending: Buffer; forward: Buffer }> {
  let consumed = 0;
  let newline = pending.indexOf(0x0a);
  while (newline !== -1) {
    const line = pending.subarray(consumed, newline).toString('utf8').replace(/\r$/, '');
    consumed = newline + 1;
    if (line.length > 0) await log.write(stdioRecord(line));
    newline = pending.indexOf(0x0a, consumed);
  }
  return {
    pending: pending.subarray(consumed),
    forward: consumed > 0 ? pending.subarray(0, consumed) : Buffer.alloc(0),
  };
}

function stdioRecord(line: string): McpRequestRecord {
  try {
    return { transport: 'stdio', message: JSON.parse(line) as unknown };
  } catch {
    return { transport: 'stdio', raw: line };
  }
}

function summarize(record: McpRequestRecord): string {
  const message = record.message;
  if (message != null && typeof message === 'object' && 'method' in message) {
    const method = message.method;
    if (typeof method === 'string') {
      const name = toolName(message);
      return name == null ? method : `${method} ${name}`;
    }
  }
  if (record.httpMethod) return record.httpMethod;
  return 'message';
}

function toolName(message: object): string | undefined {
  if (!('params' in message)) return undefined;
  const params = message.params;
  if (params == null || typeof params !== 'object' || !('name' in params)) return undefined;
  return typeof params.name === 'string' ? params.name : undefined;
}
