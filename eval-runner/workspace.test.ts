import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { setupFiles } from './command.ts';
import { previewEdits } from './edits.ts';
import { realExec } from './exec.ts';
import type { Edit } from './spec.ts';
import { collectDiff, createWorkspace, placeHiddenTests, removeWorkspace, resolveBase, sourceStatus, statusChange, treeWarning } from './workspace.ts';

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

test('the setup commit starts no git auto maintenance, so the runner copy of the git dir is stable', async () => {
	// Auto maintenance runs in the background after a commit. It rewrote .git/objects while the runner copied it.
	const envs: Array<Record<string, string | undefined>> = [];
	const recording: typeof realExec = (command, args, options) => {
		if (command === 'git' && args.includes('commit')) envs.push(options?.env ?? {});
		return realExec(command, args, options);
	};
	const dir = join(root, 'clones', 'no-maintenance');
	await createWorkspace(recording, { repo, baseSha: base, dir, gitDir: gitDirOf('no-maintenance'), setup: { claudeMd: { text: 'x\n' }, skills: [] } });
	assert.equal(envs.length, 1);
	const read = async (key: string) => (await realExec('git', ['config', '--get', key], { cwd: dir, env: envs[0] })).stdout.trim();
	assert.deepEqual([await read('maintenance.auto'), await read('gc.auto')], ['false', '0']);
});

test('the clone holds no commit after the base: no ref, no reflog, no object', async () => {
	const source = join(root, 'with-future');
	mkdirSync(source);
	await git(source, 'init', '-q', '-b', 'main');
	await git(source, 'config', 'user.email', 'test@localhost');
	await git(source, 'config', 'user.name', 'test');
	writeFileSync(join(source, 'a.txt'), 'base\n');
	await git(source, 'add', '-A');
	await git(source, 'commit', '-q', '-m', 'base');
	const baseSha = await git(source, 'rev-parse', 'HEAD');
	writeFileSync(join(source, 'a.txt'), 'the solution\n');
	await git(source, 'commit', '-q', '-am', 'future');
	const future = await git(source, 'rev-parse', 'HEAD');
	await git(source, 'tag', 'v-future');
	await git(source, 'branch', 'side', future);

	const dir = join(root, 'clones', 'history-cut');
	const gitDir = gitDirOf('history-cut');
	await createWorkspace(realExec, { repo: source, baseSha, dir, gitDir, setup: { claudeMd: undefined, skills: [] } });
	for (const where of [{ cwd: dir }, { cwd: dir, env: { GIT_DIR: gitDir } }]) {
		assert.notEqual((await realExec('git', ['cat-file', '-e', future], where)).code, 0, 'the future commit is readable');
		const subjects = (await realExec('git', ['log', '--all', '--reflog', '--format=%s'], where)).stdout;
		assert.doesNotMatch(subjects, /future/);
		assert.match(subjects, /base/);
	}
});

test('placeHiddenTests writes the files of the solution commit and replaces what the agent put there', async () => {
	const source = join(root, 'with-solution');
	mkdirSync(source);
	await git(source, 'init', '-q', '-b', 'main');
	await git(source, 'config', 'user.email', 'test@localhost');
	await git(source, 'config', 'user.name', 'test');
	writeFileSync(join(source, 'a.txt'), 'base\n');
	await git(source, 'add', '-A');
	await git(source, 'commit', '-q', '-m', 'base');
	mkdirSync(join(source, 'test'));
	writeFileSync(join(source, 'test', 'a.test.sh'), 'hidden test\n');
	await git(source, 'add', '-A');
	await git(source, 'commit', '-q', '-m', 'solution');
	const solution = await git(source, 'rev-parse', 'HEAD');

	const dir = join(root, 'clones', 'hidden');
	mkdirSync(join(dir, 'test'), { recursive: true });
	symlinkSync('/etc/hosts', join(dir, 'test', 'a.test.sh'));
	await placeHiddenTests(realExec, { repo: source, commit: solution, paths: ['test/a.test.sh'], dir });
	assert.equal(lstatSync(join(dir, 'test', 'a.test.sh')).isSymbolicLink(), false);
	assert.equal(readFileSync(join(dir, 'test', 'a.test.sh'), 'utf8'), 'hidden test\n');

	const linked = join(root, 'clones', 'hidden-linked');
	mkdirSync(linked, { recursive: true });
	symlinkSync(join(root, 'outside'), join(linked, 'test'));
	await assert.rejects(() => placeHiddenTests(realExec, { repo: source, commit: solution, paths: ['test/a.test.sh'], dir: linked }), /symlink/);
	await assert.rejects(() => placeHiddenTests(realExec, { repo: source, commit: solution, paths: ['test/missing.sh'], dir }), /test\/missing\.sh/);
});

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
	// The fetch writes its own pack, so the test compares every file, not one object path.
	const inodes = (top: string) => new Set(readdirSync(top, { recursive: true }).map((name) => statSync(join(top, String(name)))).filter((entry) => entry.isFile()).map((entry) => `${entry.dev}:${entry.ino}`));
	const source = inodes(join(repo, '.git', 'objects'));
	const shared = [...inodes(join(dir, '.git', 'objects'))].filter((inode) => source.has(inode));
	assert.ok(source.size > 0);
	assert.deepEqual(shared, []);
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

