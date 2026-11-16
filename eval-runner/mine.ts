// Mines eval tasks from past Claude Code sessions. A candidate is a task that ended with a passing check, in a git
// repository that still exists, with a commit made during the task. The candidates go to a local file only.
// Usage: node eval-runner/mine.ts [--days 30] [--projects <regex>] [--out <file>]
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

import { classify, isUserPrompt, listJsonl, loadConfig, readLines, traceTasks } from '../context-tracer/tracer.ts';
import { realExec } from './exec.ts';
import type { Exec } from './exec.ts';

export type Commit = { sha: string; parent: string | undefined };
export type GitLookup = {
	isRepo(dir: string): Promise<boolean>;
	// Commits of every branch with a committer date in [since, until], oldest first.
	commitsBetween(dir: string, since: string, until: string): Promise<Commit[]>;
	changedFiles(dir: string, from: string, to: string): Promise<string[]>;
};
export type Candidate = {
	session: string;
	start: string;
	repo: string;
	// Commits between the base and the solution. One commit is the cleanest task.
	commits: number;
	// True when the check command names an absolute path: read it before you accept the task.
	review: boolean;
	spec: {
		name: string;
		task: { repo: string; base: string; prompt: string; timeoutSec: number; hiddenTests: { commit: string; paths: string[] }; acceptance: { command: string; timeoutSec: number } };
		budget: { perRunUsd: number; perEvalUsd: number };
		runs: number;
		configs: Array<{ name: string }>;
	};
};

