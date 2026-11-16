import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { realExec } from './exec.ts';
import { findCandidates, realGit } from './mine.ts';
import type { GitLookup } from './mine.ts';

const REPO = '/work/shop';
const at = (minute: number) => `2026-10-05T08:${String(minute).padStart(2, '0')}:00.000Z`;
const prompt = (minute: number, content: string, cwd = REPO) => ({ type: 'user', timestamp: at(minute), cwd, message: { content } });
const edit = (minute: number) => ({ type: 'assistant', timestamp: at(minute), message: { content: [{ type: 'tool_use', id: `e${minute}`, name: 'Edit', input: { file_path: `${REPO}/src/cart.ts` } }] } });
const check = (minute: number, command: string, output: string, isError = false) => [
	{ type: 'assistant', timestamp: at(minute), message: { content: [{ type: 'tool_use', id: `c${minute}`, name: 'Bash', input: { command } }] } },
	{ type: 'user', timestamp: at(minute), message: { content: [{ type: 'tool_result', tool_use_id: `c${minute}`, is_error: isError, content: output }] } }
];

// A repository with one commit made during the first task: it changes a source file and a test file.
const fakeGit = (overrides: Partial<GitLookup> = {}): GitLookup => ({
	isRepo: async (dir) => dir === REPO,
	commitsBetween: async (_dir, since) => (since === at(0) ? [{ sha: 'sol1', parent: 'base0' }] : []),
	changedFiles: async () => ['src/cart.ts', 'src/cart.test.ts'],
	...overrides
});

test('a task with a passing check and a commit becomes a candidate with its base, prompt, hidden tests and check', async () => {
	const entries = [prompt(0, 'Fix the cart total'), edit(1), ...check(2, `cd ${REPO} && pnpm test`, 'Tests 3 passed (3)'), prompt(20, 'thanks')];
	const [candidate, ...rest] = await findCandidates([{ id: 'abcdef1234', entries }], fakeGit());
	assert.equal(rest.length, 0);
	assert.equal(candidate.review, false);
	assert.deepEqual(candidate.spec.task, {
		repo: REPO,
		base: 'base0',
		prompt: 'Fix the cart total',
		timeoutSec: 900,
		hiddenTests: { commit: 'sol1', paths: ['src/cart.test.ts'] },
		acceptance: { command: 'cd . && pnpm test', timeoutSec: 600 }
	});
	assert.equal(candidate.spec.name, 'abcdef12-202610050800');
});

test('a task is not a candidate when its check failed, it has no check, no commit, no test file, or no repository', async () => {
	const failed = [prompt(0, 'a'), edit(1), ...check(2, 'pnpm test', 'Exit code 1\nFAIL src/cart.test.ts', true)];
	const unchecked = [prompt(0, 'a'), edit(1)];
	const passing = [prompt(0, 'a'), edit(1), ...check(2, 'pnpm test', 'ok')];
	assert.deepEqual(await findCandidates([{ id: 's1', entries: failed }], fakeGit()), []);
	assert.deepEqual(await findCandidates([{ id: 's2', entries: unchecked }], fakeGit()), []);
	assert.deepEqual(await findCandidates([{ id: 's3', entries: passing }], fakeGit({ commitsBetween: async () => [] })), []);
	assert.deepEqual(await findCandidates([{ id: 's4', entries: passing }], fakeGit({ changedFiles: async () => ['src/cart.ts'] })), []);
	assert.deepEqual(await findCandidates([{ id: 's5', entries: passing }], fakeGit({ isRepo: async () => false })), []);
});

test('a session of the eval runner itself is skipped, and a check with an absolute path is marked for review', async () => {
	const runner = [prompt(0, 'a', '/tmp/eval-runner/e1/baseline-1'), edit(1), ...check(2, 'pnpm test', 'ok')];
	assert.deepEqual(await findCandidates([{ id: 'r1', entries: runner }], fakeGit({ isRepo: async () => true }), ['/tmp/eval-runner']), []);
	const absolute = [prompt(0, 'a'), edit(1), ...check(2, 'node --test /home/me/other/a.test.ts', 'ok')];
	const [candidate] = await findCandidates([{ id: 'r2', entries: absolute }], fakeGit());
	assert.equal(candidate.review, true);
});

test('realGit finds the commits of a time window on every branch, and the files they add or change', async () => {
	const root = mkdtempSync(join(tmpdir(), 'eval-mine-'));
	try {
		const git = async (...args: string[]) => {
			const result = await realExec('git', args, { cwd: root, env: { GIT_COMMITTER_DATE: process.env.DATE ?? '' } });
			assert.equal(result.code, 0, result.stderr);
			return result.stdout.trim();
		};
		const commit = async (date: string, message: string) => {
			const result = await realExec('git', ['commit', '-q', '-m', message], { cwd: root, env: { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } });
			assert.equal(result.code, 0, result.stderr);
		};
		await git('init', '-q', '-b', 'main');
		await git('config', 'user.email', 'test@localhost');
		await git('config', 'user.name', 'test');
		writeFileSync(join(root, 'a.ts'), 'one\n');
		await git('add', '-A');
		await commit('2026-10-05T07:00:00Z', 'before');
		const base = await git('rev-parse', 'HEAD');
		await git('checkout', '-q', '-b', 'feature');
		mkdirSync(join(root, 'test'));
		writeFileSync(join(root, 'test', 'a.test.ts'), 'test\n');
		writeFileSync(join(root, 'a.ts'), 'two\n');
		await git('add', '-A');
		await commit('2026-10-05T08:05:00Z', 'during');
		const during = await git('rev-parse', 'HEAD');
		await git('checkout', '-q', 'main');

		const lookup = realGit();
		assert.equal(await lookup.isRepo(root), true);
		assert.equal(await lookup.isRepo(join(root, 'missing')), false);
		assert.deepEqual(await lookup.commitsBetween(root, '2026-10-05T08:00:00Z', '2026-10-05T09:00:00Z'), [{ sha: during, parent: base }]);
		assert.deepEqual((await lookup.changedFiles(root, base, during)).sort(), ['a.ts', 'test/a.test.ts']);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
