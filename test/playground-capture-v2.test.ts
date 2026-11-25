/**
 * Validation gate for the v2 capture modes (`v2-http`, `v2-stdio`) backed by
 * `@modelcontextprotocol/server` 2.4.x — the line that answers
 * `server/discover` and negotiates protocol revision 2026-07-28.
 */
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client as V2Client, StreamableHTTPClientTransport as V2Http } from '@modelcontextprotocol/client';
import { StdioClientTransport as V2Stdio } from '@modelcontextprotocol/client/stdio';
import { Client as V1Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport as V1Stdio } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport as V1Http } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { startCaptureHttp, type RunningCaptureHttp } from '../examples/playground/capture/http.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLIENT_INFO = { name: 'capture-harness-synthetic', version: '0.0.1' };
const BASELINE = 'baseline-t1-call-1';
const TIMEOUT = 60_000;

type Nd = Record<string, unknown>;

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

async function readNdjson(path: string): Promise<Nd[]> {
  const raw = await readFile(path, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Nd);
}

async function readAll(dir: string): Promise<Map<string, Nd[]>> {
  const out = new Map<string, Nd[]>();
  for (const file of await readdir(dir)) {
    if (file.endsWith('.ndjson')) out.set(file, await readNdjson(join(dir, file)));
  }
  return out;
}

