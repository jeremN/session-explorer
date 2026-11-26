import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bootstrapCI, effect, fisherExact, mulberry32, permuteStrata, permutationTest, powerRuns, resampleStrata } from './inference.ts';
import type { Stratum } from './inference.ts';

const near = (actual: number, expected: number, tolerance: number) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

test('mulberry32 gives the same sequence for the same seed, in [0, 1)', () => {
	const one = mulberry32(7);
	const two = mulberry32(7);
	const first = Array.from({ length: 5 }, one);
	assert.deepEqual(first, Array.from({ length: 5 }, two));
	assert.notDeepEqual(first, Array.from({ length: 5 }, mulberry32(8)));
	for (const value of first) assert.ok(value >= 0 && value < 1);
});

test('Fisher exact: 13/18 against 7/18 gives p of about 0.09, two-sided', () => {
	near(fisherExact(13, 5, 7, 11), 0.09, 0.01);
});

test('Fisher exact: textbook tables', () => {
	// The lady tasting tea: 3 of 4 right against 1 of 4. Two-sided p = 0.4857.
	near(fisherExact(3, 1, 1, 3), 0.4857, 0.0001);
	// The example of the Wikipedia article: men and women who diet. Two-sided p = 0.002759.
	near(fisherExact(1, 9, 11, 3), 0.002759, 0.000001);
	// Symmetric tables and no difference.
	assert.equal(fisherExact(5, 5, 5, 5), 1);
	near(fisherExact(0, 6, 6, 0), 0.002165, 0.000001);
	// An empty margin leaves one table.
	assert.equal(fisherExact(0, 0, 3, 4), 1);
	assert.equal(fisherExact(0, 0, 0, 0), 1);
	assert.equal(fisherExact(18, 0, 18, 0), 1);
});

const strata = (...pairs: [number[], number[]][]): Stratum[] => pairs.map(([a, b]) => ({ a, b }));

test('effect: the mean and the median difference of one stratum', () => {
	assert.equal(effect(strata([[2, 4, 6], [1, 2, 3]]), 'mean'), 2);
	assert.equal(effect(strata([[1, 9, 10], [1, 2, 30]]), 'median'), 7);
});

test('effect: a stratum weighs by its sample sizes, and an empty arm drops the stratum', () => {
	// Equal sizes: the plain average of the differences (1 and 3).
	assert.equal(effect(strata([[1], [0]], [[3], [0]]), 'mean'), 2);
	// A stratum without reference runs has no difference.
	assert.equal(effect(strata([[5, 5], [0, 0]], [[100], []]), 'mean'), 5);
	assert.equal(effect(strata([[1], []]), 'mean'), undefined);
});

test('permutation shuffles labels inside each stratum and never across strata', () => {
	const input = strata([[1, 2], [3, 4]], [[101, 102, 103], [104, 105]]);
	const rand = mulberry32(3);
	for (let round = 0; round < 50; round++) {
		const shuffled = permuteStrata(input, rand);
		assert.deepEqual(shuffled.map((stratum) => [stratum.a.length, stratum.b.length]), [[2, 2], [3, 2]]);
		assert.deepEqual([...shuffled[0].a, ...shuffled[0].b].sort((x, y) => x - y), [1, 2, 3, 4]);
		assert.deepEqual([...shuffled[1].a, ...shuffled[1].b].sort((x, y) => x - y), [101, 102, 103, 104, 105]);
	}
});

test('the bootstrap resamples inside each arm of each stratum', () => {
	const input = strata([[1, 2], [3, 4]], [[101, 102, 103], [104, 105]]);
	const rand = mulberry32(5);
	for (let round = 0; round < 50; round++) {
		const drawn = resampleStrata(input, rand);
		assert.deepEqual(drawn.map((stratum) => [stratum.a.length, stratum.b.length]), [[2, 2], [3, 2]]);
		for (const [index, stratum] of drawn.entries()) {
			for (const value of stratum.a) assert.ok(input[index].a.includes(value));
			for (const value of stratum.b) assert.ok(input[index].b.includes(value));
		}
	}
});

test('permutation test: identical groups give p of 1, separated groups give a small p', () => {
	const same = permutationTest(strata([[1, 2, 3, 4], [1, 2, 3, 4]]), { stat: 'mean', resamples: 2000, seed: 1 });
	assert.equal(same.diff, 0);
	assert.ok(same.p > 0.95);
	const apart = permutationTest(strata([[10, 11, 12, 13, 14, 15], [1, 2, 3, 4, 5, 6]]), { stat: 'mean', resamples: 5000, seed: 1 });
	assert.ok(apart.p < 0.01, String(apart.p));
	assert.equal(apart.diff, 9);
});

test('permutation test: a difference that sits between the strata is not an effect', () => {
	// Each stratum has the same values in both arms. A test that ignores the strata would see a gap.
	const confounded = strata([[1, 1, 1, 1, 1], [1]], [[100], [100, 100, 100, 100, 100]]);
	const result = permutationTest(confounded, { stat: 'mean', resamples: 2000, seed: 1 });
	assert.equal(result.diff, 0);
	assert.ok(result.p > 0.95);
});

test('bootstrap CI contains the point estimate, and the same seed gives the same CI', () => {
	const input = strata([[3.1, 2.7, 4.2, 3.9, 5.0, 3.3], [2.0, 2.4, 1.9, 2.8, 3.0, 2.2]], [[1.1, 0.9, 1.4, 1.0], [0.6, 0.8, 0.7, 0.9]]);
	for (const stat of ['mean', 'median'] as const) {
		const ci = bootstrapCI(input, { stat, resamples: 2000, seed: 9 });
		assert.ok(ci.low <= ci.diff && ci.diff <= ci.high, `${stat}: ${ci.low} ${ci.diff} ${ci.high}`);
		assert.ok(ci.low > 0, 'the gap is clear, so the CI stays above 0');
		assert.deepEqual(ci, bootstrapCI(input, { stat, resamples: 2000, seed: 9 }));
	}
});

test('bootstrap CI of identical groups spans zero', () => {
	const ci = bootstrapCI(strata([[1, 2, 3, 4, 5], [1, 2, 3, 4, 5]]), { stat: 'mean', resamples: 2000, seed: 2 });
	assert.ok(ci.low < 0 && ci.high > 0);
});

test('power: a larger gap needs fewer runs, no gap needs none that suffice', () => {
	const big = powerRuns(0.9, 0.3, { seed: 1 });
	const small = powerRuns(0.7, 0.5, { seed: 1 });
	assert.ok(typeof big === 'number' && typeof small === 'number');
	assert.ok(big < small, `${big} < ${small}`);
	// 0.9 against 0.3 needs about 10 runs per arm at 80 % power.
	assert.ok(big >= 6 && big <= 16, String(big));
	assert.equal(powerRuns(0.5, 0.5, { seed: 1 }), undefined);
	assert.equal(powerRuns(0.5, 0.52, { seed: 1, maxRuns: 50 }), undefined);
	assert.equal(powerRuns(0.9, 0.3, { seed: 1 }), powerRuns(0.9, 0.3, { seed: 1 }));
});
