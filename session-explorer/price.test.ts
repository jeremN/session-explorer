import assert from 'node:assert/strict';
import { test } from 'node:test';

import { costOf, modelKey } from './price.ts';

const RATES = { 'model-a': { input: 1, output: 5 } };

test('modelKey removes the context suffix and the release date', () => {
	assert.equal(modelKey('claude-opus-5-5[1m]'), 'claude-opus-5-5');
	assert.equal(modelKey('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
	assert.equal(modelKey('claude-opus-5-5'), 'claude-opus-5-5');
});

test('costOf prices each token class at its own rate', () => {
	// 1000 x 1 + 2000 x 1.25 + 4000 x 2 + 500 x 5 + 10000 x 0.1 = 15000 millionths of a dollar
	assert.equal(costOf('model-a', { fresh: 1000, cw5m: 2000, cw1h: 4000, out: 500, cr: 10000 }, RATES), 0.015);
});

test('costOf: the one-hour cache write costs more than the five-minute one', () => {
	assert.equal(costOf('model-a', { fresh: 0, cw5m: 1_000_000, cw1h: 0, out: 0, cr: 0 }, RATES), 1.25);
	assert.equal(costOf('model-a', { fresh: 0, cw5m: 0, cw1h: 1_000_000, out: 0, cr: 0 }, RATES), 2);
});

test('costOf returns null for a model without a rate', () => {
	assert.equal(costOf('opus', { fresh: 1000, cw5m: 0, cw1h: 0, out: 10, cr: 0 }, RATES), null);
	assert.equal(costOf('<synthetic>', { fresh: 0, cw5m: 0, cw1h: 0, out: 0, cr: 0 }, RATES), null);
});

test('costOf finds the rate through modelKey', () => {
	assert.equal(costOf('model-a[1m]', { fresh: 1_000_000, cw5m: 0, cw1h: 0, out: 0, cr: 0 }, RATES), 1);
});

test('costOf uses the cache read multiplier of the model when the rate sets one', () => {
	// 1 000 000 cache read tokens x 4 dollars x 0.05 = 0.2 dollar
	const rates = { 'model-b': { input: 4, output: 20, cacheRead: 0.05 } };
	assert.equal(costOf('model-b', { fresh: 0, cw5m: 0, cw1h: 0, out: 0, cr: 1_000_000 }, rates), 0.2);
});
