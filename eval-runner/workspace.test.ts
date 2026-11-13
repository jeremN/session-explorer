import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { realExec } from './exec.ts';
import { collectDiff, createWorkspace, removeWorkspace, resolveBase, sourceStatus } from './workspace.ts';

let root: string;
let repo: string;
let base: string;
const git = async (cwd: string, ...args: string[]) => {
	const result = await realExec('git', args, { cwd });
	assert.equal(result.code, 0, result.stderr);
	return result.stdout.trim();
};

before(async () => {
	root = mkdtempSync(join(tmpdir(), 'eval-ws-'));
	repo = join(root, 'source');
	mkdirSync(repo);
	await git(repo, 'init', '-q', '-b', 'main');
	await git(repo, 'config', 'user.email', 'test@localhost');
	await git(repo, 'config', 'user.name', 'test');
	writeFileSync(join(repo, 'CLAUDE.md'), 'repository rules\n');
	writeFileSync(join(repo, 'a.txt'), 'one\n');
	await git(repo, 'add', '-A');
	await git(repo, 'commit', '-q', '-m', 'init');
	base = await git(repo, 'rev-parse', 'HEAD');
});
after(() => rmSync(root, { recursive: true, force: true }));

test('resolveBase turns a commit-ish into a SHA and refuses an unknown one', async () => {
	assert.equal(await resolveBase(realExec, repo, 'HEAD'), base);
	await assert.rejects(() => resolveBase(realExec, repo, 'no-such-ref'), /no-such-ref/);
});

test('a workspace is a clone with no remote, and the setup commit holds the configuration files', async () => {
	const skill = join(root, 'skills', 'tidy');
	mkdirSync(skill, { recursive: true });
	writeFileSync(join(skill, 'SKILL.md'), '# tidy\n');
	const before = await sourceStatus(realExec, repo);
	const dir = join(root, 'clones', 'run-1');
	const { setupSha } = await createWorkspace(realExec, { repo, baseSha: base, dir, setup: { claudeMd: { text: 'Be terse.\n' }, skills: [skill] } });

	assert.equal(await git(dir, 'remote'), '');
	assert.equal(await git(dir, 'rev-parse', 'HEAD'), setupSha);
	assert.equal(await git(dir, 'rev-parse', 'HEAD~1'), base);
	const committed = (await git(dir, 'show', '--name-only', '--format=', setupSha)).split('\n').sort();
	assert.deepEqual(committed, ['.claude/skills/tidy/SKILL.md', 'CLAUDE.md']);
	assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), 'Be terse.\n');
	assert.equal(await git(dir, 'log', '-1', '--format=%an <%ae>'), 'eval-runner <eval-runner@localhost>');

	writeFileSync(join(dir, 'b.txt'), 'x\ny\n');
	writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');
	const diff = await collectDiff(realExec, dir, setupSha);
	assert.deepEqual([diff.files, diff.added, diff.deleted], [2, 3, 0]);
	assert.match(diff.patch, /\+\+\+ b\/b\.txt/);
	assert.doesNotMatch(diff.patch, /CLAUDE\.md/);

	await removeWorkspace(dir);
	assert.equal(existsSync(dir), false);
	assert.equal(await sourceStatus(realExec, repo), before);
	assert.equal(before, '');
});

test('a config with no files still gets a setup commit, and the clone starts clean', async () => {
	const dir = join(root, 'clones', 'run-2');
	const { setupSha } = await createWorkspace(realExec, { repo, baseSha: base, dir, setup: { claudeMd: undefined, skills: [] } });
	assert.equal(await git(dir, 'status', '--porcelain'), '');
	assert.deepEqual(await collectDiff(realExec, dir, setupSha), { patch: '', files: 0, added: 0, deleted: 0 });
	await removeWorkspace(dir);
});

test('a binary file counts as one file and zero lines', async () => {
	const dir = join(root, 'clones', 'run-3');
	const { setupSha } = await createWorkspace(realExec, { repo, baseSha: base, dir, setup: { claudeMd: undefined, skills: [] } });
	writeFileSync(join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255]));
	const diff = await collectDiff(realExec, dir, setupSha);
	assert.deepEqual([diff.files, diff.added, diff.deleted], [1, 0, 0]);
	await removeWorkspace(dir);
});