test('a user CLAUDE.md becomes CLAUDE.local.md in the setup commit, next to the CLAUDE.md of the project', async () => {
	const dir = join(root, 'clones', 'local-md');
	const gitDir = gitDirOf('local-md');
	const { setupSha } = await createWorkspace(realExec, { repo, baseSha: base, dir, gitDir, setup: { claudeMd: { text: 'project\n' }, localMd: { text: 'mine\n' }, skills: [] } });
	assert.equal(readFileSync(join(dir, 'CLAUDE.local.md'), 'utf8'), 'mine\n');
	assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), 'project\n');
	assert.match(await git(dir, 'show', '--name-only', '--format=', setupSha), /CLAUDE\.local\.md/);
	const diff = await collectDiff(realExec, dir, setupSha, gitDir);
	assert.equal(diff.files, 0);
	await removeWorkspace(dir);
});

test('remove deletes committed paths before the setup commit, so the removal is not agent work', async () => {
	mkdirSync(join(repo, '.claude', 'skills', 'team'), { recursive: true });
	writeFileSync(join(repo, '.claude', 'skills', 'team', 'SKILL.md'), 'team\n');
	writeFileSync(join(repo, 'AGENTS.md'), 'team rules\n');
	await git(repo, 'add', '-A');
	await git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'harness');
	const head = (await git(repo, 'rev-parse', 'HEAD')).trim();
	const dir = join(root, 'clones', 'remove');
	const gitDir = gitDirOf('remove');
	const { setupSha } = await createWorkspace(realExec, { repo, baseSha: head, dir, gitDir, setup: { claudeMd: { text: 'mine\n' }, skills: [], remove: ['AGENTS.md', '.claude'] } });
	assert.equal(existsSync(join(dir, 'AGENTS.md')), false);
	assert.equal(existsSync(join(dir, '.claude')), false);
	assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), 'mine\n');
	assert.equal((await collectDiff(realExec, dir, setupSha, gitDir)).files, 0);
	await removeWorkspace(dir);
});

test('files replaces committed files and adds new ones in the setup commit, so the change is not agent work', async () => {
	mkdirSync(join(repo, 'apps', 'bff'), { recursive: true });
	writeFileSync(join(repo, 'AGENTS.md'), 'team rules\n');
	writeFileSync(join(repo, 'apps', 'bff', 'AGENTS.md'), 'bff rules\n');
	await git(repo, 'add', '-A');
	await git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'nested harness');
	const head = (await git(repo, 'rev-parse', 'HEAD')).trim();
	const lite = join(root, 'lite.md');
	writeFileSync(lite, 'lite rules\n');
	const dir = join(root, 'clones', 'files');
	const gitDir = gitDirOf('files');
	const { setupSha } = await createWorkspace(realExec, { repo, baseSha: head, dir, gitDir, setup: { claudeMd: undefined, skills: [], files: { 'AGENTS.md': { file: lite }, 'docs/new/NOTE.md': { text: 'new\n' } } } });
	assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), 'lite rules\n');
	assert.equal(readFileSync(join(dir, 'docs', 'new', 'NOTE.md'), 'utf8'), 'new\n');
	assert.equal(readFileSync(join(dir, 'apps', 'bff', 'AGENTS.md'), 'utf8'), 'bff rules\n');
	assert.deepEqual((await git(dir, 'show', '--name-only', '--format=', setupSha)).trim().split('\n').sort(), ['AGENTS.md', 'docs/new/NOTE.md']);
	assert.equal((await collectDiff(realExec, dir, setupSha, gitDir)).files, 0);
	await removeWorkspace(dir);
});

test('edits apply after remove and files, in the setup commit: an edit of a file that files wrote sees the new text', async () => {
	mkdirSync(join(repo, 'apps', 'web'), { recursive: true });
	writeFileSync(join(repo, 'AGENTS.md'), '# Rules\n\nFrequent commands: `pnpm lint`.\n');
	writeFileSync(join(repo, 'apps', 'web', 'AGENTS.md'), 'web rules\n');
	await git(repo, 'add', '-A');
	await git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'edits harness');
	const head = (await git(repo, 'rev-parse', 'HEAD')).trim();
	const config = {
		name: 'variant',
		remove: ['apps/web'],
		files: { 'apps/bff/AGENTS.md': { text: 'bff variant\n' } },
		edits: [
			{ file: 'AGENTS.md', replace: '^Frequent commands: .*$', flags: 'm', with: 'Verify in this order.' },
			{ file: 'apps/bff/AGENTS.md', append: 'edited\n' },
			{ file: 'apps/web/AGENTS.md', prepend: 'back\n', create: true }
		] as Edit[]
	};
	const dir = join(root, 'clones', 'edits');
	const gitDir = gitDirOf('edits');
	const { setupSha } = await createWorkspace(realExec, { repo, baseSha: head, dir, gitDir, setup: setupFiles(config) });
	assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), '# Rules\n\nVerify in this order.\n');
	assert.equal(readFileSync(join(dir, 'apps', 'bff', 'AGENTS.md'), 'utf8'), 'bff variant\nedited\n');
	assert.equal(readFileSync(join(dir, 'apps', 'web', 'AGENTS.md'), 'utf8'), 'back\n');
	assert.deepEqual((await git(dir, 'show', '--name-only', '--format=', setupSha)).trim().split('\n').sort(), ['AGENTS.md', 'apps/bff/AGENTS.md', 'apps/web/AGENTS.md']);
	assert.equal((await collectDiff(realExec, dir, setupSha, gitDir)).files, 0);
	// The preview of the cache key and of edits.patch reads git, and gives the same text as the clone.
	const preview = await previewEdits(realExec, { repo, baseSha: head, config });
	assert.equal(preview.length, 3);
	for (const file of preview) assert.equal(file.after, readFileSync(join(dir, file.path), 'utf8'), file.path);
	await removeWorkspace(dir);
});

