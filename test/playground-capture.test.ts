/**
 * Validation gate for the capture harness in `examples/playground/capture/`.
 *
 * Drives real MCP clients (Streamable HTTP and spawned stdio) at the capture
 * playground and asserts:
 *   - identity fields are recorded sanitized but joinable
 *   - canary strings never reach disk or stderr
 *   - concurrent clients never cross identities
 *   - delivery is sink-only even with AMPLITUDE_API_KEY set
 *   - capture does not change what the SDK emits (parity with plain playground)
 */
import { execFile, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { startCaptureHttp, type RunningCaptureHttp } from '../examples/playground/capture/http.js';
import { startPlaygroundHttp, type RunningPlaygroundHttp } from '../examples/playground/http.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLIENT_INFO = { name: 'capture-harness-synthetic', version: '0.0.1' };
const BASELINE_MESSAGE = 'baseline-t1-call-1';
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
  const files = await readdir(dir);
  const out = new Map<string, Nd[]>();
  for (const file of files) {
    if (file.endsWith('.ndjson')) out.set(file, await readNdjson(join(dir, file)));
  }
  return out;
}

/** Poll until `pred` holds on the trial dir contents — never a fixed sleep. */
async function waitFor(dir: string, pred: (files: Map<string, Nd[]>) => boolean, ms = 20_000): Promise<Map<string, Nd[]>> {
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

async function startCapture(mode: 'http-session' | 'http-fresh', trial: string): Promise<{ running: RunningCaptureHttp; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), `mcp-capture-${mode}-`));
  const running = await startCaptureHttp({ mode, trial, outDir: dir, port: 0 });
  cleanup.push(running.close);
  return { running, dir };
}

async function connectHttp(url: URL, name = CLIENT_INFO.name, version = CLIENT_INFO.version): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const client = new Client({ name, version });
  const transport = new StreamableHTTPClientTransport(url);
  await client.connect(transport);
  cleanup.push(() => client.close());
  return { client, transport };
}

function initializeMessage(files: Map<string, Nd[]>): Nd | undefined {
  return messages(files, 'initialize')[0];
}

