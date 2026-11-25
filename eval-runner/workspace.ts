// One throwaway clone per run. The clone has no remote, so nothing the agent does reaches the source repository.
// The source repository is read by `clone`, `rev-parse` and `status` only.
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import type { Exec } from './exec.ts';
import type { Config, Spec } from './spec.ts';

// `instructionFile` is the name the claudeMd gets in the clone: CLAUDE.md, or AGENTS.md for codex and opencode.
// `localMd` becomes CLAUDE.local.md: Claude Code reads it with the CLAUDE.md of the project, as a user CLAUDE.md.
// `remove` is deleted first, so a claudeMd or a skill of the config can take the place of a removed file.
type Setup = { claudeMd: Config['claudeMd']; localMd?: Config['claudeMd']; skills: string[]; instructionFile?: string; remove?: string[]; files?: Config['files'] };

const AUTHOR = ['-c', 'user.name=eval-runner', '-c', 'user.email=eval-runner@localhost', '-c', 'commit.gpgsign=false'];
// No git auto maintenance: after a commit it runs in the background and rewrites .git while the runner copies it.
const ENV = { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'maintenance.auto', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'gc.auto', GIT_CONFIG_VALUE_1: '0' };

// After the agent started, everything in the clone is hostile, `.git` included: it can be a symlink, a `gitdir:` file,
// or hold the config, hooks and attributes of the agent. So the runner never reads or writes the `.git` of the clone
// again. It uses its own copy of the git dir, and these settings keep it from running code that the agent chose.
const SAFE_CONFIG = ['-c', 'core.fsmonitor=', '-c', 'core.hooksPath=/dev/null', '-c', 'core.pager=cat', '-c', 'core.attributesFile=/dev/null'];
// The runner environment must not redirect git either.
const SAFE_ENV = { ...ENV, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, GIT_COMMON_DIR: undefined, GIT_OBJECT_DIRECTORY: undefined };

async function git(exec: Exec, cwd: string, args: string[], safe = false) {
	const result = await exec('git', safe ? [...SAFE_CONFIG, ...args] : args, { cwd, env: safe ? SAFE_ENV : ENV });
	if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim() || result.stdout.trim()}`);
	return result.stdout;
}

export async function resolveBase(exec: Exec, repo: string, base: string): Promise<string> {
	const result = await exec('git', ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`], { cwd: repo, env: ENV });
	if (result.code !== 0) throw new Error(`spec.task.base: cannot resolve "${base}" in ${repo}`);
	return result.stdout.trim();
}

export async function sourceStatus(exec: Exec, repo: string): Promise<string> {
	return (await git(exec, repo, ['status', '--porcelain'])).trimEnd();
}

// The base commit is not trusted: a parent directory in it can be a symlink to a directory outside the clone.
function refuseSymlinks(dir: string, relative: string) {
	let path = dir;
	for (const part of relative.split('/').slice(0, -1)) {
		path = join(path, part);
		try {
			if (lstatSync(path).isSymbolicLink()) throw new Error(`${relative} passes through a symlink in the base commit`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			return;
		}
	}
}

// Hidden tests come from the solution commit of a mined task. They enter the clone after the agent stops, so the agent
// never reads them. The clone is hostile by then: a file or a parent directory can be a symlink.
export async function placeHiddenTests(exec: Exec, { repo, commit, paths, dir }: { repo: string; commit: string; paths: string[]; dir: string }) {
	for (const path of paths) {
		const shown = await exec('git', ['show', `${commit}:${path}`], { cwd: repo, env: ENV });
		if (shown.code !== 0) throw new Error(`hiddenTests: ${path} is not in commit ${commit}`);
		refuseSymlinks(dir, path);
		const target = join(dir, path);
		mkdirSync(dirname(target), { recursive: true });
		refuseSymlinks(dir, path);
		// rmSync removes a symlink itself, never its target. The `wx` flag (O_CREAT|O_EXCL) fails if a file or a symlink
		// came back in between, so the write never follows a link. A parent swapped by a surviving process stays the
		// residual risk of the README: only an OS boundary closes it.
		rmSync(target, { recursive: true, force: true });
		writeFileSync(target, shown.stdout, { flag: 'wx' });
	}
}

// `gitDir` is the copy of the git dir that the runner keeps outside the clone, at a path the agent never gets.
// collectDiff uses only that copy.
export async function createWorkspace(exec: Exec, { repo, baseSha, dir, gitDir, setup }: { repo: string; baseSha: string; dir: string; gitDir: string; setup: Setup }) {
	mkdirSync(dirname(dir), { recursive: true });
	// A task mined from a past session has its solution in a later commit. The clone fetches the base commit only, so it
	// holds the base and its ancestors and nothing else: no later commit, no ref, no remote. The fetch writes a new pack,
	// so no object file is shared with the source repository.
	mkdirSync(dir, { recursive: true });
	await git(exec, dir, ['init', '-q']);
	await git(exec, dir, ['fetch', '-q', '--no-tags', repo, baseSha]);
	await git(exec, dir, ['checkout', '-q', '--detach', baseSha]);
	// FETCH_HEAD names the path of the source repository.
	rmSync(join(dir, '.git', 'FETCH_HEAD'), { force: true });
	for (const path of setup.remove ?? []) {
		// rmSync removes a symlink itself, never its target; a symlinked parent would point the removal outside the clone.
		refuseSymlinks(dir, path);
		rmSync(join(dir, path), { recursive: true, force: true });
	}
	for (const [path, content] of Object.entries(setup.files ?? {})) {
		// Same guard as a skill: no write through a symlinked parent, and the file itself is removed before the write.
		refuseSymlinks(dir, path);
		rmSync(join(dir, path), { recursive: true, force: true });
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), 'text' in content ? content.text : readFileSync(content.file, 'utf8'));
	}
	const instructions: [string, Config['claudeMd']][] = [[setup.instructionFile ?? 'CLAUDE.md', setup.claudeMd], ['CLAUDE.local.md', setup.localMd]];
	for (const [file, md] of instructions) {
		if (!md) continue;
		// Remove first: writeFileSync would follow a symlink and write outside the clone.
		rmSync(join(dir, file), { force: true });
		writeFileSync(join(dir, file), 'text' in md ? md.text : readFileSync(md.file, 'utf8'));
	}
	for (const skill of setup.skills) {
		const target = `.claude/skills/${basename(skill)}`;
		refuseSymlinks(dir, target);
		// The destination can exist in the base commit, as a symlink or with symlinks in it. rmSync removes a symlink
		// without following it, so the copy never writes through one.
		rmSync(join(dir, target), { recursive: true, force: true });
		cpSync(skill, join(dir, target), { recursive: true, dereference: false, verbatimSymlinks: true });
	}
	// The diff of the run is measured against this commit, so the configuration files never count as agent work.
	await git(exec, dir, ['add', '-A']);
	// A repository can ignore CLAUDE.local.md. It belongs to the setup commit anyway, not to the diff of the agent.
	if (setup.localMd) await git(exec, dir, ['add', '-f', 'CLAUDE.local.md']);
	await git(exec, dir, [...AUTHOR, 'commit', '--allow-empty', '-q', '-m', 'eval-runner setup']);
	// A push from the clone has nowhere to go, and this hook stops one anyway.
	const hooks = join(dir, '.git', 'hooks');
	mkdirSync(hooks, { recursive: true });
	const hook = join(hooks, 'pre-push');
	rmSync(hook, { force: true });
	writeFileSync(hook, '#!/bin/sh\necho "eval-runner: push is disabled" >&2\nexit 1\n');
	chmodSync(hook, 0o755);
	const setupSha = (await git(exec, dir, ['rev-parse', 'HEAD'])).trim();
	const fileMode = (await exec('git', ['config', '--bool', 'core.filemode'], { cwd: dir, env: ENV })).stdout.trim() !== 'false';
	// The copy is taken before the agent starts, so its objects and refs are the ones of the runner.
	mkdirSync(gitDir, { recursive: true, mode: 0o700 });
	cpSync(join(dir, '.git'), gitDir, { recursive: true, dereference: false, verbatimSymlinks: true });
	chmodSync(gitDir, 0o700);
	return { setupSha, fileMode };
}

