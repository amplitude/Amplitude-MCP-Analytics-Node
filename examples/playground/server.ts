import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as amplitude from '@amplitude/analytics-node';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createMcpAnalytics, type AmplitudeMCPAnalytics } from '../../src/client.js';
import type { AmplitudeClientLike, AmplitudeEvent } from '../../src/types.js';
import { type NdjsonLog, openNdjsonLog } from './ndjson-log.js';
import { defaultRequestLogPath, openRequestLog, type RequestLog } from './request-log.js';
import {
  createRunInfo,
  currentRequest,
  nextSeq,
  type PlaygroundTransportName,
  type RunInfo,
  type RunStartedRecord,
  runStartedRecord,
} from './run.js';
import { startIngestionSink, type IngestionSink } from './sink.js';

export const PLAYGROUND_SERVER_NAME = 'amplitude-playground';
/** Fake key used only with the local sink. Never a real Amplitude project key. */
export const LOCAL_API_KEY = 'local-test-key';

const FLUSH_QUEUE_SIZE = 1;
const FLUSH_INTERVAL_MILLIS = 1000;

/**
 * One SDK `track()` call, as the SDK handed it to `@amplitude/analytics-node`.
 * `requestSeq` and `sessionId` come from the HTTP request being handled, or
 * are `null` when the call happened outside one (stdio, transport close).
 */
export interface SdkTrackRecord {
  type?: 'track';
  runId: string;
  seq: number;
  at: number;
  requestSeq: number | null;
  sessionId: string | null;
  event_type: string;
  user_id?: string;
  device_id?: string;
  event_properties?: Record<string, unknown>;
}

export type TrackLogRecord = RunStartedRecord | SdkTrackRecord;

export interface PlaygroundOptions {
  /** Which MCP transport this process serves. Recorded on every log line. */
  transport: PlaygroundTransportName;
  /**
   * Where the sink appends ingestion bodies. Ignored when delivery is live
   * Amplitude. Defaults to `examples/playground/events.ndjson`.
   */
  logPath?: string;
  /**
   * Where SDK `track()` calls are appended. Defaults to
   * `examples/playground/sdk-track.ndjson`.
   */
  trackLogPath?: string;
  /**
   * `sink` logs HTTP V2 bodies locally. `amplitude` sends them to Amplitude
   * using `AMPLITUDE_API_KEY`. When omitted, a set key selects Amplitude and
   * anything else selects the sink.
   */
  delivery?: 'sink' | 'amplitude';
  /**
   * Where client MCP requests are appended. Defaults to
   * `examples/playground/mcp-requests.ndjson`.
   */
  requestLogPath?: string;
}

export interface Playground {
  run: RunInfo;
  server: McpServer;
  analytics: AmplitudeMCPAnalytics;
  sink?: IngestionSink;
  logPath?: string;
  /** Client-to-server MCP messages, including tool arguments. */
  requests: RequestLog;
  /** Every SDK `track()` call, before `@amplitude/analytics-node` batches it. */
  tracks: NdjsonLog<TrackLogRecord>;
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
export async function createPlayground(options: PlaygroundOptions): Promise<Playground> {
  const run = createRunInfo(options.transport);
  const delivery = resolveDelivery(options.delivery);
  const logPath = options.logPath ?? defaultLogPath();
  const sink = delivery === 'sink' ? await startIngestionSink({ logPath, run }) : undefined;
  const requests = await openRequestLog(options.requestLogPath ?? defaultRequestLogPath(), run);
  const tracks = await openNdjsonLog<TrackLogRecord>(options.trackLogPath ?? defaultTrackLogPath());
  await tracks.write(runStartedRecord(run));
  const apiKey = delivery === 'amplitude' ? requiredApiKey() : LOCAL_API_KEY;

  const initOptions: amplitude.Types.NodeOptions = {
    flushQueueSize: FLUSH_QUEUE_SIZE,
    flushIntervalMillis: FLUSH_INTERVAL_MILLIS,
  };
  if (sink) initOptions.serverUrl = sink.serverUrl;

  await amplitude.init(apiKey, initOptions).promise;

  const analytics = createMcpAnalytics({
    amplitude: amplitudeClient(run, tracks),
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

  process.stderr.write(`[playground] run ${run.runId}\n`);
  process.stderr.write(`[playground] logging MCP requests to ${requests.logPath}\n`);
  process.stderr.write(`[playground] logging SDK track() calls to ${tracks.logPath}\n`);
  if (sink) {
    process.stderr.write(`[playground] logging ingestion payloads to ${sink.logPath}\n`);
  } else {
    process.stderr.write('[playground] sending events to Amplitude\n');
  }

  let closed = false;
  const playground: Playground = {
    run,
    server,
    analytics,
    sink,
    logPath: sink?.logPath,
    requests,
    tracks,
    flush: () => flushAnalytics(analytics),
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        await flushAnalytics(analytics);
      } finally {
        try {
          await sink?.close();
        } finally {
          try {
            await requests.close();
          } finally {
            await tracks.close();
          }
        }
      }
    },
  };
  return playground;
}

export function defaultLogPath(): string {
  return fileURLToPath(new URL('./events.ndjson', import.meta.url));
}

export function defaultTrackLogPath(): string {
  return fileURLToPath(new URL('./sdk-track.ndjson', import.meta.url));
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
 *
 * The wrapper also appends each call to `sdk-track.ndjson`. It reads the
 * event and the current request store; it does not change the event or
 * what `@amplitude/analytics-node` sends. A failed log write is reported on
 * stderr and the event still goes through.
 */
function amplitudeClient(run: RunInfo, tracks: NdjsonLog<TrackLogRecord>): AmplitudeClientLike {
  return {
    track: (event) => {
      try {
        void tracks.write(trackRecord(run, event));
      } catch (error) {
        process.stderr.write(`[playground] failed to record track(): ${String(error)}\n`);
      }
      amplitude.track(event as Parameters<typeof amplitude.track>[0]);
    },
    flush: () => amplitude.flush(),
  };
}

function trackRecord(run: RunInfo, event: AmplitudeEvent): SdkTrackRecord {
  const request = currentRequest();
  const record: SdkTrackRecord = {
    type: 'track',
    runId: run.runId,
    seq: nextSeq(),
    at: Date.now(),
    requestSeq: request?.requestSeq ?? null,
    sessionId: request?.sessionId ?? null,
    event_type: event.event_type,
  };
  if (typeof event.user_id === 'string') record.user_id = event.user_id;
  if (typeof event.device_id === 'string') record.device_id = event.device_id;
  if (event.event_properties != null) record.event_properties = { ...event.event_properties };
  return record;
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
