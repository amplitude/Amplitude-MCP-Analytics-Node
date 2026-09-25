import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as amplitude from '@amplitude/analytics-node';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createMcpAnalytics, type AmplitudeMCPAnalytics } from '../../src/client.js';
import type { AmplitudeClientLike } from '../../src/types.js';
import { startIngestionSink, type IngestionSink } from './sink.js';

export const PLAYGROUND_SERVER_NAME = 'amplitude-playground';
/** Fake key used only with the local sink. Never a real Amplitude project key. */
export const LOCAL_API_KEY = 'local-test-key';

const FLUSH_QUEUE_SIZE = 1;
const FLUSH_INTERVAL_MILLIS = 1000;

export interface PlaygroundOptions {
  /**
   * Where the sink appends ingestion bodies. Ignored when delivery is live
   * Amplitude. Defaults to `examples/playground/events.ndjson`.
   */
  logPath?: string;
  /**
   * `sink` logs HTTP V2 bodies locally. `amplitude` sends them to Amplitude
   * using `AMPLITUDE_API_KEY`. When omitted, a set key selects Amplitude and
   * anything else selects the sink.
   */
  delivery?: 'sink' | 'amplitude';
}

export interface Playground {
  server: McpServer;
  analytics: AmplitudeMCPAnalytics;
  sink?: IngestionSink;
  logPath?: string;
  flush: () => Promise<void>;
  /** Flush queued events, then stop the sink. Does not close the MCP transport. */
  close: () => Promise<void>;
}

/**
 * Instrumented MCP server with two dummy tools.
 *
 * Not connected to a transport — `stdio.ts` and `http.ts` do that. Call
 * `close()` on shutdown so the last batch is delivered before the process
 * exits. analytics-node flushes on an interval (`flushIntervalMillis`); the
 * queue size only splits a batch, it does not send early.
 */
export async function createPlayground(options: PlaygroundOptions = {}): Promise<Playground> {
  const delivery = resolveDelivery(options.delivery);
  const logPath = options.logPath ?? defaultLogPath();
  const sink = delivery === 'sink' ? await startIngestionSink({ logPath }) : undefined;
  const apiKey = delivery === 'amplitude' ? requiredApiKey() : LOCAL_API_KEY;

  const initOptions: amplitude.Types.NodeOptions = {
    flushQueueSize: FLUSH_QUEUE_SIZE,
    flushIntervalMillis: FLUSH_INTERVAL_MILLIS,
  };
  if (sink) initOptions.serverUrl = sink.serverUrl;

  await amplitude.init(apiKey, initOptions).promise;

  const analytics = createMcpAnalytics({
    amplitude: amplitudeClient(),
    serverName: PLAYGROUND_SERVER_NAME,
    serverVersion: packageVersion(),
  });

  const server = new McpServer(
    { name: PLAYGROUND_SERVER_NAME, version: packageVersion() },
    {
      instructions:
        'Local playground for Amplitude MCP analytics. echo returns the message you pass and, when you include rationale, records why you called it. whoami records a fixed playground user id. Neither tool does any other work.',
    },
  );

  server.tool(
    'echo',
    'Return the message you were given. Include rationale when you know why you are calling this tool.',
    {
      message: z.string().describe('Text to echo back.'),
      rationale: z.string().optional().describe('Why you called this tool.'),
    },
    analytics.instrumentTool(async (args) => {
      if (typeof args.rationale === 'string' && args.rationale.length > 0) {
        analytics.setRationale(args.rationale);
      }
      const message = typeof args.message === 'string' ? args.message : '';
      return { content: [{ type: 'text' as const, text: message }] };
    }, { name: 'echo' }),
  );

  server.tool(
    'whoami',
    'Report the playground user id and attach it to analytics for this call.',
    analytics.instrumentTool(async () => {
      analytics.setIdentity({ userId: 'playground-user' });
      return { content: [{ type: 'text' as const, text: 'playground-user' }] };
    }, { name: 'whoami' }),
  );

  analytics.instrumentServer(server);

  if (sink) {
    process.stderr.write(`[playground] logging ingestion payloads to ${sink.logPath}\n`);
  } else {
    process.stderr.write('[playground] sending events to Amplitude\n');
  }

  let closed = false;
  const playground: Playground = {
    server,
    analytics,
    sink,
    logPath: sink?.logPath,
    flush: () => flushAnalytics(analytics),
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        await flushAnalytics(analytics);
      } finally {
        await sink?.close();
      }
    },
  };
  return playground;
}

export function defaultLogPath(): string {
  return fileURLToPath(new URL('./events.ndjson', import.meta.url));
}

function resolveDelivery(explicit: PlaygroundOptions['delivery']): 'sink' | 'amplitude' {
  if (explicit) return explicit;
  return process.env.AMPLITUDE_API_KEY ? 'amplitude' : 'sink';
}

function requiredApiKey(): string {
  const apiKey = process.env.AMPLITUDE_API_KEY;
  if (!apiKey) {
    throw new Error(
      'AMPLITUDE_API_KEY is not set. Leave it unset to log payloads locally, or export a project key to deliver to Amplitude.',
    );
  }
  return apiKey;
}

/**
 * The Node SDK's module object is the client `createMcpAnalytics` accepts.
 * Its `track` parameter type is narrower than {@link AmplitudeClientLike}, so
 * the call is wrapped instead of passing the module through as `amplitude`.
 */
function amplitudeClient(): AmplitudeClientLike {
  return {
    track: (event) => {
      amplitude.track(event as Parameters<typeof amplitude.track>[0]);
    },
    flush: () => amplitude.flush(),
  };
}

async function flushAnalytics(analytics: AmplitudeMCPAnalytics): Promise<void> {
  const pending = analytics.flush() as { promise?: Promise<unknown> } | undefined;
  if (pending && typeof pending === 'object' && pending.promise) {
    await pending.promise;
  }
}

function packageVersion(): string {
  const path = fileURLToPath(new URL('../../package.json', import.meta.url));
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (parsed != null && typeof parsed === 'object' && 'version' in parsed && typeof parsed.version === 'string') {
    return parsed.version;
  }
  return '0.0.0';
}