// A new clone at the base, the setup files of the config, the setup command of the task, then the saved diff.patch of
// a run. recheck.ts runs the check on it again, and grade.ts grades it.
export async function rebuildRun(exec: Exec, { task, baseSha, specDir, setup, patch, dir, gitDir }: { task: Spec['task']; baseSha: string; specDir: string; setup: Setup; patch: string; dir: string; gitDir: string }) {
	const workspace = await createWorkspace(exec, { repo: task.repo, baseSha, dir, gitDir, setup });
	if (task.setup) {
		const prepared = await exec('sh', ['-c', task.setup.command], { cwd: dir, env: { EVAL_SPEC_DIR: specDir }, timeoutMs: task.setup.timeoutSec * 1000 });
		if (prepared.code !== 0 || prepared.timedOut) throw new Error(`setup failed: ${(prepared.stdout + prepared.stderr).trim().slice(-200)}`);
	}
	if (readFileSync(patch, 'utf8').trim()) {
		const applied = await exec('git', ['apply', '--whitespace=nowarn', patch], { cwd: dir });
		if (applied.code !== 0) throw new Error(`diff.patch does not apply: ${applied.stderr.trim().slice(0, 200)}`);
	}
	return workspace;
}

// Right before the diff, the runner replaces everything in its copy that can make git run code or read files elsewhere.
// The config comes from memory, not from the disk, so a config written into the copy is lost.
function lockGitDir(gitDir: string, fileMode: boolean) {
	if (existsSync(join(gitDir, 'commondir'))) throw new Error(`${gitDir} has a commondir file`);
	rmSync(join(gitDir, 'hooks'), { recursive: true, force: true });
	// The whole info dir goes: info/attributes would apply filters, and rmSync never follows a symlink.
	rmSync(join(gitDir, 'info'), { recursive: true, force: true });
	rmSync(join(gitDir, 'config'), { force: true });
	writeFileSync(join(gitDir, 'config'), `[core]\n\trepositoryformatversion = 0\n\tfilemode = ${fileMode}\n\tbare = false\n`);
}

// Never reads or writes the `.git` of the clone: git gets the runner copy and the clone as its work tree.
// Git never adds an entry named `.git`, so the diff does not hold it.
export async function collectDiff(exec: Exec, dir: string, setupSha: string, gitDir: string, fileMode = true) {
	lockGitDir(gitDir, fileMode);
	const run = (args: string[]) => git(exec, dir, ['--git-dir', gitDir, '--work-tree', dir, ...args], true);
	await run(['add', '-A']);
	const numstat = await run(['diff', '--cached', '--no-ext-diff', '--no-textconv', '--numstat', setupSha]);
	const patch = await run(['diff', '--cached', '--no-ext-diff', '--no-textconv', setupSha]);
	let files = 0;
	let added = 0;
	let deleted = 0;
	for (const line of numstat.split('\n').filter(Boolean)) {
		const [plus, minus] = line.split('\t');
		files += 1;
		// A binary file shows "-" for both counts.
		added += Number(plus) || 0;
		deleted += Number(minus) || 0;
	}
	return { patch, files, added, deleted };
}

export async function removeWorkspace(dir: string) {
	rmSync(dir, { recursive: true, force: true });
}
