import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export type PlaygroundTransportName = 'stdio' | 'streamable-http';

/** Identity of one playground process. Every log line it writes carries `runId`. */
export interface RunInfo {
  runId: string;
  pid: number;
  startedAt: number;
  transport: PlaygroundTransportName;
}

/** First line each log gets after a process starts. */
export interface RunStartedRecord {
  type: 'run_started';
  at: number;
  pid: number;
  transport: PlaygroundTransportName;
  runId: string;
}

export function createRunInfo(transport: PlaygroundTransportName): RunInfo {
  return { runId: randomUUID(), pid: process.pid, startedAt: Date.now(), transport };
}

export function runStartedRecord(run: RunInfo): RunStartedRecord {
  return { type: 'run_started', at: run.startedAt, pid: run.pid, transport: run.transport, runId: run.runId };
}

let lastSeq = 0;

/** Monotonic per process. Shared by the request, response, and track logs so they can be joined. */
export function nextSeq(): number {
  lastSeq += 1;
  return lastSeq;
}

/**
 * What an in-flight MCP request knows about itself. `http.ts` runs each
 * request inside this store; the SDK `track()` wrapper reads it to stamp
 * `requestSeq` and `sessionId` onto `sdk-track.ndjson`.
 */
export interface RequestStore {
  requestSeq: number;
  /** From the `mcp-session-id` request header, or assigned by the transport during `initialize`. */
  sessionId?: string;
}

export const requestContext = new AsyncLocalStorage<RequestStore>();

export function currentRequest(): RequestStore | undefined {
  return requestContext.getStore();
}
