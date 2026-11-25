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

test('aggregate counts the graded runs, the runs with findings and the findings by severity, per config and grader', () => {
	const finding = (severity: string) => ({ severity, summary: 'x' });
	const runs: RunRecord[] = [
		{ ...run('a', 'ok', 1, true), grades: { review: { status: 'ok', findings: [finding('important'), finding('minor')] }, rules: { status: 'ok', findings: [] } } },
		{ ...run('a', 'ok', 1, true), grades: { review: { status: 'ok', findings: [finding('minor')] }, rules: { status: 'ok', findings: [finding('minor')] } } },
		// An error grade is not a sample: its findings do not count.
		{ ...run('a', 'timeout', 1, false), grades: { review: { status: 'error', findings: [finding('important')], note: 'exit code 1' } } },
		{ ...run('b', 'ok', 1, true), grades: { review: { status: 'ok', findings: [] } } },
		{ ...run('b', 'error', 1, false), grades: { review: { status: 'skipped', findings: [], note: 'run status error' } } },
		run('c', 'ok', 1, true)
	];
	const result = aggregate(runs, ['a', 'b', 'c']);
	assert.deepEqual(result.a.grades, {
		review: { graded: 2, withFindings: 2, findings: 3, bySeverity: { important: 1, minor: 2 } },
		rules: { graded: 2, withFindings: 1, findings: 1, bySeverity: { minor: 1 } }
	});
	assert.deepEqual(result.b.grades, { review: { graded: 1, withFindings: 0, findings: 0, bySeverity: {} } });
	// A config with no grade keeps the shape it had before graders existed.
	assert.equal('grades' in result.c, false);
});

test('a grade with flagged counts as a run with findings by its flag; an old grade without flagged counts by its findings', () => {
	const finding = { severity: 'minor', summary: 'x' };
	const runs: RunRecord[] = [
		// Majority merge: one sample of three found something, so the run is not flagged. Its finding still counts.
		{ ...run('a', 'ok', 1, true), grades: { review: { status: 'ok', findings: [{ ...finding, sample: 0 }], flagged: false } } },
		{ ...run('a', 'ok', 1, true), grades: { review: { status: 'ok', findings: [{ ...finding, sample: 1 }, { ...finding, sample: 2 }], flagged: true } } },
		{ ...run('a', 'ok', 1, true), grades: { review: { status: 'ok', findings: [finding] } } },
		{ ...run('a', 'ok', 1, true), grades: { review: { status: 'ok', findings: [] } } }
	];
	assert.deepEqual(aggregate(runs, ['a']).a.grades, { review: { graded: 4, withFindings: 2, findings: 4, bySeverity: { minor: 4 } } });
});
