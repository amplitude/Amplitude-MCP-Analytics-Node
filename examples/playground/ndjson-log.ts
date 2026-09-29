import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface NdjsonLog<Record extends object> {
  logPath: string;
  /** Serialize now, append in order. Resolves once this line is on disk. */
  write: (record: Record) => Promise<void>;
  /** Wait for queued lines. Later writes are dropped. */
  close: () => Promise<void>;
}

/**
 * Append-only NDJSON log. Existing content is never truncated or rewritten.
 *
 * Writes are serialized so lines do not interleave. The record is stringified
 * synchronously inside `write`, so a caller that mutates the object afterwards
 * does not change what was logged.
 */
export async function openNdjsonLog<Record extends object>(
  logPath: string,
  options: { onWritten?: (record: Record) => void } = {},
): Promise<NdjsonLog<Record>> {
  await mkdir(dirname(logPath), { recursive: true });
  // Create the file up front so `tail -f` works before the first line.
  await appendFile(logPath, '');

  let writes = Promise.resolve();
  let closed = false;
  const write = (record: Record): Promise<void> => {
    const line = `${JSON.stringify(record)}\n`;
    writes = writes.then(async () => {
      if (closed) return;
      try {
        await appendFile(logPath, line, 'utf8');
      } catch (error) {
        process.stderr.write(`[playground] failed to write ${logPath}: ${String(error)}\n`);
        return;
      }
      options.onWritten?.(record);
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
