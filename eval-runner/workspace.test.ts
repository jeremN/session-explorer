import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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

const plain = { claudeMd: undefined, skills: [] as string[] };

test('R1: a CLAUDE.md symlink in the base commit is replaced, and the file it points to stays untouched', async () => {
	const victim = join(root, 'victim.txt');
	writeFileSync(victim, 'precious\n');
	const evil = join(root, 'evil');
	mkdirSync(evil);
	await git(evil, 'init', '-q', '-b', 'main');
	await git(evil, 'config', 'user.email', 't@localhost');
	await git(evil, 'config', 'user.name', 't');
	symlinkSync(victim, join(evil, 'CLAUDE.md'));
	await git(evil, 'add', '-A');
	await git(evil, 'commit', '-q', '-m', 'link');
	const sha = await git(evil, 'rev-parse', 'HEAD');
	const dir = join(root, 'clones', 'r1');
	await createWorkspace(realExec, { repo: evil, baseSha: sha, dir, setup: { claudeMd: { text: 'Be terse.\n' }, skills: [] } });
	assert.equal(readFileSync(victim, 'utf8'), 'precious\n');
	assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), 'Be terse.\n');
	await removeWorkspace(dir);
});

test('R1: a skill destination that passes through a symlink is refused', async () => {
	const outside = join(root, 'outside-skills');
	mkdirSync(outside);
	const evil = join(root, 'evil2');
	mkdirSync(evil);
	await git(evil, 'init', '-q', '-b', 'main');
	await git(evil, 'config', 'user.email', 't@localhost');
	await git(evil, 'config', 'user.name', 't');
	mkdirSync(join(evil, '.claude'));
	symlinkSync(outside, join(evil, '.claude', 'skills'));
	await git(evil, 'add', '-A');
	await git(evil, 'commit', '-q', '-m', 'link');
	const skill = join(root, 'skills', 'tidy');
	const sha = await git(evil, 'rev-parse', 'HEAD');
	await assert.rejects(() => createWorkspace(realExec, { repo: evil, baseSha: sha, dir: join(root, 'clones', 'r1b'), setup: { claudeMd: undefined, skills: [skill] } }), /symlink/);
	assert.deepEqual(readdirSync(outside), []);
});

test('S1: the clone does not share object files with the source repository', async () => {
	const dir = join(root, 'clones', 's1');
	await createWorkspace(realExec, { repo, baseSha: base, dir, setup: plain });
	const objects = join(repo, '.git', 'objects');
	const folder = readdirSync(objects).find((name) => /^[0-9a-f]{2}$/.test(name))!;
	const file = readdirSync(join(objects, folder))[0];
	assert.notEqual(statSync(join(dir, '.git', 'objects', folder, file)).ino, statSync(join(objects, folder, file)).ino);
	await removeWorkspace(dir);
});

test('S2: a config, filter or fsmonitor set by the agent never runs in the runner', async () => {
	const dir = join(root, 'clones', 's2');
	const backup = join(root, 's2-config.bak');
	const { setupSha } = await createWorkspace(realExec, { repo, baseSha: base, dir, setup: plain, configBackup: backup });
	const marker = join(root, 's2-marker');
	const script = join(root, 's2-script.sh');
	writeFileSync(script, `#!/bin/sh\ntouch ${marker}\ncat\n`);
	chmodSync(script, 0o755);
	await git(dir, 'config', 'core.fsmonitor', script);
	await git(dir, 'config', 'filter.x.clean', script);
	await git(dir, 'config', 'diff.external', script);
	await git(dir, 'config', 'core.hooksPath', join(root, 'hooks-that-do-not-exist'));
	writeFileSync(join(dir, '.gitattributes'), '* filter=x diff=x\n');
	writeFileSync(join(dir, 'a.txt'), 'one\nchanged\n');
	const diff = await collectDiff(realExec, dir, setupSha, backup);
	assert.equal(existsSync(marker), false);
	assert.equal(diff.files, 2);
	assert.match(diff.patch, /changed/);
	await removeWorkspace(dir);
});

test('S3: the clone has a pre-push hook, and a push to a local path fails under the agent environment', async () => {
	const { AGENT_ENV } = await import('./command.ts');
	const dir = join(root, 'clones', 's3');
	await createWorkspace(realExec, { repo, baseSha: base, dir, setup: plain });
	const hook = join(dir, '.git', 'hooks', 'pre-push');
	assert.ok(existsSync(hook));
	const hooked = await realExec('git', ['push', repo, 'HEAD:refs/heads/leak'], { cwd: dir });
	assert.notEqual(hooked.code, 0);
	rmSync(hook);
	const blocked = await realExec('git', ['push', repo, 'HEAD:refs/heads/leak'], { cwd: dir, env: AGENT_ENV });
	assert.notEqual(blocked.code, 0);
	assert.match(blocked.stderr, /protocol|not allowed|transport/i);
	assert.doesNotMatch(await git(repo, 'branch', '--list'), /leak/);
	await removeWorkspace(dir);
});