async function waitFor(dir: string, pred: (f: Map<string, Nd[]>) => boolean, ms = 20_000): Promise<Map<string, Nd[]>> {
  const deadline = Date.now() + ms;
  for (;;) {
    let files: Map<string, Nd[]> | undefined;
    try {
      files = await readAll(dir);
    } catch {
      files = new Map();
    }
    if (pred(files)) return files;
    if (Date.now() > deadline) throw new Error(`timed out waiting for capture files in ${dir}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function messages(files: Map<string, Nd[]>, method: string): Nd[] {
  return (files.get('requests.ndjson') ?? [])
    .flatMap((record) => (record.messages as Nd[] | undefined) ?? [])
    .filter((message) => message.method === method);
}

async function startV2(trial: string): Promise<{ running: RunningCaptureHttp; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-capture-v2-'));
  const running = await startCaptureHttp({ mode: 'v2-http', trial, outDir: dir, port: 0 });
  cleanup.push(running.close);
  return { running, dir };
}

function connectV2Http(url: URL, opts?: { pin?: string; name?: string; version?: string; headers?: Record<string, string> }): Promise<{ client: V2Client; transport: V2Http }> {
  const client = new V2Client(
    { name: opts?.name ?? CLIENT_INFO.name, version: opts?.version ?? CLIENT_INFO.version },
    opts?.pin ? { versionNegotiation: { mode: { pin: opts.pin } } } : {},
  );
  const transport = new V2Http(url, opts?.headers ? { requestInit: { headers: opts.headers } } : undefined);
  return client.connect(transport).then(() => {
    cleanup.push(() => client.close());
    return { client, transport };
  });
}

describe('v2 capture — v2-http', () => {
  it('records per-request identity for a 2026-07-28-pinned client', { timeout: TIMEOUT }, async () => {
    const { running, dir } = await startV2('t-v2-modern');
    const { client } = await connectV2Http(running.url, { pin: '2026-07-28' });
    const result = await client.callTool({ name: 'echo', arguments: { message: BASELINE } });
    expect(result).toMatchObject({ content: [{ type: 'text', text: BASELINE }] });
    await running.flush();
    const files = await waitFor(dir, (f) =>
      (f.get('ingestion.ndjson') ?? []).some((b) =>
        ((b.events as Nd[] | undefined) ?? []).some((e) => e.event_type === '[MCP] Tool Call Response'),
      ),
    );

    const call = messages(files, 'tools/call').find((m) => (m.params as Nd)?.name === 'echo');
    expect((call?.params as Nd)?.message).toBe(BASELINE);
    const meta = (call?.params as Nd)?._meta as Nd | undefined;
    expect((meta?.['io.modelcontextprotocol/clientInfo'] as Nd)?.name).toBe(CLIENT_INFO.name);
    expect(meta?.['io.modelcontextprotocol/protocolVersion']).toBe('2026-07-28');

    const toolEvent = (files.get('events.ndjson') ?? []).find(
      (e) => (e.event as Nd)?.event_type === '[MCP] Tool Call Response',
    );
    expect(toolEvent?.rpcId).toBe(call?.id);
    const props = ((toolEvent?.event as Nd)?.event_properties ?? {}) as Nd;
    expect(props['[MCP] Client Name']).toBe(CLIENT_INFO.name);
    expect(props['[MCP] Client Version']).toBe(CLIENT_INFO.version);
    expect(props['[MCP] Protocol Version']).toBe('2026-07-28');

    const insertId = (toolEvent?.event as Nd)?.insert_id;
    expect(
      (files.get('ingestion.ndjson') ?? [])
        .flatMap((b) => (b.events as Nd[] | undefined) ?? [])
        .some((e) => e.insert_id === insertId),
    ).toBe(true);
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as Nd;
    expect(manifest.serverLine).toBe('v2');
  });

  it('serves a legacy v1 client statelessly — snapshot of Client Name', { timeout: TIMEOUT }, async () => {
    const { running, dir } = await startV2('t-v2-legacy');
    const client = new V1Client(CLIENT_INFO);
    await client.connect(new V1Http(running.url));
    cleanup.push(() => client.close());
    await client.callTool({ name: 'echo', arguments: { message: BASELINE } });
    await running.flush();
    const files = await waitFor(dir, (f) =>
      (f.get('events.ndjson') ?? []).some((e) => (e.event as Nd)?.event_type === '[MCP] Tool Call Response'),
    );
    const toolEvent = (files.get('events.ndjson') ?? []).find(
      (e) => (e.event as Nd)?.event_type === '[MCP] Tool Call Response',
    );
    const props = ((toolEvent?.event as Nd)?.event_properties ?? {}) as Nd;
    console.log(`[v2-capture] legacy-client [MCP] Client Name = ${JSON.stringify(props['[MCP] Client Name'])}`);
    const init = messages(files, 'initialize')[0];
    expect((init?.params as Nd)?.clientInfo).toMatchObject(CLIENT_INFO);
  });

  it('records server/discover for a default-negotiation client', { timeout: TIMEOUT }, async () => {
    const { running, dir } = await startV2('t-v2-discover');
    const { client } = await connectV2Http(running.url); // default negotiation
    await client.callTool({ name: 'echo', arguments: { message: BASELINE } });
    await running.flush();
    const files = await waitFor(dir, (f) => (f.get('requests.ndjson') ?? []).length > 0);
    const discover = messages(files, 'server/discover');
    console.log(`[v2-capture] server/discover messages seen: ${discover.length}`);
    const responses = files.get('responses.ndjson') ?? [];
    const discoverResponse = responses.find((r) => r.discover != null);
    console.log(`[v2-capture] discover response: ${JSON.stringify(discoverResponse?.discover)}`);
    // Whether or not this client version sends server/discover, the capture must record it if sent.
    if (discover.length > 0) {
      expect(discoverResponse).toBeDefined();
      expect((discoverResponse?.discover as Nd)?.supportedVersions).toContain('2026-07-28');
    }
  });

  it('never crosses identities between concurrent modern clients', { timeout: TIMEOUT }, async () => {
    const { running, dir } = await startV2('t-v2-conc');
    const a = await connectV2Http(running.url, { pin: '2026-07-28', name: 'client-A', version: '1.0.0' });
    const b = await connectV2Http(running.url, { pin: '2026-07-28', name: 'client-B', version: '2.0.0' });
    await Promise.all([
      ...Array.from({ length: 5 }, (_, i) => a.client.callTool({ name: 'echo', arguments: { message: `baseline-a${i}-call-${i}` } })),
      ...Array.from({ length: 5 }, (_, i) => b.client.callTool({ name: 'echo', arguments: { message: `baseline-b${i}-call-${i}` } })),
    ]);
    await running.flush();
    const files = await waitFor(
      dir,
      (f) =>
        (f.get('events.ndjson') ?? []).filter((e) => (e.event as Nd)?.event_type === '[MCP] Tool Call Response')
          .length >= 10,
    );
    const callByMessage = new Map<string, { id: unknown; request: Nd; clientName: string }>();
    for (const request of files.get('requests.ndjson') ?? []) {
      for (const message of (request.messages as Nd[] | undefined) ?? []) {
        const params = message.params as Nd | undefined;
        if (message.method === 'tools/call' && typeof params?.message === 'string') {
          const meta = (params._meta ?? {}) as Nd;
          const ci = (meta['io.modelcontextprotocol/clientInfo'] ?? {}) as Nd;
          callByMessage.set(params.message, { id: message.id, request, clientName: String(ci.name) });
        }
      }
    }
    const echoEvents = (files.get('events.ndjson') ?? []).filter(
      (e) =>
        (e.event as Nd)?.event_type === '[MCP] Tool Call Response' &&
        (((e.event as Nd)?.event_properties as Nd) ?? {})['[MCP] Tool Name'] === 'echo',
    );
    const joined = echoEvents.filter((event) =>
      [...callByMessage.values()].some(
        (info) => info.id === event.rpcId && info.request.requestAlias === event.requestAlias,
      ),
    );
    expect(joined.length).toBe(10);
    // Each joined event's Client Name matches the client that sent the request.
    for (const event of joined) {
      const info = [...callByMessage.values()].find(
        (i) => i.id === event.rpcId && i.request.requestAlias === event.requestAlias,
      );
      const props = ((event.event as Nd)?.event_properties ?? {}) as Nd;
      expect(props['[MCP] Client Name']).toBe(info?.clientName);
    }
  });

  it('keeps canaries out of every file (v2-http)', { timeout: TIMEOUT }, async () => {
    const { running, dir } = await startV2('t-v2-canary');
    const { client } = await connectV2Http(running.url, {
      pin: '2026-07-28',
      version: '0.0.1 /Users/alice/secret',
      headers: { authorization: 'Bearer CANARY_AUTH_7f3', cookie: 'c=CANARY_COOKIE' },
    });
    await client.callTool({
      name: 'echo',
      arguments: { message: 'hello CANARY_MSG', rationale: 'CANARY_RAT' },
      _meta: { traceparent: '00-CANARY_TRACE-0000000000000000000000-01', custom: 'CANARY_META' },
    } as Parameters<V2Client['callTool']>[0]);
    await running.flush();
    await waitFor(dir, (f) => (f.get('ingestion.ndjson') ?? []).length > 0);
    await running.close();
    for (const file of await readdir(dir)) {
      const content = await readFile(join(dir, file), 'utf8');
      expect(content, file).not.toContain('CANARY');
      expect(content, file).not.toContain('alice');
    }
  });

  it('delivers sink-only even when AMPLITUDE_API_KEY is set (v2)', { timeout: TIMEOUT }, async () => {
    process.env.AMPLITUDE_API_KEY = 'x';
    try {
      const { running, dir } = await startV2('t-v2-apikey');
      expect(process.env.AMPLITUDE_API_KEY).toBeUndefined();
      const { client } = await connectV2Http(running.url, { pin: '2026-07-28' });
      await client.callTool({ name: 'echo', arguments: { message: BASELINE } });
      await running.flush();
      await waitFor(dir, (f) => (f.get('ingestion.ndjson') ?? []).length > 0);
    } finally {
      delete process.env.AMPLITUDE_API_KEY;
    }
  });
});

describe('v2 capture — v2-stdio', () => {
  async function spawnStdio(
    line: 'v1' | 'v2',
    trial: string,
    pin?: string,
  ): Promise<{ dir: string; stderr: string[] }> {
    const dir = await mkdtemp(join(tmpdir(), `mcp-capture-v2stdio-${line}-`));
    const stderr: string[] = [];
    // Compat register hook transpiles the .ts entry — Node 20 has no
    // --experimental-strip-types (same mechanism as test/compat/stdio.ts).
    const parameters = {
      command: process.execPath,
      args: [
        '--disable-warning=ExperimentalWarning',
        '--import',
        join(REPO_ROOT, 'test/compat/stdio-register.mjs'),
        join(REPO_ROOT, 'examples/playground/capture/v2-stdio.ts'),
        '--trial',
        trial,
        '--out',
        dir,
      ],
      cwd: REPO_ROOT,
      stderr: 'pipe' as const,
    };
    if (line === 'v2') {
      const client = new V2Client(CLIENT_INFO, pin ? { versionNegotiation: { mode: { pin } } } : {});
      const transport = new V2Stdio(parameters);
      transport.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')));
      await client.connect(transport);
      cleanup.push(() => client.close());
      const result = await client.callTool({ name: 'echo', arguments: { message: `baseline-${trial}-call-1` } });
      expect(result).toMatchObject({ content: [{ type: 'text', text: `baseline-${trial}-call-1` }] });
      await client.close();
    } else {
      const client = new V1Client(CLIENT_INFO);
      const transport = new V1Stdio(parameters);
      await client.connect(transport);
      cleanup.push(() => client.close());
      await client.callTool({ name: 'echo', arguments: { message: `baseline-${trial}-call-1` } });
      await client.close();
    }
    return { dir, stderr };
  }

  it('joins a 2026-07-28-pinned stdio client', { timeout: TIMEOUT }, async () => {
    const { dir } = await spawnStdio('v2', 't-v2stdio-modern', '2026-07-28');
    const files = await waitFor(dir, (f) =>
      (f.get('ingestion.ndjson') ?? []).some((b) =>
        ((b.events as Nd[] | undefined) ?? []).some((e) => e.event_type === '[MCP] Tool Call Response'),
      ),
    );
    const call = messages(files, 'tools/call').find((m) => (m.params as Nd)?.name === 'echo');
    const meta = (call?.params as Nd)?._meta as Nd | undefined;
    console.log(`[v2-capture] v2-stdio tools/call _meta: ${JSON.stringify(meta)}`);
    const toolEvent = (files.get('events.ndjson') ?? []).find(
      (e) => (e.event as Nd)?.event_type === '[MCP] Tool Call Response',
    );
    expect(toolEvent?.rpcId).toBe(call?.id);
    expect(toolEvent?.connection).toMatch(/^p[0-9a-f]{6}-proc$/);
    const props = ((toolEvent?.event as Nd)?.event_properties ?? {}) as Nd;
    console.log(`[v2-capture] v2-stdio Client Name = ${JSON.stringify(props['[MCP] Client Name'])}, Protocol Version = ${JSON.stringify(props['[MCP] Protocol Version'])}`);
  });

  it('joins a legacy v1 stdio client', { timeout: TIMEOUT }, async () => {
    const { dir } = await spawnStdio('v1', 't-v2stdio-legacy');
    const files = await waitFor(dir, (f) =>
      (f.get('events.ndjson') ?? []).some((e) => (e.event as Nd)?.event_type === '[MCP] Tool Call Response'),
    );
    const init = messages(files, 'initialize')[0];
    expect((init?.params as Nd)?.clientInfo).toMatchObject(CLIENT_INFO);
    const toolEvent = (files.get('events.ndjson') ?? []).find(
      (e) => (e.event as Nd)?.event_type === '[MCP] Tool Call Response',
    );
    const props = ((toolEvent?.event as Nd)?.event_properties ?? {}) as Nd;
    console.log(`[v2-capture] v2-stdio legacy Client Name = ${JSON.stringify(props['[MCP] Client Name'])}`);
    expect(toolEvent?.rpcId).toBeDefined();
  });

  it('keeps canaries out of files and stderr (v2-stdio)', { timeout: TIMEOUT }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-capture-v2stdio-canary-'));
    const stderr: string[] = [];
    const client = new V2Client({ name: 'capture-harness-synthetic', version: '0.0.1 /Users/alice/secret' });
    const transport = new V2Stdio({
      command: process.execPath,
      args: [
        '--disable-warning=ExperimentalWarning',
        '--import',
        join(REPO_ROOT, 'test/compat/stdio-register.mjs'),
        join(REPO_ROOT, 'examples/playground/capture/v2-stdio.ts'),
        '--trial',
        't-v2stdio-canary',
        '--out',
        dir,
      ],
      cwd: REPO_ROOT,
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')));
    await client.connect(transport);
    cleanup.push(() => client.close());
    await client.callTool({
      name: 'echo',
      arguments: { message: 'hello CANARY_MSG', rationale: 'CANARY_RAT' },
      _meta: { custom: 'CANARY_META' },
    } as Parameters<V2Client['callTool']>[0]);
    await client.close();
    await waitFor(dir, (f) => (f.get('ingestion.ndjson') ?? []).length > 0);
    for (const file of await readdir(dir)) {
      const content = await readFile(join(dir, file), 'utf8');
      expect(content, file).not.toContain('CANARY');
      expect(content, file).not.toContain('alice');
    }
    expect(stderr.join('')).not.toContain('CANARY');
    expect(stderr.join('')).not.toContain('alice');
  });
});
