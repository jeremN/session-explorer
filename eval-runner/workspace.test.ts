import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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
// The runner keeps its copy of the git dir outside the clone, where the agent does not work.
const gitDirOf = (name: string) => join(root, 'gitdirs', name);

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
	const gitDir = gitDirOf('run-1');
	const { setupSha } = await createWorkspace(realExec, { repo, baseSha: base, dir, gitDir, setup: { claudeMd: { text: 'Be terse.\n' }, skills: [skill] } });

	assert.equal(await git(dir, 'remote'), '');
	assert.equal(await git(dir, 'rev-parse', 'HEAD'), setupSha);
	assert.equal(await git(dir, 'rev-parse', 'HEAD~1'), base);
	const committed = (await git(dir, 'show', '--name-only', '--format=', setupSha)).split('\n').sort();
	assert.deepEqual(committed, ['.claude/skills/tidy/SKILL.md', 'CLAUDE.md']);
	assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), 'Be terse.\n');
	assert.equal(await git(dir, 'log', '-1', '--format=%an <%ae>'), 'eval-runner <eval-runner@localhost>');

	writeFileSync(join(dir, 'b.txt'), 'x\ny\n');
	writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');
	const diff = await collectDiff(realExec, dir, setupSha, gitDir);
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
	const gitDir = gitDirOf('run-2');
	const { setupSha } = await createWorkspace(realExec, { repo, baseSha: base, dir, gitDir, setup: { claudeMd: undefined, skills: [] } });
	assert.equal(await git(dir, 'status', '--porcelain'), '');
	assert.deepEqual(await collectDiff(realExec, dir, setupSha, gitDir), { patch: '', files: 0, added: 0, deleted: 0 });
	await removeWorkspace(dir);
});

test('a binary file counts as one file and zero lines', async () => {
	const dir = join(root, 'clones', 'run-3');
	const gitDir = gitDirOf('run-3');
	const { setupSha } = await createWorkspace(realExec, { repo, baseSha: base, dir, gitDir, setup: { claudeMd: undefined, skills: [] } });
	writeFileSync(join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255]));
	const diff = await collectDiff(realExec, dir, setupSha, gitDir);
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
	await createWorkspace(realExec, { repo: evil, baseSha: sha, dir, gitDir: gitDirOf('r1'), setup: { claudeMd: { text: 'Be terse.\n' }, skills: [] } });
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
	await assert.rejects(() => createWorkspace(realExec, { repo: evil, baseSha: sha, dir: join(root, 'clones', 'r1b'), gitDir: gitDirOf('r1b'), setup: { claudeMd: undefined, skills: [skill] } }), /symlink/);
	assert.deepEqual(readdirSync(outside), []);
});

test('S1: the clone does not share object files with the source repository', async () => {
	const dir = join(root, 'clones', 's1');
	await createWorkspace(realExec, { repo, baseSha: base, dir, gitDir: gitDirOf('s1'), setup: plain });
	const objects = join(repo, '.git', 'objects');
	const folder = readdirSync(objects).find((name) => /^[0-9a-f]{2}$/.test(name))!;
	const file = readdirSync(join(objects, folder))[0];
	assert.notEqual(statSync(join(dir, '.git', 'objects', folder, file)).ino, statSync(join(objects, folder, file)).ino);
	await removeWorkspace(dir);
});

// The agent owns everything in the clone, its .git included. These stand-ins act after the setup, as the agent would.
async function makeVictim(name: string) {
	const victim = join(root, name);
	mkdirSync(victim);
	await git(victim, 'init', '-q', '-b', 'main');
	await git(victim, 'config', 'user.email', 'victim@localhost');
	await git(victim, 'config', 'user.name', 'victim');
	writeFileSync(join(victim, 'v.txt'), 'victim\n');
	await git(victim, 'add', '-A');
	await git(victim, 'commit', '-q', '-m', 'victim');
	return join(victim, '.git');
}
// Every path under a directory, with the bytes of each file and the target of each symlink.
function snapshot(dir: string, prefix = ''): Record<string, string> {
	const out: Record<string, string> = {};
	for (const name of readdirSync(join(dir, prefix))) {
		const path = join(prefix, name);
		const stat = lstatSync(join(dir, path));
		if (stat.isSymbolicLink()) out[path] = `-> ${readlinkSync(join(dir, path))}`;
		else if (stat.isDirectory()) Object.assign(out, snapshot(dir, path));
		else out[path] = readFileSync(join(dir, path)).toString('base64');
	}
	return out;
}

