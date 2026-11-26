import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { realExec } from './exec.ts';
import type { Exec } from './exec.ts';
import { mirrorPath, prepareMirror } from './mirror.ts';
import { createWorkspace, resolveBase } from './workspace.ts';

let root: string;
const git = async (cwd: string, ...args: string[]) => {
	const result = await realExec('git', args, { cwd });
	assert.equal(result.code, 0, result.stderr);
	return result.stdout.trim();
};
before(() => {
	root = mkdtempSync(join(tmpdir(), 'eval-mirror-'));
});
after(() => rmSync(root, { recursive: true, force: true }));

// A source repository with one commit, and a cache folder of its own.
async function fixture(name: string) {
	const repo = join(root, name, 'source');
	mkdirSync(repo, { recursive: true });
	await git(repo, 'init', '-q', '-b', 'main');
	await git(repo, 'config', 'user.email', 'test@localhost');
	await git(repo, 'config', 'user.name', 'test');
	writeFileSync(join(repo, 'a.txt'), 'one\n');
	await git(repo, 'add', '-A');
	await git(repo, 'commit', '-q', '-m', 'init');
	return { repo, cacheDir: join(root, name, 'cache'), base: await git(repo, 'rev-parse', 'HEAD') };
}
const commit = async (repo: string, text: string) => {
	writeFileSync(join(repo, 'a.txt'), text);
	await git(repo, 'commit', '-q', '-a', '-m', text.trim());
	return git(repo, 'rev-parse', 'HEAD');
};
const counting = () => {
	const calls: string[][] = [];
	const exec: Exec = (command, args, options) => {
		if (command === 'git') calls.push(args);
		return realExec(command, args, options);
	};
	return { exec, calls };
};

test('the first eval clones a bare mirror under the cache, and the path holds a hash of the repo path', async () => {
	const { repo, cacheDir, base } = await fixture('create');
	const spy = counting();
	const mirror = await prepareMirror(spy.exec, { repo, baseSha: base, cacheDir });
	assert.equal(mirror, mirrorPath(cacheDir, repo));
	assert.match(mirror.slice(join(cacheDir, 'mirrors').length + 1), /^[0-9a-f]{16}$/);
	assert.equal(await git(mirror, 'rev-parse', '--is-bare-repository'), 'true');
	await git(mirror, 'cat-file', '-e', `${base}^{commit}`);
	assert.equal(spy.calls.filter((args) => args.includes('--mirror')).length, 1);
	// Another repo gets another mirror.
	assert.notEqual(mirrorPath(cacheDir, join(repo, 'other')), mirror);
});

test('the second eval fetches: a new commit of the source shows in the mirror, and a pruned branch goes', async () => {
	const { repo, cacheDir, base } = await fixture('fetch');
	await git(repo, 'branch', 'old');
	const spy = counting();
	const mirror = await prepareMirror(spy.exec, { repo, baseSha: base, cacheDir });
	assert.equal(await git(mirror, 'rev-parse', 'refs/heads/old'), base);
	await git(repo, 'branch', '-D', 'old');
	const next = await commit(repo, 'two\n');
	await prepareMirror(spy.exec, { repo, baseSha: next, cacheDir });
	assert.equal(spy.calls.filter((args) => args.includes('--mirror')).length, 1);
	assert.equal(spy.calls.filter((args) => args.includes('fetch') && args.includes('--prune')).length, 1);
	await git(mirror, 'cat-file', '-e', `${next}^{commit}`);
	assert.equal(await git(mirror, 'rev-parse', 'refs/heads/main'), next);
	assert.equal((await realExec('git', ['rev-parse', '--verify', 'refs/heads/old'], { cwd: mirror })).code, 128);
});

