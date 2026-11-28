import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildReport, renderReport } from './campaign-report.ts';
import type { ReportEval } from './campaign-report.ts';
import type { RunRecord } from './stats.ts';

const near = (actual: number, expected: number, tolerance: number) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

const run = (config: string, index: number, passed: boolean, extra: Partial<RunRecord> & { cost?: number; toolCalls?: number } = {}): RunRecord => {
	const { cost, toolCalls, ...rest } = extra;
	return {
		id: `${config}-${index}`,
		config,
		status: 'ok',
		acceptance: { exitCode: passed ? 0 : 1, passed, timedOut: false, durationMs: 1 },
		metrics: { cost, toolCalls } as RunRecord['metrics'],
		...rest
	};
};

// Three specs, six runs per config in each: the tested config passes 5, 4 and 4 of 6 (13 of 18), the reference 3, 2 and 2 (7 of 18).
const spec = (name: string, tested: number, reference: number, shift = 0): ReportEval => ({
	name,
	runs: [
		...Array.from({ length: 6 }, (_, index) => run('tested', index + 1, index < tested, { cost: 1 + shift + index * 0.01, toolCalls: 10 + shift * 10 + index })),
		...Array.from({ length: 6 }, (_, index) => run('base', index + 1, index < reference, { cost: 2 + shift + index * 0.01, toolCalls: 20 + shift * 10 + index }))
	]
});
const evals = [spec('one', 5, 3), spec('two', 4, 2, 5), spec('three', 4, 2, 10)];
const options = { reference: 'base', resamples: 1000, seed: 11 };

test('the pooled pass rate difference carries the Fisher p of the pooled counts', () => {
	const report = buildReport(evals, options);
	assert.deepEqual(report.configs.map((config) => config.name), ['tested']);
	const pooled = report.configs[0].pooled;
	assert.deepEqual([pooled.pass.config, pooled.pass.reference], [{ passed: 13, n: 18 }, { passed: 7, n: 18 }]);
	near(pooled.pass.p, 0.09, 0.01);
	near(pooled.pass.diff, 6 / 18, 1e-9);
	assert.ok(pooled.pass.ci[0] <= pooled.pass.diff && pooled.pass.diff <= pooled.pass.ci[1]);
	assert.deepEqual(pooled.n, { config: 18, reference: 18 });
});

test('each spec has its own cell, and the cost gap is clear in the pooled cell', () => {
	const report = buildReport(evals, options);
	const { perSpec, pooled } = report.configs[0];
	assert.deepEqual(Object.keys(perSpec), ['one', 'two', 'three']);
	assert.deepEqual(perSpec.one.pass.config, { passed: 5, n: 6 });
	// The cost of the tested config is 1 below the reference in every spec.
	near(pooled.metrics.cost.diff, -1, 1e-9);
	assert.ok(pooled.metrics.cost.p < 0.01, String(pooled.metrics.cost.p));
	assert.ok(pooled.metrics.cost.ci[1] < 0);
	assert.deepEqual(pooled.metrics.cost.n, { config: 18, reference: 18 });
	assert.ok(pooled.metrics.toolCalls.diff < 0);
});

test('a shift of the level between specs is no effect: the stratified p stays high when each spec shows none', () => {
	// The tested config sits low in the cheap spec and high in the dear one, and so does the reference.
	const flat: ReportEval[] = [
		{ name: 'cheap', runs: [...[1, 1.1, 0.9, 1].map((cost, index) => run('tested', index + 1, true, { cost })), ...[1, 1.1, 0.9, 1].map((cost, index) => run('base', index + 1, true, { cost }))] },
		{ name: 'dear', runs: [...[100, 110, 90, 100].map((cost, index) => run('tested', index + 1, true, { cost })), ...[100, 110, 90, 100].map((cost, index) => run('base', index + 1, true, { cost }))] }
	];
	const cell = buildReport(flat, options).configs[0].pooled;
	assert.equal(cell.metrics.cost.diff, 0);
	assert.ok(cell.metrics.cost.p > 0.9);
});

test('the same input and seed give the same report', () => {
	assert.deepEqual(buildReport(evals, options), buildReport(evals, options));
	assert.notDeepEqual(buildReport(evals, options).configs[0].pooled.metrics.cost.ci, buildReport(evals, { ...options, seed: 12 }).configs[0].pooled.metrics.cost.ci);
});

