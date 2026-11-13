import assert from 'node:assert/strict';
import { test } from 'node:test';

import { aggregate, median, passRate, spread } from './stats.ts';
import type { RunRecord } from './stats.ts';

const run = (config: string, status: RunRecord['status'], cost: number, passed: boolean): RunRecord => ({
	id: `${config}-x`,
	config,
	status,
	acceptance: { exitCode: passed ? 0 : 1, passed, timedOut: false, durationMs: 10 },
	wallSec: cost * 100,
	diff: { files: 1, added: 3, deleted: 1 },
	metrics: {
		cost,
		billedTokens: 1000,
		cacheReadShare: 0.5,
		errors: 1,
		denials: 0,
		verified: 1,
		failed: 0,
		loops: 0,
		retries: 0,
		subagentCost: 0
	}
});

test('median of an odd and an even count', () => {
	assert.equal(median([5, 1, 3]), 3);
	assert.equal(median([4, 1, 3, 2]), 2.5);
	assert.equal(median([7]), 7);
});

test('spread gives n, median, min, max and the values in run order', () => {
	assert.deepEqual(spread([0.9, 0.5, 0.7]), { n: 3, median: 0.7, min: 0.5, max: 0.9, values: [0.9, 0.5, 0.7] });
	assert.deepEqual(spread([4, 1, 3, 2]), { n: 4, median: 2.5, min: 1, max: 4, values: [4, 1, 3, 2] });
	assert.equal(spread([]), undefined);
});

test('passRate counts k of n and leaves skipped runs out of n', () => {
	const runs = [run('a', 'ok', 1, true), run('a', 'timeout', 1, false), run('a', 'ok', 1, true), { ...run('a', 'skipped', 0, false), metrics: undefined }];
	assert.deepEqual(passRate(runs), { passed: 2, n: 3 });
});

test('aggregate groups by config, counts timeout and budget runs, ignores skipped runs', () => {
	const runs = [
		run('a', 'ok', 0.5, true),
		run('b', 'ok', 0.4, true),
		run('a', 'budget', 0.9, false),
		run('b', 'ok', 0.6, true),
		{ ...run('a', 'skipped', 0, false), metrics: undefined }
	];
	const result = aggregate(runs, ['a', 'b']);
	assert.deepEqual(result.a.pass, { passed: 1, n: 2 });
	assert.deepEqual(result.b.pass, { passed: 2, n: 2 });
	assert.equal(result.a.metrics.cost?.median, 0.7);
	assert.deepEqual(result.a.metrics.cost?.values, [0.5, 0.9]);
	assert.equal(result.b.metrics.cost?.min, 0.4);
	assert.equal(result.a.metrics.lines?.median, 4);
	assert.equal(result.a.metrics.wallSec?.n, 2);
});

test('aggregate of a config with only skipped runs has n 0 and no metric', () => {
	const result = aggregate([{ ...run('a', 'skipped', 0, false), metrics: undefined }], ['a']);
	assert.deepEqual(result.a, { pass: { passed: 0, n: 0 }, metrics: {} });
});
