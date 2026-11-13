// One throwaway clone per run. The clone has no remote, so nothing the agent does reaches the source repository.
// The source repository is read by `clone`, `rev-parse` and `status` only.
import { chmodSync, copyFileSync, cpSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import type { Exec } from './exec.ts';
import type { Config } from './spec.ts';

type Setup = { claudeMd: Config['claudeMd']; skills: string[] };

const AUTHOR = ['-c', 'user.name=eval-runner', '-c', 'user.email=eval-runner@localhost', '-c', 'commit.gpgsign=false'];
const ENV = { GIT_TERMINAL_PROMPT: '0' };

// After the agent ran, the clone is hostile: its config, hooks and attributes belong to the agent.
// These settings keep the runner from running code that the agent chose.
const SAFE_CONFIG = ['-c', 'core.fsmonitor=', '-c', 'core.hooksPath=/dev/null', '-c', 'core.pager=cat'];
const SAFE_ENV = { ...ENV, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };

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

// The base commit is not trusted: a path in it can be a symlink to a file outside the clone.
function refuseSymlinks(dir: string, relative: string) {
	let path = dir;
	for (const part of relative.split('/')) {
		path = join(path, part);
		try {
			if (lstatSync(path).isSymbolicLink()) throw new Error(`${relative} passes through a symlink in the base commit`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			return;
		}
	}
}

export async function createWorkspace(exec: Exec, { repo, baseSha, dir, setup, configBackup }: { repo: string; baseSha: string; dir: string; setup: Setup; configBackup?: string }) {
	mkdirSync(dirname(dir), { recursive: true });
	// `--no-hardlinks`: a hard link would let a write in the clone reach the object files of the source repository.
	await git(exec, dirname(dir), ['clone', '--local', '--no-hardlinks', '--no-checkout', repo, dir]);
	await git(exec, dir, ['remote', 'remove', 'origin']);
	await git(exec, dir, ['checkout', '--detach', baseSha]);
	if (setup.claudeMd) {
		// Remove first: writeFileSync would follow a symlink and write outside the clone.
		rmSync(join(dir, 'CLAUDE.md'), { force: true });
		writeFileSync(join(dir, 'CLAUDE.md'), 'text' in setup.claudeMd ? setup.claudeMd.text : readFileSync(setup.claudeMd.file, 'utf8'));
	}
	for (const skill of setup.skills) {
		const target = `.claude/skills/${basename(skill)}`;
		refuseSymlinks(dir, target);
		cpSync(skill, join(dir, target), { recursive: true, dereference: false, verbatimSymlinks: true });
	}
	// The diff of the run is measured against this commit, so the configuration files never count as agent work.
	await git(exec, dir, ['add', '-A']);
	await git(exec, dir, [...AUTHOR, 'commit', '--allow-empty', '-q', '-m', 'eval-runner setup']);
	// A push from the clone has nowhere to go, and this hook stops one anyway.
	const hooks = join(dir, '.git', 'hooks');
	mkdirSync(hooks, { recursive: true });
	const hook = join(hooks, 'pre-push');
	rmSync(hook, { force: true });
	writeFileSync(hook, '#!/bin/sh\necho "eval-runner: push is disabled" >&2\nexit 1\n');
	chmodSync(hook, 0o755);
	// The agent controls .git/config. collectDiff restores this copy before it runs any git command.
	if (configBackup) copyFileSync(join(dir, '.git', 'config'), configBackup);
	return { setupSha: (await git(exec, dir, ['rev-parse', 'HEAD'])).trim() };
}

export async function collectDiff(exec: Exec, dir: string, setupSha: string, configBackup?: string) {
	// This removes every filter, textconv, fsmonitor and include that the agent set.
	if (configBackup) {
		rmSync(join(dir, '.git', 'config'), { force: true });
		copyFileSync(configBackup, join(dir, '.git', 'config'));
	}
	await git(exec, dir, ['add', '-A'], true);
	const numstat = await git(exec, dir, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--numstat', setupSha], true);
	const patch = await git(exec, dir, ['diff', '--cached', '--no-ext-diff', '--no-textconv', setupSha], true);
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
