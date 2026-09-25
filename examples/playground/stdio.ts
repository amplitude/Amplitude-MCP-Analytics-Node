import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { logStdioMessages } from './request-log.js';
import { createPlayground } from './server.js';

/**
 * stdio entry for Cursor, Claude Desktop, and Claude Code.
 *
 * stdout is the MCP protocol. Payload logs go to the ndjson file and to stderr.
 *
 * The ingestion sink keeps the process alive after the client disconnects, and
 * the stdio transport does not close itself when stdin ends. Watch stdin and
 * close the transport (so `[MCP] Session Ended` can fire) before flushing.
 */
async function main(): Promise<void> {
  const session: {
    playground?: Awaited<ReturnType<typeof createPlayground>>;
    transport?: StdioServerTransport;
  } = {};
  let stopping = false;

  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void (async () => {
      try {
        await session.transport?.close();
        await session.playground?.close();
        process.exit(0);
      } catch (error) {
        process.stderr.write(`[playground] shutdown failed: ${String(error)}\n`);
        process.exit(1);
      }
    })();
  };

  // Attach before any await. A client that already closed stdin will not
  // emit `end` again for a listener registered later.
  process.stdin.on('end', stop);
  process.stdin.on('close', stop);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  if (process.stdin.readableEnded) {
    stop();
    return;
  }

  session.playground = await createPlayground();
  if (stopping) return;
  session.transport = new StdioServerTransport(logStdioMessages(process.stdin, session.playground.requests));
  await session.playground.server.connect(session.transport);
  if (process.stdin.readableEnded) stop();
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(entry).href === import.meta.url;
}

if (isDirectRun()) {
  await main();
}
