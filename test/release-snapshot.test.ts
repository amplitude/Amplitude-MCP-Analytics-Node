import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = join(
  import.meta.dirname,
  '../.github/scripts/resolve-release-snapshot.sh',
);

const gitEnv = { ...process.env };
delete gitEnv.GIT_DIR;
delete gitEnv.GIT_WORK_TREE;
gitEnv.GIT_CONFIG_COUNT = '1';
gitEnv.GIT_CONFIG_KEY_0 = 'core.hooksPath';
gitEnv.GIT_CONFIG_VALUE_0 = '/dev/null';
gitEnv.GIT_TERMINAL_PROMPT = '0';

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: gitEnv,
  }).trim();
}

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'release-snapshot-'));
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  return repo;
}

function commit(repo: string, message: string, files: Record<string, string>): string {
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(repo, name), contents);
    git(repo, ['add', name]);
  }
  git(repo, ['commit', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}

function resolve(repo: string, releaseHead: string, mergeSha: string): string {
  return execFileSync('bash', [script, releaseHead, mergeSha], {
    cwd: repo,
    encoding: 'utf8',
    env: gitEnv,
  }).trim();
}

const test = (name: string, fn: () => void): void => {
  it(name, fn, 30_000);
};

const checkScript = join(import.meta.dirname, '../.github/scripts/check-release-pr.sh');

function check(repo: string, base: string, body: string): void {
  const bodyFile = join(repo, 'pr-body.md');
  writeFileSync(bodyFile, body);
  execFileSync('bash', [checkScript, base, bodyFile], {
    cwd: repo,
    encoding: 'utf8',
    env: gitEnv,
  });
}

describe.sequential('release snapshot', () => {
  test('tags a squash that landed on the same base', () => {
    const repo = initRepo();
    const base = commit(repo, 'feat: feature 1', { 'feature.txt': 'one\n' });
    const releaseHead = commit(repo, 'chore(main): release 0.6.0', {
      'package.json': '{"version":"0.6.0"}\n',
      'CHANGELOG.md': '# 0.6.0\n',
      '.release-please-manifest.json': '{}\n',
    });
    git(repo, ['reset', '--soft', base]);
    git(repo, ['commit', '-m', 'chore(main): release 0.6.0']);
    const squash = git(repo, ['rev-parse', 'HEAD']);

    expect(resolve(repo, releaseHead, squash)).toBe(squash);
  });

  test('refuses a merge commit, including one made after a later commit', () => {
    const repo = initRepo();
    commit(repo, 'feat: feature 1', { 'feature.txt': 'one\n' });
    const releaseHead = commit(repo, 'chore(main): release 0.6.0', {
      'package.json': '{"version":"0.6.0"}\n',
      'CHANGELOG.md': '# 0.6.0\n',
      '.release-please-manifest.json': '{}\n',
    });
    git(repo, ['branch', 'release', 'HEAD']);
    git(repo, ['reset', '--hard', 'HEAD~1']);
    commit(repo, 'feat: feature 2', { 'feature.txt': 'two\n' });
    git(repo, ['merge', '--no-ff', 'release', '-m', 'merge release']);
    const mergeSha = git(repo, ['rev-parse', 'HEAD']);

    expect(() => resolve(repo, releaseHead, mergeSha)).toThrow(/squash includes commits/);
  });

  test('refuses a squash that includes a later commit', () => {
    const repo = initRepo();
    commit(repo, 'feat: feature 1', { 'feature.txt': 'one\n' });
    const releaseHead = commit(repo, 'chore(main): release 0.6.0', {
      'package.json': '{"version":"0.6.0"}\n',
      'CHANGELOG.md': '# 0.6.0\n',
      '.release-please-manifest.json': '{}\n',
    });
    git(repo, ['reset', '--hard', 'HEAD~1']);
    commit(repo, 'feat: feature 2', { 'feature.txt': 'two\n' });
    writeFileSync(join(repo, 'package.json'), '{"version":"0.6.0"}\n');
    writeFileSync(join(repo, 'CHANGELOG.md'), '# 0.6.0\n');
    writeFileSync(join(repo, '.release-please-manifest.json'), '{}\n');
    git(repo, ['add', 'package.json', 'CHANGELOG.md', '.release-please-manifest.json']);
    git(repo, ['commit', '-m', 'chore(main): release 0.6.0']);
    const squash = git(repo, ['rev-parse', 'HEAD']);

    expect(() => resolve(repo, releaseHead, squash)).toThrow(/squash includes commits/);
  });

  test('refuses a release branch that merged main back in', () => {
    const repo = initRepo();
    commit(repo, 'feat: feature 1', { 'feature.txt': 'one\n' });
    commit(repo, 'chore(main): release 0.6.0', {
      'package.json': '{"version":"0.6.0"}\n',
      'CHANGELOG.md': '# 0.6.0\n',
      '.release-please-manifest.json': '{}\n',
    });
    git(repo, ['branch', 'release', 'HEAD']);
    git(repo, ['reset', '--hard', 'HEAD~1']);
    commit(repo, 'feat: feature 2', { 'feature.txt': 'two\n' });
    git(repo, ['checkout', 'release']);
    git(repo, ['merge', '--no-ff', 'main', '-m', 'update branch']);
    const dirtyHead = git(repo, ['rev-parse', 'HEAD']);

    expect(() => resolve(repo, dirtyHead, dirtyHead)).toThrow(/parents/);
  });

  test('passes when the release commit parent is current main and the marker matches', () => {
    const repo = initRepo();
    const base = commit(repo, 'feat: feature 1', { 'feature.txt': 'one\n' });
    commit(repo, 'chore(main): release 0.6.0', {
      'package.json': '{"version":"0.6.0"}\n',
      'CHANGELOG.md': '# 0.6.0\n',
      '.release-please-manifest.json': '{}\n',
    });
    check(repo, base, `notes\n<!-- release-base: ${base} -->\n`);
  });

  test('fails when Update branch merged main in', () => {
    const repo = initRepo();
    commit(repo, 'feat: feature 1', { 'feature.txt': 'one\n' });
    commit(repo, 'chore(main): release 0.6.0', {
      'package.json': '{"version":"0.6.0"}\n',
      'CHANGELOG.md': '# 0.6.0\n',
      '.release-please-manifest.json': '{}\n',
    });
    git(repo, ['branch', 'release', 'HEAD']);
    git(repo, ['reset', '--hard', 'HEAD~1']);
    const latest = commit(repo, 'feat: feature 2', { 'feature.txt': 'two\n' });
    git(repo, ['checkout', 'release']);
    git(repo, ['merge', '--no-ff', 'main', '-m', 'update branch']);

    expect(() => check(repo, latest, `<!-- release-base: ${latest} -->`)).toThrow(/Update branch/);
  });

  test('fails when the commit was replayed onto a newer main', () => {
    const repo = initRepo();
    const oldBase = commit(repo, 'feat: feature 1', { 'feature.txt': 'one\n' });
    const latest = commit(repo, 'feat: feature 2', { 'feature.txt': 'two\n' });
    commit(repo, 'chore(main): release 0.6.0', {
      'package.json': '{"version":"0.6.0"}\n',
      'CHANGELOG.md': '# 0.6.0\n',
      '.release-please-manifest.json': '{}\n',
    });

    expect(() => check(repo, latest, `<!-- release-base: ${oldBase} -->`)).toThrow(/generated from/);
  });
});
