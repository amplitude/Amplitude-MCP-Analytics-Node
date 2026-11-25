import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { arch, platform, release } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

export interface GroundTruth {
  clientProduct: string | null;
  clientSurface: string | null;
  clientVersion: string | null;
  topology: string | null;
}

/**
 * Write `manifest.json` on the first run in a trial dir. Existing manifests
 * are left untouched so a second process (e.g. a respawned stdio client) does
 * not overwrite the original ground truth.
 */
export async function writeManifestOnce(
  outDir: string,
  record: { trial: string; mode: string; serverLine: 'v1' | 'v2'; groundTruth: GroundTruth },
): Promise<void> {
  const path = join(outDir, 'manifest.json');
  if (existsSync(path)) return;
  const manifest = {
    trial: record.trial,
    mode: record.mode,
    serverLine: record.serverLine,
    package: { name: '@amplitude/mcp-analytics', version: packageVersion(join(REPO_ROOT, 'package.json')) },
    harness: {
      gitHead: git(['rev-parse', 'HEAD']),
      gitDirty: git(['status', '--porcelain']).length > 0,
      sdkUnderTestSha256: await hashTree(join(REPO_ROOT, 'src')),
    },
    dependencies: {
      '@modelcontextprotocol/sdk': packageVersion(
        join(REPO_ROOT, 'node_modules/@modelcontextprotocol/sdk/package.json'),
      ),
      '@amplitude/analytics-node': packageVersion(
        join(REPO_ROOT, 'node_modules/@amplitude/analytics-node/package.json'),
      ),
      '@modelcontextprotocol/server': packageVersion(
        join(REPO_ROOT, 'node_modules/@modelcontextprotocol/server/package.json'),
      ),
      '@modelcontextprotocol/client': packageVersion(
        join(REPO_ROOT, 'node_modules/@modelcontextprotocol/client/package.json'),
      ),
    },
    runtime: { node: process.version, platform: platform(), release: release(), arch: arch() },
    startedAt: new Date().toISOString(),
    groundTruth: record.groundTruth,
  };
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/** sha256 over the whole `src/` tree so the SDK under test is identifiable. */
async function hashTree(dir: string): Promise<string> {
  const hash = createHash('sha256');
  const walk = async (current: string): Promise<void> => {
    const entries = (await readdir(current)).sort();
    for (const entry of entries) {
      const path = join(current, entry);
      const info = await stat(path);
      if (info.isDirectory()) {
        await walk(path);
      } else {
        hash.update(path.slice(dir.length));
        hash.update(await readFile(path));
      }
    }
  };
  await walk(dir);
  return hash.digest('hex');
}

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}

function packageVersion(path: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed != null && typeof parsed === 'object' && 'version' in parsed && typeof parsed.version === 'string') {
      return parsed.version;
    }
  } catch {
    // fall through
  }
  return null;
}