test('a run clones from the mirror: the clone works when the source is gone', async () => {
	const { repo, cacheDir, base } = await fixture('gone');
	const mirror = await prepareMirror(realExec, { repo, baseSha: base, cacheDir });
	renameSync(repo, `${repo}-away`);
	const dir = join(root, 'gone', 'clone');
	await createWorkspace(realExec, { repo: mirror, baseSha: base, dir, gitDir: join(root, 'gone', 'gitdir'), setup: { claudeMd: undefined, skills: [] } });
	assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'one\n');
	// The clone keeps no link to the mirror: no alternates, so a fetch or a prune of the mirror cannot break it.
	assert.equal(existsSync(join(dir, '.git', 'objects', 'info', 'alternates')), false);
	assert.equal((await realExec('git', ['remote'], { cwd: dir })).stdout.trim(), '');
});

test('a base commit under no ref still reaches the mirror: a detached commit, and a commit no ref names', async () => {
	const { repo, cacheDir, base } = await fixture('detached');
	const mirror = await prepareMirror(realExec, { repo, baseSha: base, cacheDir });
	await git(repo, 'checkout', '-q', '--detach');
	const detached = await commit(repo, 'detached\n');
	assert.equal(await resolveBase(realExec, repo, 'HEAD'), detached);
	assert.equal((await realExec('git', ['cat-file', '-e', `${detached}^{commit}`], { cwd: mirror })).code !== 0, true);
	await prepareMirror(realExec, { repo, baseSha: detached, cacheDir });
	await git(mirror, 'cat-file', '-e', `${detached}^{commit}`);
	// A commit with no ref at all: not in the refs, not in HEAD.
	const tree = await git(repo, 'rev-parse', `${base}^{tree}`);
	const loose = await git(repo, 'commit-tree', tree, '-p', base, '-m', 'loose');
	await git(repo, 'checkout', '-q', 'main');
	assert.equal((await realExec('git', ['cat-file', '-e', `${loose}^{commit}`], { cwd: mirror })).code !== 0, true);
	await prepareMirror(realExec, { repo, baseSha: loose, cacheDir });
	await git(mirror, 'cat-file', '-e', `${loose}^{commit}`);
	// The clone fetches it from the mirror.
	const dir = join(root, 'detached', 'clone');
	await createWorkspace(realExec, { repo: mirror, baseSha: loose, dir, gitDir: join(root, 'detached', 'gitdir'), setup: { claudeMd: undefined, skills: [] } });
	assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'one\n');
});

test('parallel prepares of one repo end with one mirror, one clone and no error, and no lock stays', async () => {
	const { repo, cacheDir, base } = await fixture('parallel');
	const spy = counting();
	const paths = await Promise.all([1, 2, 3].map(() => prepareMirror(spy.exec, { repo, baseSha: base, cacheDir })));
	assert.equal(new Set(paths).size, 1);
	assert.equal(spy.calls.filter((args) => args.includes('--mirror')).length, 1);
	assert.deepEqual(readdirSync(join(cacheDir, 'mirrors')), [paths[0].split('/').pop()]);
	await git(paths[0], 'fsck', '--no-dangling');
});

test('a lock of a dead process is removed, and a failed clone leaves no half mirror', async () => {
	const { repo, cacheDir, base } = await fixture('stale');
	const mirror = mirrorPath(cacheDir, repo);
	mkdirSync(join(cacheDir, 'mirrors'), { recursive: true });
	const dead = spawnSync(process.execPath, ['-e', '']).pid!;
	writeFileSync(`${mirror}.lock`, String(dead));
	await prepareMirror(realExec, { repo, baseSha: base, cacheDir });
	assert.equal(existsSync(`${mirror}.lock`), false);
	await git(mirror, 'cat-file', '-e', `${base}^{commit}`);

	const broken = await fixture('broken');
	await assert.rejects(prepareMirror(realExec, { repo: join(broken.repo, 'missing'), baseSha: broken.base, cacheDir: broken.cacheDir }), /mirror/);
	assert.deepEqual(readdirSync(join(broken.cacheDir, 'mirrors')), []);
});