const TEST_FILE = /(?:^|\/)(?:__tests__|tests?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.(?:go|py)$|(?:^|\/)test_[^/]+\.py$/;
// A commit a few minutes after the next prompt still belongs to the task: the agent often commits last.
const COMMIT_GRACE_MS = 10 * 60_000;
// Without a test file named in the check, a task keeps all its test files only when they are few and in one commit.
// A wider window mixes several intentions, and its tests go beyond the prompt.
const MAX_UNNAMED_TESTS = 5;
const text = (value: unknown) => (typeof value === 'string' ? value : '');

export async function findCandidates(sessions: Array<{ id: string; entries: unknown[] }>, git: GitLookup, skipUnder: string[] = []): Promise<Candidate[]> {
	const candidates: Candidate[] = [];
	for (const { id, entries } of sessions) {
		const rows = entries as Array<Record<string, any>>;
		for (const task of traceTasks(entries).tasks) {
			if (!task.verified || task.check !== 'passed') continue;
			const prompt = rows.find((row) => isUserPrompt(row) && row.timestamp === task.start);
			const repo = text(prompt?.cwd);
			if (!prompt || !repo || skipUnder.some((root) => repo === root || repo.startsWith(root + sep))) continue;
			if (!(await git.isRepo(repo))) continue;
			const command = verifyCommand(rows, task.verifiedAt!);
			if (!command) continue;
			const until = new Date(Date.parse(task.end) + COMMIT_GRACE_MS).toISOString();
			const commits = await git.commitsBetween(repo, task.start, until);
			const first = commits[0];
			const solution = commits.at(-1);
			if (!first?.parent || !solution) continue;
			const tests = (await git.changedFiles(repo, first.parent, solution.sha)).filter((path) => TEST_FILE.test(path));
			const paths = hiddenTestsOf(tests, command, commits.length);
			if (paths.length === 0) continue;
			const local = command.split(repo + '/').join('').split(repo).join('.');
			candidates.push({
				session: id,
				start: task.start,
				repo,
				commits: commits.length,
				review: /(?:^|[\s='"])\//.test(local),
				spec: {
					name: `${id.slice(0, 8)}-${task.start.slice(0, 16).replace(/[^0-9]/g, '')}`,
					task: { repo, base: first.parent, prompt: prompt.message.content, timeoutSec: 900, hiddenTests: { commit: solution.sha, paths }, acceptance: { command: local, timeoutSec: 600 } },
					budget: { perRunUsd: 2, perEvalUsd: 12 },
					runs: 3,
					configs: [{ name: 'baseline' }]
				}
			});
		}
	}
	return candidates;
}

// The test files that the check names, by path or by file name without its extension. None named: all of them, if the
// task is one commit with few test files.
function hiddenTestsOf(tests: string[], command: string, commits: number) {
	const named = tests.filter((path) => {
		const file = path.slice(path.lastIndexOf('/') + 1);
		return command.includes(path) || command.includes(file) || command.includes(file.replace(/\.[^.]+$/, ''));
	});
	if (named.length > 0) return named;
	return commits === 1 && tests.length <= MAX_UNNAMED_TESTS ? tests : [];
}

// The command of the last check of the task: the Bash call at `verifiedAt` that classify calls a check.
function verifyCommand(rows: Array<Record<string, any>>, at: string) {
	for (const row of rows) {
		if (row.type !== 'assistant' || row.timestamp !== at || !Array.isArray(row.message?.content)) continue;
		for (const block of row.message.content) {
			if (block?.type === 'tool_use' && classify(text(block.name), block.input ?? {}) === 'verify') return text(block.input?.command);
		}
	}
	return undefined;
}

export function realGit(exec: Exec = realExec): GitLookup {
	const run = async (dir: string, args: string[]) => {
		const result = await exec('git', args, { cwd: dir, env: { GIT_TERMINAL_PROMPT: '0' } });
		return result.code === 0 ? result.stdout : undefined;
	};
	return {
		isRepo: async (dir) => existsSync(dir) && (await run(dir, ['rev-parse', '--is-inside-work-tree']))?.trim() === 'true',
		commitsBetween: async (dir, since, until) =>
			((await run(dir, ['log', '--all', '--reverse', `--since=${since}`, `--until=${until}`, '--format=%H %P'])) ?? '')
				.split('\n')
				.filter(Boolean)
				.map((line) => {
					const [sha, parent] = line.split(' ');
					return { sha, parent };
				}),
		changedFiles: async (dir, from, to) => ((await run(dir, ['diff', '--name-only', '--diff-filter=AM', from, to])) ?? '').split('\n').filter(Boolean)
	};
}

async function main() {
	const argument = (flag: string) => {
		const index = process.argv.indexOf(flag);
		return index === -1 ? undefined : process.argv[index + 1];
	};
	const config = loadConfig();
	const days = Number(argument('--days') ?? 30);
	const projects = new RegExp(argument('--projects') ?? config.projects ?? '.');
	const out = resolve(argument('--out') ?? join(import.meta.dirname, 'out', 'candidates.json'));
	const root = process.env.EVAL_RUNNER_PROJECTS_DIR ?? join(homedir(), '.claude', 'projects');
	const cutoff = Date.now() - days * 86_400_000;
	const sessions: Array<{ id: string; entries: unknown[] }> = [];
	for (const project of readdirSync(root).filter((name) => projects.test(name))) {
		for (const file of listJsonl(join(root, project))) {
			if (statSync(file).mtimeMs < cutoff) continue;
			sessions.push({ id: file.slice(file.lastIndexOf('/') + 1, -'.jsonl'.length), entries: readLines(file) });
		}
	}
	// The runs of the eval runner are sessions too. Their clones live under the temp dir.
	const candidates = await findCandidates(sessions, realGit(), [join(tmpdir(), 'eval-runner'), join('/private', tmpdir(), 'eval-runner')]);
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, JSON.stringify(candidates, null, '\t'));
	const review = candidates.filter((candidate) => candidate.review).length;
	console.log(`${sessions.length} sessions read, ${candidates.length} candidates written to ${out} (${review} to review: the check names an absolute path).`);
	console.log('Accept a candidate: copy its "spec" into a spec file, set the configs, and check its prompt and acceptance command.');
}

if (import.meta.main) await main();
