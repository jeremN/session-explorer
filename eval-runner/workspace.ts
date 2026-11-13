// One throwaway clone per run. The clone has no remote, so nothing the agent does reaches the source repository.
// The source repository is read by `clone`, `rev-parse` and `status` only.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import type { Exec } from './exec.ts';
import type { Config } from './spec.ts';

type Setup = { claudeMd: Config['claudeMd']; skills: string[] };

const AUTHOR = ['-c', 'user.name=eval-runner', '-c', 'user.email=eval-runner@localhost', '-c', 'commit.gpgsign=false'];
const ENV = { GIT_TERMINAL_PROMPT: '0' };

async function git(exec: Exec, cwd: string, args: string[]) {
	const result = await exec('git', args, { cwd, env: ENV });
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

export async function createWorkspace(exec: Exec, { repo, baseSha, dir, setup }: { repo: string; baseSha: string; dir: string; setup: Setup }) {
	mkdirSync(dirname(dir), { recursive: true });
	await git(exec, dirname(dir), ['clone', '--local', '--no-checkout', repo, dir]);
	await git(exec, dir, ['remote', 'remove', 'origin']);
	await git(exec, dir, ['checkout', '--detach', baseSha]);
	if (setup.claudeMd) writeFileSync(join(dir, 'CLAUDE.md'), 'text' in setup.claudeMd ? setup.claudeMd.text : readFileSync(setup.claudeMd.file, 'utf8'));
	for (const skill of setup.skills) cpSync(skill, join(dir, '.claude', 'skills', basename(skill)), { recursive: true });
	// The diff of the run is measured against this commit, so the configuration files never count as agent work.
	await git(exec, dir, ['add', '-A']);
	await git(exec, dir, [...AUTHOR, 'commit', '--allow-empty', '-q', '-m', 'eval-runner setup']);
	return { setupSha: (await git(exec, dir, ['rev-parse', 'HEAD'])).trim() };
}

export async function collectDiff(exec: Exec, dir: string, setupSha: string) {
	await git(exec, dir, ['add', '-A']);
	const numstat = await git(exec, dir, ['diff', '--cached', '--numstat', setupSha]);
	const patch = await git(exec, dir, ['diff', '--cached', setupSha]);
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