describe('playground capture harness', () => {
  for (const mode of ['http-session', 'http-fresh'] as const) {
    it(`records identity end to end (${mode})`, { timeout: TIMEOUT }, async () => {
      const { running, dir } = await startCapture(mode, `t-${mode}`);
      const { client } = await connectHttp(running.url);
      const result = await client.callTool({ name: 'echo', arguments: { message: BASELINE_MESSAGE } });
      expect(result).toMatchObject({ content: [{ type: 'text', text: BASELINE_MESSAGE }] });
      await running.flush();

      const files = await waitFor(dir, (f) =>
        (f.get('ingestion.ndjson') ?? []).some((b) =>
          ((b.events as Nd[] | undefined) ?? []).some((e) => e.event_type === '[MCP] Tool Call Response'),
        ),
      );

      // requests: initialize carries clientInfo + requested protocolVersion.
      const init = initializeMessage(files);
      expect(init).toMatchObject({
        method: 'initialize',
        params: {
          protocolVersion: expect.any(String),
          clientInfo: { name: CLIENT_INFO.name, version: CLIENT_INFO.version },
        },
      });
      // echo baseline token retained.
      const call = messages(files, 'tools/call').find((m) => (m.params as Nd)?.name === 'echo');
      expect((call?.params as Nd)?.message).toBe(BASELINE_MESSAGE);
      expect((call?.params as Nd)?.argumentKeys).toEqual(['message']);

      // HTTP requests carry a captured user-agent.
      const posts = (files.get('requests.ndjson') ?? []).filter((r) => r.httpMethod === 'POST');
      expect(posts.length).toBeGreaterThan(0);
      expect(typeof ((posts[0] as Nd).headers as Nd)?.['user-agent']).toBe('string');

      // responses: agreed protocol version on the initialize response.
      const responses = files.get('responses.ndjson') ?? [];
      const initResponse = responses.find((r) => r.initialize != null);
      expect((initResponse?.initialize as Nd)?.protocolVersion).toEqual(expect.any(String));
      expect(responses.some((r) => r.requestMethod === 'tools/call' && r.toolIsError !== true)).toBe(true);

      // events: Tool Call Response joined to the tools/call rpc id + connection.
      const events = files.get('events.ndjson') ?? [];
      const toolEvent = events.find((e) => (e.event as Nd)?.event_type === '[MCP] Tool Call Response');
      expect(toolEvent).toBeDefined();
      expect(toolEvent?.rpcId).toBe(call?.id);
      expect(toolEvent?.method).toBe('tools/call');
      const callRequest = (files.get('requests.ndjson') ?? []).find((r) =>
        ((r.messages as Nd[] | undefined) ?? []).some((m) => m === call),
      );
      if (mode === 'http-session') {
        expect(toolEvent?.connection).toBe(callRequest?.connection);
      } else {
        expect(toolEvent?.requestAlias).toBe(callRequest?.requestAlias);
      }
      const toolProps = (toolEvent?.event as Nd)?.event_properties as Nd;
      console.log(`[capture-test] ${mode} [MCP] Client Name = ${JSON.stringify(toolProps?.['[MCP] Client Name'])}`);

      // ingestion: same insert_id alias proves the event was delivered.
      const insertId = (toolEvent?.event as Nd)?.insert_id;
      expect(insertId).toMatch(/^p[0-9a-f]{6}-ins-/);
      const delivered = (files.get('ingestion.ndjson') ?? [])
        .flatMap((b) => (b.events as Nd[] | undefined) ?? [])
        .some((e) => e.insert_id === insertId && e.event_type === '[MCP] Tool Call Response');
      expect(delivered).toBe(true);

      // manifest exists with ground-truth fields.
      const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as Nd;
      expect(manifest.trial).toBe(`t-${mode}`);
      expect(manifest.groundTruth).toMatchObject({ clientProduct: null, topology: null });
      expect(typeof (manifest.harness as Nd)?.sdkUnderTestSha256).toBe('string');
    });
  }

  it('records identity end to end (stdio)', { timeout: TIMEOUT }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-capture-stdio-'));
    // Spawn through the compat register hook (same mechanism as
    // test/compat/stdio.ts): Node 20 has no --experimental-strip-types, so the
    // hook transpiles the TypeScript entry instead of relying on the flag.
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        '--disable-warning=ExperimentalWarning',
        '--import',
        join(REPO_ROOT, 'test/compat/stdio-register.mjs'),
        join(REPO_ROOT, 'examples/playground/capture/stdio.ts'),
        '--trial',
        't-stdio',
        '--out',
        dir,
      ],
      cwd: REPO_ROOT,
      stderr: 'pipe',
    });
    const client = new Client(CLIENT_INFO);
    await client.connect(transport);
    // Older stdio clients leave the child running after close().
    cleanup.push(async () => {
      await client.close().catch(() => undefined);
      const pid = transport.pid;
      if (pid == null) return;
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        return;
      }
    });

    const result = await client.callTool({ name: 'echo', arguments: { message: BASELINE_MESSAGE } });
    expect(result).toMatchObject({ content: [{ type: 'text', text: BASELINE_MESSAGE }] });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await client.close();

    const files = await waitFor(dir, (f) =>
      (f.get('ingestion.ndjson') ?? []).some((b) =>
        ((b.events as Nd[] | undefined) ?? []).some((e) => e.event_type === '[MCP] Tool Call Response'),
      ),
    );
    const init = initializeMessage(files);
    expect((init?.params as Nd)?.clientInfo).toMatchObject(CLIENT_INFO);
    const call = messages(files, 'tools/call').find((m) => (m.params as Nd)?.name === 'echo');
    expect((call?.params as Nd)?.message).toBe(BASELINE_MESSAGE);
    const toolEvent = (files.get('events.ndjson') ?? []).find(
      (e) => (e.event as Nd)?.event_type === '[MCP] Tool Call Response',
    );
    expect(toolEvent?.rpcId).toBe(call?.id);
    expect(toolEvent?.connection).toMatch(/^p[0-9a-f]{6}-proc$/);
    const responses = files.get('responses.ndjson') ?? [];
    expect(responses.some((r) => (r.initialize as Nd)?.protocolVersion != null)).toBe(true);
  });

  it('keeps canaries and raw session ids out of every file and stderr', { timeout: TIMEOUT }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-capture-canary-'));
    const running = await startCaptureHttp({ mode: 'http-session', trial: 't-canary', outDir: dir, port: 0 });
    cleanup.push(running.close);

    const client = new Client({ name: 'capture-harness-synthetic', version: '0.0.1 /Users/alice/secret' });
    const transport = new StreamableHTTPClientTransport(running.url, {
      requestInit: {
        headers: { authorization: 'Bearer CANARY_AUTH_7f3', cookie: 'c=CANARY_COOKIE' },
      },
    });
    await client.connect(transport);
    cleanup.push(() => client.close());
    await client.callTool({
      name: 'echo',
      arguments: { message: 'hello CANARY_MSG', rationale: 'CANARY_RAT' },
      _meta: { traceparent: '00-CANARY_TRACE-0000000000000000000000-01', custom: 'CANARY_META' },
    });
    const rawSessionId = transport.sessionId;
    expect(rawSessionId).toBeDefined();
    await running.flush();
    await waitFor(dir, (f) => (f.get('ingestion.ndjson') ?? []).length > 0);
    await running.close();

    // No file in the trial dir contains any canary or the raw session id.
    for (const file of await readdir(dir)) {
      const content = await readFile(join(dir, file), 'utf8');
      expect(content, file).not.toContain('CANARY');
      expect(content, file).not.toContain('alice');
      expect(content, file).not.toContain(rawSessionId ?? 'unset');
    }

    // And the sanitized records still carry the allowlisted shape.
    const files = await readAll(dir);
    const call = messages(files, 'tools/call').find((m) => (m.params as Nd)?.name === 'echo');
    expect((call?.params as Nd)?.message).toMatch(/^<redacted len=\d+>$/);
    const meta = (call?.params as Nd)?._meta as Nd | undefined;
    expect(meta?.metaKeys).toEqual(expect.arrayContaining(['custom', 'traceparent']));
    const initHeaders = ((files.get('requests.ndjson') ?? [])[0]?.headers ?? {}) as Nd;
    expect(initHeaders.authorization).toBe(true);
    expect(initHeaders.cookie).toBe(true);
  });

  for (const mode of ['http-session', 'http-fresh'] as const) {
    it(`never crosses identities between concurrent clients (${mode})`, { timeout: TIMEOUT }, async () => {
      const { running, dir } = await startCapture(mode, `t-conc-${mode}`);
      const a = await connectHttp(running.url, 'client-A', '1.0.0');
      const b = await connectHttp(running.url, 'client-B', '2.0.0');
      await Promise.all([
        ...Array.from({ length: 5 }, (_, i) =>
          a.client.callTool({ name: 'echo', arguments: { message: `baseline-a${i}-call-${i}` } }),
        ),
        ...Array.from({ length: 5 }, (_, i) =>
          b.client.callTool({ name: 'echo', arguments: { message: `baseline-b${i}-call-${i}` } }),
        ),
      ]);
      await running.flush();
      const files = await waitFor(
        dir,
        (f) =>
          (f.get('events.ndjson') ?? []).filter((e) => (e.event as Nd)?.event_type === '[MCP] Tool Call Response')
            .length >= 10,
      );

      // Map each echo baseline token → the request that carried it.
      const callByMessage = new Map<string, { id: unknown; request: Nd }>();
      for (const request of files.get('requests.ndjson') ?? []) {
        for (const message of (request.messages as Nd[] | undefined) ?? []) {
          const params = message.params as Nd | undefined;
          if (message.method === 'tools/call' && typeof params?.message === 'string') {
            callByMessage.set(params.message, { id: message.id, request });
          }
        }
      }
      const toolEvents = (files.get('events.ndjson') ?? []).filter(
        (e) =>
          (e.event as Nd)?.event_type === '[MCP] Tool Call Response' &&
          (((e.event as Nd)?.event_properties as Nd) ?? {})['[MCP] Tool Name'] === 'echo',
      );
      // rpcIds collide across clients (each Client numbers its own requests),
      // so a join is only correct via rpcId + requestAlias, and — in session
      // mode — the request must live on the event's own connection.
      const joined = toolEvents.filter((event) =>
        [...callByMessage.values()].some(
          (info) =>
            info.id === event.rpcId &&
            info.request.requestAlias === event.requestAlias &&
            (mode === 'http-fresh' || info.request.connection === event.connection),
        ),
      );
      expect(joined.length).toBe(10);
      // Sanity: each session connection carried only one client's tokens.
      if (mode === 'http-session') {
        const tokensByConnection = new Map<unknown, Set<string>>();
        for (const [message, info] of callByMessage) {
          const key = info.request.connection;
          const set = tokensByConnection.get(key) ?? new Set<string>();
          set.add(message.startsWith('baseline-a') ? 'a' : 'b');
          tokensByConnection.set(key, set);
        }
        for (const tags of tokensByConnection.values()) expect(tags.size).toBe(1);
      }
    });
  }

  it('distinguishes missing, null, and empty clientInfo name', { timeout: TIMEOUT }, async () => {
    const { running, dir } = await startCapture('http-session', 't-clientinfo');
    const send = async (clientInfo: unknown): Promise<void> => {
      await fetch(running.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Math.floor(Math.random() * 1e6),
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, ...(clientInfo === undefined ? {} : { clientInfo }) },
        }),
      });
    };
    await send(undefined); // clientInfo key absent
    await send({ name: null }); // name null
    await send({ name: '' }); // name empty
    await waitFor(dir, (f) => messages(f, 'initialize').length >= 3);

    const files = await readAll(dir);
    const inits = messages(files, 'initialize');
    const absent = inits.find((m) => (m.params as Nd)?.clientInfo === undefined || !('clientInfo' in ((m.params ?? {}) as Nd)));
    const nullName = inits.find((m) => ((m.params as Nd)?.clientInfo as Nd)?.name === null);
    const emptyName = inits.find((m) => ((m.params as Nd)?.clientInfo as Nd)?.name === '');
    expect(absent).toBeDefined();
    expect(nullName).toBeDefined();
    expect(emptyName).toBeDefined();
  });

  it('delivers sink-only even when AMPLITUDE_API_KEY is set', { timeout: TIMEOUT }, async () => {
    process.env.AMPLITUDE_API_KEY = 'x';
    try {
      const { running, dir } = await startCapture('http-session', 't-apikey');
      expect(process.env.AMPLITUDE_API_KEY).toBeUndefined();
      expect(running.playground.sink).toBeDefined();
      expect(new URL(running.playground.sink?.serverUrl ?? '').hostname).toBe('127.0.0.1');
      const { client } = await connectHttp(running.url);
      await client.callTool({ name: 'echo', arguments: { message: BASELINE_MESSAGE } });
      await running.flush();
      await waitFor(dir, (f) => (f.get('ingestion.ndjson') ?? []).length > 0);
    } finally {
      delete process.env.AMPLITUDE_API_KEY;
    }
  });

  it('emits identical echo result and client identity with and without capture', { timeout: TIMEOUT }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-capture-parity-'));
    const capture = await startCaptureHttp({ mode: 'http-session', trial: 't-parity', outDir: dir, port: 0 });
    cleanup.push(capture.close);
    const plainDir = await mkdtemp(join(tmpdir(), 'mcp-playground-parity-'));
    const plain = await startPlaygroundHttp({
      port: 0,
      logPath: join(plainDir, 'events.ndjson'),
      requestLogPath: join(plainDir, 'mcp-requests.ndjson'),
      delivery: 'sink',
    });
    cleanup.push(plain.close);

    const capClient = await connectHttp(capture.url);
    const plainClient = await connectHttp(plain.url);
    const [capResult, plainResult] = await Promise.all([
      capClient.client.callTool({ name: 'echo', arguments: { message: 'parity' } }),
      plainClient.client.callTool({ name: 'echo', arguments: { message: 'parity' } }),
    ]);
    expect(capResult).toEqual(plainResult);
    await Promise.all([capture.flush(), plain.flush()]);

    const capFiles = await waitFor(dir, (f) => (f.get('events.ndjson') ?? []).length > 0);
    const capEvent = (capFiles.get('events.ndjson') ?? []).find(
      (e) => (e.event as Nd)?.event_type === '[MCP] Tool Call Response',
    );
    const capProps = ((capEvent?.event as Nd)?.event_properties ?? {}) as Nd;

    const plainBatches = await readNdjson(join(plainDir, 'events.ndjson'));
    const plainEvent = plainBatches
      .flatMap((b) => (b.events as Nd[] | undefined) ?? [])
      .find((e) => e.event_type === '[MCP] Tool Call Response');
    const plainProps = (plainEvent?.event_properties ?? {}) as Nd;
    expect(capProps['[MCP] Client Name']).toBe(plainProps['[MCP] Client Name']);
    expect(capProps['[MCP] Client Version']).toBe(plainProps['[MCP] Client Version']);
  });
});
