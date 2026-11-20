import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client as V1Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport as V1Stdio } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Client as V2Client } from '@modelcontextprotocol/client';
import { StdioClientTransport as V2Stdio } from '@modelcontextprotocol/client/stdio';
import type { AmplitudeEvent } from '../../src/types.js';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'stdio-server.ts');
const REGISTER = join(import.meta.dirname, 'stdio-register.mjs');
const ENTRY = join(import.meta.dirname, 'stdio-entry.mjs');

export type StdioLine = 'v1' | 'v2';

export interface StdioSession {
  client: {
    callTool: (params: { name: string; arguments?: Record<string, unknown> }) => Promise<unknown>;
    close: () => Promise<void>;
  };
  events: () => Promise<AmplitudeEvent[]>;
  close: () => Promise<void>;
}

async function connectClient<T>(
  client: StdioSession['client'] & { connect: (transport: T) => Promise<unknown> },
  transport: T & { pid: number | null },
): Promise<{ client: StdioSession['client']; pid: number | null }> {
  await client.connect(transport);
  return { client, pid: transport.pid };
}

/** Older stdio clients leave the child running after `close()`. */
async function stopChild(pid: number | null): Promise<void> {
  if (pid == null) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Spawn a real stdio server and connect a client from the same SDK line. */
export async function connectStdio(line: StdioLine): Promise<StdioSession> {
  const dir = await mkdtemp(join(tmpdir(), `mcp-stdio-${line}-`));
  const eventsFile = join(dir, 'events.ndjson');
  const parameters = {
    command: process.execPath,
    args: ['--disable-warning=ExperimentalWarning', '--import', REGISTER, ENTRY],
    env: {
      PATH: process.env.PATH ?? '',
      MCP_SDK_LINE: line,
      MCP_STDIO_FIXTURE: FIXTURE,
      MCP_EVENTS_FILE: eventsFile,
    },
    stderr: 'pipe' as const,
    cwd: join(import.meta.dirname, '../..'),
  };
  // Connect inside each branch so a v1 transport is never checked against the
  // v2 client (and the reverse). The two SDKs' transport types are not
  // assignable to each other.
  const connected = line === 'v1'
    ? await connectClient(new V1Client({ name: 'stdio-client', version: '1.0.0' }), new V1Stdio(parameters))
    : await connectClient(new V2Client({ name: 'stdio-client', version: '1.0.0' }), new V2Stdio(parameters));

  const client: StdioSession['client'] = {
    callTool: (params) => connected.client.callTool(params),
    close: async () => {
      await connected.client.close().catch(() => undefined);
      await stopChild(connected.pid);
    },
  };
  return {
    client,
    events: async () => readEvents(eventsFile),
    close: async () => {
      await client.close().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function readEvents(file: string): Promise<AmplitudeEvent[]> {
  try {
    const text = await readFile(file, 'utf8');
    return text
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as AmplitudeEvent);
  } catch {
    return [];
  }
}

/** Poll until `ready` or the timeout, so a close-time session event can land. */
export async function waitForEvents(
  read: () => Promise<AmplitudeEvent[]>,
  ready: (events: AmplitudeEvent[]) => boolean,
): Promise<AmplitudeEvent[]> {
  const deadline = Date.now() + 5_000;
  let events = await read();
  while (!ready(events) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    events = await read();
  }
  return events;
}