test('skipped and interrupted runs are no samples, and a run without a metric leaves it out with its n', () => {
	const data: ReportEval[] = [
		{
			name: 'one',
			runs: [run('tested', 1, true, { cost: 1, toolCalls: 5 }), run('tested', 2, false, { cost: 1.2 }), run('tested', 3, false, { status: 'interrupted' }), run('base', 1, false, { cost: 2, toolCalls: 9 }), run('base', 2, false, { status: 'skipped' })]
		}
	];
	const cell = buildReport(data, options).configs[0].pooled;
	assert.deepEqual(cell.n, { config: 2, reference: 1 });
	assert.deepEqual(cell.metrics.toolCalls.n, { config: 1, reference: 1 });
	assert.deepEqual(cell.metrics.cost.n, { config: 2, reference: 1 });
	// A metric that no run has is not in the cell.
	assert.equal(cell.metrics.turns, undefined);
});

test('grader findings per run: the mean count, with samples averaged over the ok samples, a permutation p and a CI', () => {
	const finding = { severity: 'important', summary: 'x' } as const;
	const graded = (config: string, index: number, count: number) => run(config, index, true, { cost: 1, grades: { review: { status: 'ok', findings: Array.from({ length: count }, () => finding), flagged: count > 0 } } });
	// Three samples, two ok: 4 findings over 2 ok samples is 2 per run.
	const sampled = run('tested', 9, true, { grades: { review: { status: 'ok', findings: Array.from({ length: 4 }, () => finding), flagged: true, samples: [{ status: 'ok', findings: 3 }, { status: 'ok', findings: 1 }, { status: 'error', findings: 0 }] } } });
	const data: ReportEval[] = [
		{ name: 'one', runs: [...[0, 0, 1, 1, 0, 0, 1, 0].map((count, index) => graded('tested', index + 1, count)), sampled, ...[3, 2, 4, 3, 2, 3, 3, 4, 2].map((count, index) => graded('base', index + 1, count))] }
	];
	const report = buildReport(data, options);
	const counts = report.configs[0].pooled.graders.review.findings!;
	near(counts.config, 5 / 9, 1e-9);
	near(counts.reference, 26 / 9, 1e-9);
	near(counts.diff, 5 / 9 - 26 / 9, 1e-9);
	assert.ok(counts.p < 0.01, String(counts.p));
	assert.ok(counts.ci[0] <= counts.diff && counts.diff <= counts.ci[1]);
	assert.match(renderReport(report), /grader review: findings per run \(mean\)\n {4}one +0\.56 vs +2\.89 +-2\.33 \[-3\.00, -1\.67\][^\n]*\n {4}pooled +0\.56 vs +2\.89 +-2\.33 \[/);
});

test('grader findings: the share of flagged runs, a Fisher p, and the runs for 80 % power', () => {
	const graded = (config: string, index: number, flagged: boolean) => run(config, index, true, { cost: 1, grades: { review: { status: 'ok', findings: flagged ? [{ severity: 'important', summary: 'x' }] : [], flagged } } });
	const data: ReportEval[] = [
		{ name: 'one', runs: [...Array.from({ length: 10 }, (_, index) => graded('tested', index + 1, index < 2)), ...Array.from({ length: 10 }, (_, index) => graded('base', index + 1, index < 8))] }
	];
	const cell = buildReport(data, options).configs[0].pooled;
	assert.deepEqual(cell.graders.review.config, { flagged: 2, n: 10 });
	assert.deepEqual(cell.graders.review.reference, { flagged: 8, n: 10 });
	near(cell.graders.review.p, 0.0230, 0.002);
	near(cell.graders.review.diff, -0.6, 1e-9);
	assert.ok(cell.graders.review.power! >= 5 && cell.graders.review.power! <= 14, String(cell.graders.review.power));
});

test('the power of the pass rate difference needs more runs for a smaller gap', () => {
	const cell = buildReport(evals, options).configs[0].pooled;
	// 72 % against 39 %: a gap of 0.33 needs well over the 18 runs per config of this campaign's worth of luck.
	assert.ok(typeof cell.pass.power === 'number' && cell.pass.power > 10 && cell.pass.power < 80, String(cell.pass.power));
});

test('an unknown reference is an error, and a config absent from the reference spec leaves its cell out', () => {
	assert.throws(() => buildReport(evals, { ...options, reference: 'ghost' }), /reference/);
	const partial: ReportEval[] = [spec('one', 5, 3), { name: 'two', runs: [run('tested', 1, true, { cost: 1 })] }];
	const report = buildReport(partial, options);
	assert.deepEqual(Object.keys(report.configs[0].perSpec), ['one']);
});

test('renderReport prints one block per config with the pooled line and a line per spec', () => {
	const text = renderReport(buildReport(evals, options));
	assert.match(text, /tested vs base/);
	assert.match(text, /pooled/);
	for (const name of ['one', 'two', 'three']) assert.match(text, new RegExp(`\\b${name}\\b`));
	assert.match(text, /13\/18/);
	assert.match(text, /p 0\.09/);
	assert.match(text, /power/i);
});
