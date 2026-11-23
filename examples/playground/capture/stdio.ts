import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { logStdioMessages } from '../request-log.js';
import { createPlayground } from '../server.js';
import {
  assertLoopbackSink,
  captureHooks,
  createRecorder,
  parseArgs,
  requiredArg,
  wrapTransport,
  type CaptureContext,
} from './context.js';
import { writeManifestOnce } from './manifest.js';
import { sanitizeMessage, scrubString } from './sanitize.js';

/**
 * Capture-mode stdio playground.
 *
 * Cursor, Claude Desktop, and Claude Code spawn this process. stdout is the
 * MCP protocol and must carry nothing else; everything else lands in the
 * trial directory, sanitized, or as short alias-only lines on stderr.
 *
 * The request tap reuses `logStdioMessages` — the same line-splitting
 * Transform the plain playground uses, forwarding bytes unchanged — but the
 * sink it writes to sanitizes instead of appending raw JSON.
 */
export async function startCaptureStdio(options: {
  trial: string;
  outDir: string;
  groundTruth?: Parameters<typeof writeManifestOnce>[1]['groundTruth'];
}): Promise<{ close: () => Promise<void> }> {
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
    mode: 'stdio',
    groundTruth: options.groundTruth ?? {
      clientProduct: null,
      clientSurface: null,
      clientVersion: null,
      topology: null,
    },
  });
  await recorder.lifecycle({ event: 'process-start', mode: 'stdio', trial: options.trial });

  const ctx: CaptureContext = {
    connection: `${recorder.aliaser.prefix}-proc`,
    serverInstance: `${recorder.aliaser.prefix}-srv-1`,
  };
  await recorder.lifecycle({ event: 'session-open', session: ctx.connection });

  // Sanitizing request tap: one record per client→server line.
  const tap = {
    logPath: '<capture>',
    write: async (record: { transport: string; message?: unknown; raw?: string }) => {
      const out: Record<string, unknown> = {
        trial: options.trial,
        mode: 'stdio',
        transport: 'stdio',
        connection: ctx.connection,
      };
      if (record.message !== undefined) {
        out.messages = [sanitizeMessage(record.message, recorder.aliaser)];
      } else {
        out.raw = typeof record.raw === 'string' ? scrubString(record.raw) : '<raw>';
      }
      await recorder.write('requests', out);
    },
    close: () => Promise.resolve(),
  };

  const transport = new StdioServerTransport(logStdioMessages(process.stdin, tap));
  await playground.server.connect(transport);
  wrapTransport(transport, ctx, recorder);
  await recorder.lifecycle({ event: 'transport-connected', session: ctx.connection });

  let closed = false;
  return {
    close: async () => {
      if (closed) return;
      closed = true;
      await transport.close().catch(() => undefined);
      await playground.close();
      await recorder.lifecycle({ event: 'session-close', session: ctx.connection });
      await recorder.lifecycle({ event: 'process-stop', mode: 'stdio', trial: options.trial });
      await recorder.close();
    },
  };
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(entry).href === import.meta.url;
}

if (isDirectRun()) {
  const args = parseArgs(process.argv.slice(2));
  const session: { running?: { close: () => Promise<void> } } = {};
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void (async () => {
      try {
        await session.running?.close();
        process.exit(0);
      } catch (error) {
        process.stderr.write(`[capture] shutdown failed: ${String(error)}\n`);
        process.exit(1);
      }
    })();
  };
  // Attach before any await; a client that already closed stdin will not
  // emit `end` again for a later listener.
  process.stdin.on('end', stop);
  process.stdin.on('close', stop);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  if (process.stdin.readableEnded) {
    stop();
  } else {
    session.running = await startCaptureStdio({
      trial: requiredArg(args, 'trial'),
      outDir: requiredArg(args, 'out'),
      groundTruth: {
        clientProduct: args.get('client-product') ?? null,
        clientSurface: args.get('client-surface') ?? null,
        clientVersion: args.get('client-version') ?? null,
        topology: args.get('topology') ?? null,
      },
    });
    if (process.stdin.readableEnded) stop();
  }
}