test('F1: a .git symlink to another git dir leaves that git dir byte-identical, and the diff still holds the agent work', async () => {
	const victim = await makeVictim('victim-a');
	const before = snapshot(victim);
	const dir = join(root, 'clones', 'f1a');
	const gitDir = gitDirOf('f1a');
	const { setupSha } = await createWorkspace(realExec, { repo, baseSha: base, dir, gitDir, setup: plain });
	writeFileSync(join(dir, 'work.txt'), 'agent work\n');
	rmSync(join(dir, '.git'), { recursive: true, force: true });
	symlinkSync(victim, join(dir, '.git'));
	const diff = await collectDiff(realExec, dir, setupSha, gitDir);
	assert.deepEqual(snapshot(victim), before);
	assert.equal(diff.files, 1);
	assert.match(diff.patch, /\+\+\+ b\/work\.txt/);
	assert.doesNotMatch(diff.patch, /[ab]\/\.git(\/|\s)/);
	await removeWorkspace(dir);
});

test('F1: a "gitdir:" file in place of .git leaves the git dir it names unchanged', async () => {
	const victim = await makeVictim('victim-c');
	const before = snapshot(victim);
	const dir = join(root, 'clones', 'f1c');
	const gitDir = gitDirOf('f1c');
	const { setupSha } = await createWorkspace(realExec, { repo, baseSha: base, dir, gitDir, setup: plain });
	writeFileSync(join(dir, 'work.txt'), 'agent work\n');
	rmSync(join(dir, '.git'), { recursive: true, force: true });
	writeFileSync(join(dir, '.git'), `gitdir: ${victim}\n`);
	const diff = await collectDiff(realExec, dir, setupSha, gitDir);
	assert.deepEqual(snapshot(victim), before);
	assert.equal(diff.files, 1);
	assert.match(diff.patch, /\+\+\+ b\/work\.txt/);
	await removeWorkspace(dir);
});

test('F1: a config, filter, attribute or fsmonitor that the agent writes into the clone never runs in the runner', async () => {
	const dir = join(root, 'clones', 'f1b');
	const gitDir = gitDirOf('f1b');
	const { setupSha } = await createWorkspace(realExec, { repo, baseSha: base, dir, gitDir, setup: plain });
	const marker = join(root, 'f1b-marker');
	const script = join(root, 'f1b-script.sh');
	writeFileSync(script, `#!/bin/sh\ntouch ${marker}\ncat\n`);
	chmodSync(script, 0o755);
	await git(dir, 'config', 'core.fsmonitor', script);
	await git(dir, 'config', 'filter.x.clean', script);
	await git(dir, 'config', 'diff.x.textconv', script);
	await git(dir, 'config', 'diff.external', script);
	await git(dir, 'config', 'core.hooksPath', join(root, 'hooks-that-do-not-exist'));
	mkdirSync(join(dir, '.git', 'info'), { recursive: true });
	writeFileSync(join(dir, '.git', 'info', 'attributes'), '* filter=x diff=x\n');
	writeFileSync(join(dir, '.gitattributes'), '* filter=x diff=x\n');
	writeFileSync(join(dir, 'a.txt'), 'one\nchanged\n');
	const diff = await collectDiff(realExec, dir, setupSha, gitDir);
	assert.equal(existsSync(marker), false);
	assert.equal(diff.files, 2);
	assert.match(diff.patch, /changed/);
	await removeWorkspace(dir);
});