test('an edit that fails stops the workspace before the setup commit, with the edit index in the message', async () => {
	const dir = join(root, 'clones', 'edits-fail');
	await assert.rejects(() => createWorkspace(realExec, { repo, baseSha: base, dir, gitDir: gitDirOf('edits-fail'), setup: { ...plain, edits: [{ file: 'a.txt', replace: 'nowhere', with: '' }] } }), { name: 'EditError', message: 'edits[0] a.txt: the pattern matches 0 times, expected 1' });
	await removeWorkspace(dir);
});

test('an edit of a file that is a symlink in the base commit is refused, and the target stays untouched', async () => {
	const victim = join(root, 'victim-edit.txt');
	writeFileSync(victim, 'precious\n');
	const evil = join(root, 'evil-edit');
	mkdirSync(evil);
	await git(evil, 'init', '-q', '-b', 'main');
	await git(evil, 'config', 'user.email', 't@localhost');
	await git(evil, 'config', 'user.name', 't');
	symlinkSync(victim, join(evil, 'AGENTS.md'));
	mkdirSync(join(evil, 'real'));
	symlinkSync('real', join(evil, 'linked'));
	writeFileSync(join(evil, 'real', 'AGENTS.md'), 'inner\n');
	await git(evil, 'add', '-A');
	await git(evil, 'commit', '-q', '-m', 'link');
	const sha = await git(evil, 'rev-parse', 'HEAD');
	const setup = (file: string) => ({ ...plain, edits: [{ file, append: 'x' }] });
	await assert.rejects(() => createWorkspace(realExec, { repo: evil, baseSha: sha, dir: join(root, 'clones', 'edit-link'), gitDir: gitDirOf('edit-link'), setup: setup('AGENTS.md') }), /^EditError: edits\[0\] AGENTS\.md: the file is a symlink$/);
	await assert.rejects(() => createWorkspace(realExec, { repo: evil, baseSha: sha, dir: join(root, 'clones', 'edit-link2'), gitDir: gitDirOf('edit-link2'), setup: setup('linked/AGENTS.md') }), /edits\[0\] linked\/AGENTS\.md: .*symlink/);
	assert.equal(readFileSync(victim, 'utf8'), 'precious\n');
	await assert.rejects(previewEdits(realExec, { repo: evil, baseSha: sha, config: { name: 'v', edits: [{ file: 'AGENTS.md', append: 'x' }] } }), /^EditError: edits\[0\] AGENTS\.md: the file is a symlink$/);
});


test('statusChange lists the lines that appeared and the lines that disappeared, ten at most', () => {
	assert.deepEqual(statusChange(' M a.txt\n?? b.txt', '?? b.txt\n?? c.txt'), { appeared: ['?? c.txt'], disappeared: [' M a.txt'] });
	assert.deepEqual(statusChange('', ''), { appeared: [], disappeared: [] });
	const many = Array.from({ length: 13 }, (_, index) => `?? f${index}.txt`).join('\n');
	const { appeared } = statusChange('', many);
	assert.equal(appeared.length, 11);
	assert.equal(appeared[9], '?? f9.txt');
	assert.equal(appeared[10], '... 3 more');
});

test('treeWarning names the phase and the lines, and stays silent when nothing changed', () => {
	assert.equal(treeWarning('/r', { before: '?? a', afterRuns: '?? a', final: '?? a' }), undefined);
	const runs = treeWarning('/r', { before: '', afterRuns: '?? x.txt', final: '?? x.txt' })!;
	assert.match(runs, /^Warning: the working tree of \/r changed during the runs\./);
	assert.match(runs, /appeared:\n {2}\?\? x\.txt/);
	const grading = treeWarning('/r', { before: ' M a', afterRuns: ' M a', final: '' })!;
	assert.match(grading, /changed during the grading\./);
	assert.match(grading, /disappeared:\n {2} M a/);
	assert.doesNotMatch(grading, /\nappeared:/);
});
