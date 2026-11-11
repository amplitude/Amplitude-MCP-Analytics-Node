/**
 * Pack this package and install it into three throwaway projects with strict
 * peer dependencies: v1 only, v2 only, and both. Each project typechecks a
 * consumer that calls instrumentServer, instrumentTool, and
 * registerFeedbackTool, then runs an in-memory round-trip.
 *
 * Run with `pnpm test:consumer`.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const TARBALL_DIR = await mkdtemp(join(tmpdir(), 'mcp-analytics-pack-'));

function run(command, args, options) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status ?? 'signal'})`);
  }
}

function capture(command, args, options) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? '');
    throw new Error(`${command} ${args.join(' ')} failed (${result.status ?? 'signal'})`);
  }
  return result.stdout;
}

const installEnv = { ...process.env };
delete installEnv.CI;
delete installEnv.npm_config_frozen_lockfile;

function roundTrip(prefix, serverName, clientName, memoryName) {
  return `
async function roundTrip${prefix}() {
  const events: Array<{ event_type: string }> = [];
  const analytics = createMcpAnalytics({
    amplitude: { track: (event) => events.push(event), flush: () => undefined },
    serverName: 'consumer',
    serverVersion: '1.0.0',
  });
  const server = new ${serverName}({ name: 'consumer', version: '1.0.0' });
  analytics.instrumentServer(server);
  server.registerTool(
    'ping',
    { description: 'ping' },
    analytics.instrumentTool(async () => ({ content: [{ type: 'text' as const, text: 'pong' }] }), { name: 'ping' }),
  );
  analytics.registerFeedbackTool(server);
  const [clientTransport, serverTransport] = ${memoryName}.createLinkedPair();
  const client = new ${clientName}({ name: 'consumer-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  await client.callTool({ name: 'ping', arguments: {} });
  if (!events.some((event) => event.event_type === '[MCP] Tool Call Response')) {
    throw new Error('${prefix} consumer recorded no [MCP] Tool Call Response');
  }
  await client.close();
  await server.close();
}
`;
}

const V1_IMPORTS = `import { createMcpAnalytics } from '@amplitude/mcp-analytics';
import { Client as V1Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport as V1Memory } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer as V1Server } from '@modelcontextprotocol/sdk/server/mcp.js';
`;
const V2_IMPORTS = `import { createMcpAnalytics } from '@amplitude/mcp-analytics';
import { Client as V2Client } from '@modelcontextprotocol/client';
import { InMemoryTransport as V2Memory, McpServer as V2Server } from '@modelcontextprotocol/server';
`;
const BOTH_IMPORTS = `import { createMcpAnalytics } from '@amplitude/mcp-analytics';
import { Client as V2Client } from '@modelcontextprotocol/client';
import { InMemoryTransport as V2Memory, McpServer as V2Server } from '@modelcontextprotocol/server';
import { Client as V1Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport as V1Memory } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer as V1Server } from '@modelcontextprotocol/sdk/server/mcp.js';
`;

const V1_SOURCE = `${V1_IMPORTS}${roundTrip('V1', 'V1Server', 'V1Client', 'V1Memory')}\nawait roundTripV1();\n`;
const V2_SOURCE = `${V2_IMPORTS}${roundTrip('V2', 'V2Server', 'V2Client', 'V2Memory')}\nawait roundTripV2();\n`;
const BOTH_SOURCE = `${BOTH_IMPORTS}${roundTrip('V1', 'V1Server', 'V1Client', 'V1Memory')}${roundTrip('V2', 'V2Server', 'V2Client', 'V2Memory')}\nawait roundTripV1();\nawait roundTripV2();\n`;


const TSCONFIG = {
  compilerOptions: {
    target: 'ES2022',
    module: 'nodenext',
    moduleResolution: 'nodenext',
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  },
  files: ['consumer.ts'],
};

function packageJson(name, dependencies) {
  return {
    name,
    private: true,
    type: 'module',
    dependencies,
    devDependencies: { typescript: '5.9.3' },
  };
}

const fixtures = (tarball) => [
  {
    name: 'v1-only',
    source: V1_SOURCE,
    dependencies: {
      '@amplitude/mcp-analytics': `file:${tarball}`,
      '@amplitude/analytics-node': '1.3.5',
      '@modelcontextprotocol/sdk': '1.31.0',
      zod: '3.25.76',
    },
  },
  {
    name: 'v2-only',
    source: V2_SOURCE,
    dependencies: {
      '@amplitude/mcp-analytics': `file:${tarball}`,
      '@amplitude/analytics-node': '1.3.5',
      '@modelcontextprotocol/server': '2.4.0',
      '@modelcontextprotocol/client': '2.4.0',
      zod: '4.2.0',
    },
  },
  {
    name: 'both',
    source: BOTH_SOURCE,
    dependencies: {
      '@amplitude/mcp-analytics': `file:${tarball}`,
      '@amplitude/analytics-node': '1.3.5',
      '@modelcontextprotocol/sdk': '1.31.0',
      '@modelcontextprotocol/server': '2.4.0',
      '@modelcontextprotocol/client': '2.4.0',
      zod: '3.25.76',
    },
  },
];

try {
  run('pnpm', ['build'], { cwd: ROOT });
  const packed = capture('pnpm', ['pack', '--pack-destination', TARBALL_DIR], { cwd: ROOT }).trim();
  const filename = packed.split('\n').at(-1);
  if (filename == null || filename.length === 0) throw new Error('pnpm pack produced no tarball');
  const tarball = filename.startsWith('/') ? filename : join(TARBALL_DIR, filename);

  for (const fixture of fixtures(tarball)) {
    const dir = await mkdtemp(join(tmpdir(), `mcp-consumer-${fixture.name}-`));
    try {
      await writeFile(join(dir, 'package.json'), JSON.stringify(packageJson(fixture.name, fixture.dependencies), null, 2));
      await writeFile(join(dir, '.npmrc'), 'strict-peer-dependencies=true\n');
      await writeFile(join(dir, 'tsconfig.json'), JSON.stringify(TSCONFIG, null, 2));
      await writeFile(join(dir, 'consumer.ts'), fixture.source);
      console.log(`\n--- ${fixture.name}: install ---`);
      run('pnpm', ['install', '--ignore-workspace', '--no-frozen-lockfile'], { cwd: dir, env: installEnv });
      console.log(`--- ${fixture.name}: typecheck ---`);
      run('pnpm', ['exec', 'tsc', '-p', 'tsconfig.json'], { cwd: dir, env: installEnv });
      console.log(`--- ${fixture.name}: round-trip ---`);
      run('node', ['--experimental-strip-types', 'consumer.ts'], { cwd: dir, env: installEnv });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
} finally {
  await rm(TARBALL_DIR, { recursive: true, force: true });
}