test('F1: collectDiff refuses a runner git dir with a commondir file, and drops a config include', async () => {
	const dir = join(root, 'clones', 'f1d');
	const gitDir = gitDirOf('f1d');
	const { setupSha } = await createWorkspace(realExec, { repo, baseSha: base, dir, gitDir, setup: plain });
	writeFileSync(join(gitDir, 'commondir'), '/elsewhere\n');
	await assert.rejects(() => collectDiff(realExec, dir, setupSha, gitDir), /commondir/);
	rmSync(join(gitDir, 'commondir'));
	appendFileSync(join(gitDir, 'config'), '[include]\n\tpath = /elsewhere/config\n');
	assert.equal((await collectDiff(realExec, dir, setupSha, gitDir)).files, 0);
	assert.doesNotMatch(readFileSync(join(gitDir, 'config'), 'utf8'), /include/);
	await removeWorkspace(dir);
});

test('G1: a config, hook or attribute written into the runner git dir before collectDiff never runs', async () => {
	const dir = join(root, 'clones', 'g1b');
	const gitDir = gitDirOf('g1b');
	const { setupSha } = await createWorkspace(realExec, { repo, baseSha: base, dir, gitDir, setup: plain });
	const marker = join(root, 'g1b-marker');
	const script = join(root, 'g1b-script.sh');
	writeFileSync(script, `#!/bin/sh\ntouch ${marker}\ncat\n`);
	chmodSync(script, 0o755);
	appendFileSync(join(gitDir, 'config'), `[core]\n\tfsmonitor = ${script}\n[filter "x"]\n\tclean = ${script}\n`);
	mkdirSync(join(gitDir, 'info'), { recursive: true });
	writeFileSync(join(gitDir, 'info', 'attributes'), '* filter=x\n');
	writeFileSync(join(dir, '.gitattributes'), '* filter=x\n');
	writeFileSync(join(dir, 'a.txt'), 'one\nchanged\n');
	const diff = await collectDiff(realExec, dir, setupSha, gitDir);
	assert.equal(existsSync(marker), false);
	assert.equal(diff.files, 2);
	assert.match(diff.patch, /changed/);
	assert.equal(existsSync(join(gitDir, 'hooks')), false);
	await removeWorkspace(dir);
});

test('F2: a skill destination that is a symlink in the base commit is replaced, and the outside dir stays unchanged', async () => {
	const outside = join(root, 'f2-outside');
	mkdirSync(outside);
	writeFileSync(join(outside, 'SKILL.md'), 'outside\n');
	const evil = join(root, 'evil-f2');
	mkdirSync(evil);
	await git(evil, 'init', '-q', '-b', 'main');
	await git(evil, 'config', 'user.email', 't@localhost');
	await git(evil, 'config', 'user.name', 't');
	mkdirSync(join(evil, '.claude', 'skills'), { recursive: true });
	symlinkSync(outside, join(evil, '.claude', 'skills', 'tidy'));
	mkdirSync(join(evil, '.claude', 'skills', 'neat'));
	symlinkSync(join(outside, 'SKILL.md'), join(evil, '.claude', 'skills', 'neat', 'SKILL.md'));
	await git(evil, 'add', '-A');
	await git(evil, 'commit', '-q', '-m', 'links');
	const sha = await git(evil, 'rev-parse', 'HEAD');
	const skills = join(root, 'f2-skills');
	for (const name of ['tidy', 'neat']) {
		mkdirSync(join(skills, name), { recursive: true });
		writeFileSync(join(skills, name, 'SKILL.md'), `# ${name}\n`);
	}
	const before = snapshot(outside);
	const dir = join(root, 'clones', 'f2');
	await createWorkspace(realExec, { repo: evil, baseSha: sha, dir, gitDir: gitDirOf('f2'), setup: { claudeMd: undefined, skills: [join(skills, 'tidy'), join(skills, 'neat')] } });
	assert.deepEqual(snapshot(outside), before);
	for (const name of ['tidy', 'neat']) {
		assert.equal(lstatSync(join(dir, '.claude', 'skills', name, 'SKILL.md')).isFile(), true);
		assert.equal(readFileSync(join(dir, '.claude', 'skills', name, 'SKILL.md'), 'utf8'), `# ${name}\n`);
	}
	await removeWorkspace(dir);
});

test('S3: the clone has a pre-push hook, and a push to a local path fails under the agent environment', async () => {
	const { AGENT_ENV } = await import('./command.ts');
	const dir = join(root, 'clones', 's3');
	await createWorkspace(realExec, { repo, baseSha: base, dir, gitDir: gitDirOf('s3'), setup: plain });
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
