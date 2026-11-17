import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildMatrix, propose, readMatrixRoutes, renderMarkdown } from './matrix.ts';
import type { SavedEval } from './matrix.ts';
import type { RunRecord } from './stats.ts';

const run = (id: string, config: string, passed: boolean, cost?: number, extra: Partial<RunRecord> = {}): RunRecord => ({
	id,
	config,
	status: 'ok',
	acceptance: { exitCode: passed ? 0 : 1, passed, timedOut: false, durationMs: 1 },
	wallSec: 10,
	...(cost === undefined ? {} : { metrics: { cost } as RunRecord['metrics'] }),
	...extra
});
const evalOf = (id: string, prompt: string, category: string | undefined, configs: SavedEval['spec']['configs'], runs: RunRecord[]): SavedEval => ({
	id,
	baseSha: 'abc',
	spec: { name: id, task: { prompt, acceptance: { command: 'npm test' }, ...(category ? { category } : {}) }, configs },
	runs
});
const CONFIGS = [
	{ name: 'sonnet', model: 'sonnet' },
	{ name: 'codex', agent: 'codex' as const, model: 'gpt-x' },
	{ name: 'terse', model: 'sonnet', claudeMd: { text: 'Be terse.' } }
];

test('buildMatrix groups by category and route, skips cached copies, errors and instruction experiments', () => {
	const first = evalOf('e1', 'Fix A.', 'fast', CONFIGS, [run('sonnet-1', 'sonnet', true, 0.1), run('codex-1', 'codex', false, 0.2), run('terse-1', 'terse', true, 0.05), run('codex-2', 'codex', false, undefined, { status: 'error' })]);
	// e2 reuses sonnet-1 of e1 from the cache: it counts once.
	const second = evalOf('e2', 'Fix A.', undefined, CONFIGS, [run('sonnet-1', 'sonnet', true, 0.1, { cached: { evalId: 'e1', id: 'sonnet-1' } }), run('sonnet-2', 'sonnet', true, 0.3)]);
	const matrix = buildMatrix([second, first]);
	assert.deepEqual(matrix.excluded, { errors: 1, experiments: 1 });
	assert.equal(matrix.tasks.length, 1);
	assert.equal(matrix.tasks[0].category, 'fast');
	assert.equal(matrix.tasks[0].discriminating, true);
	const [row] = matrix.categories;
	assert.deepEqual(row.routes.map((route) => [route.route, route.passed, route.n, route.cost]), [['claude/sonnet', 2, 2, 0.2], ['codex/gpt-x', 0, 1, 0.2]]);
});

test('a task that every route passes, or every route fails, tells no route apart', () => {
	const all = evalOf('e3', 'Fix B.', 'fast', CONFIGS, [run('sonnet-1', 'sonnet', true), run('codex-1', 'codex', true)]);
	const none = evalOf('e4', 'Fix C.', 'fast', CONFIGS, [run('sonnet-1', 'sonnet', false), run('codex-1', 'codex', false)]);
	const one = evalOf('e5', 'Fix D.', 'fast', CONFIGS, [run('sonnet-1', 'sonnet', true)]);
	const matrix = buildMatrix([all, none, one]);
	assert.deepEqual(matrix.tasks.map((task) => task.discriminating), [false, false, false]);
	assert.equal(matrix.categories[0].discriminating, 0);
	assert.match(renderMarkdown(matrix), /Tasks that tell no route apart[\s\S]*e3[\s\S]*e4/);
});

test('excluded runs are left out', () => {
	const ev = evalOf('e6', 'Fix E.', 'fast', CONFIGS, [run('sonnet-1', 'sonnet', false), run('sonnet-2', 'sonnet', true)]);
	assert.equal(buildMatrix([ev], {}, new Set(['e6/sonnet-1'])).categories[0].routes[0].n, 1);
});

test('propose: the cheapest route within one run of the best rate, never before 3 runs', () => {
	assert.equal(propose([{ route: 'a', passed: 2, n: 2, cost: 0.1, tasks: 1 }], 1).route, null);
	const pick = propose(
		[
			{ route: 'strong', passed: 5, n: 5, cost: 0.5, tasks: 2 },
			{ route: 'cheap', passed: 4, n: 5, cost: 0.01, tasks: 2 },
			{ route: 'bad', passed: 2, n: 5, cost: 0.001, tasks: 2 },
			{ route: 'unpriced', passed: 5, n: 5, tasks: 2 }
		],
		2
	);
	assert.equal(pick.route, 'cheap');
	assert.match(propose([{ route: 'a', passed: 3, n: 3, cost: 0.1, tasks: 1 }], 0).reason, /cost decides alone/);
});

test('readMatrixRoutes reads the Claude model of each class', () => {
	const text = '| Class | Use | Claude model | Codex |\n|---|---|---|---|\n| strong | Plan | `opus` | default |\n| fast | Edit | `haiku` | none |\n';
	assert.deepEqual(readMatrixRoutes(text), { strong: 'claude/opus', fast: 'claude/haiku' });
});
