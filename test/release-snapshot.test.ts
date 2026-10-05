import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = join(
  import.meta.dirname,
  '../.github/scripts/resolve-release-snapshot.sh',
);

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
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
  }).trim();
}

describe('release snapshot', () => {
  it('tags the release commit when a later merge is on main', () => {
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

    expect(resolve(repo, releaseHead, mergeSha)).toBe(releaseHead);
    expect(git(repo, ['merge-base', '--is-ancestor', releaseHead, mergeSha])).toBe('');
  });

  it('tags a squash that landed on the same base', () => {
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

  it('refuses a squash that includes a later commit', () => {
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

    expect(() => resolve(repo, releaseHead, squash)).toThrow(/landed after/);
  });

  it('refuses a release branch that merged main back in', () => {
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
});
