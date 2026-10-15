import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decide } from './decide.ts';

// model-a: input 1 dollar for one million tokens. Cache read 0.1, 1-hour write 2, 5-minute write 1.25.
const RATES = { 'model-a': { input: 1, output: 5 } };
const START = Date.UTC(2026, 9, 5, 8, 0, 0);
const at = (second: number) => new Date(START + second * 1000).toISOString();
type Usage = { read?: number; write1h?: number; write5m?: number; output?: number };
const request = (second: number, id: string, { read = 0, write1h = 0, write5m = 0, output = 0 }: Usage, extra: object = {}) => ({
	type: 'assistant',
	timestamp: at(second),
	message: {
		id,
		model: 'model-a',
		usage: {
			input_tokens: 0,
			output_tokens: output,
			cache_read_input_tokens: read,
			cache_creation_input_tokens: write1h + write5m,
			cache_creation: { ephemeral_1h_input_tokens: write1h, ephemeral_5m_input_tokens: write5m }
		}
	},
	...extra
});
const now = (second: number) => START + second * 1000;
const round = (value: number | null) => (value === null ? null : Math.round(value * 1e6) / 1e6);

test('a prompt one hour after the last request of a large context finds a cold cache', () => {
	const rows = [request(0, 'm1', { read: 190_000, write1h: 9000, output: 1000 })];
	const found = decide(rows, now(3600), RATES);
	// Context 200 000. Cold: 200 000 x 2 = 0.4. Warm: 200 000 x 0.1 = 0.02.
	assert.deepEqual(found && { ...found, overWarm: round(found.overWarm) }, {
		lastRequest: at(0),
		pauseSec: 3600,
		contextTokens: 200_000,
		ttlSec: 3600,
		model: 'model-a',
		overWarm: 0.38
	});
});

test('one second before the cache lifetime, the cache is warm', () => {
	const rows = [request(0, 'm1', { read: 190_000, write1h: 10_000 })];
	assert.equal(decide(rows, now(3599), RATES), null);
});

test('a 5-minute cache write gives a lifetime of 300 seconds and the 5-minute write price', () => {
	const rows = [request(0, 'm1', { read: 190_000, write5m: 10_000 })];
	assert.equal(decide(rows, now(299), RATES), null);
	const found = decide(rows, now(300), RATES);
	assert.equal(found?.ttlSec, 300);
	// 200 000 x 1.25 = 0.25, minus 0.02.
	assert.equal(round(found?.overWarm ?? null), 0.23);
});

test('a request that only reads the cache keeps the lifetime of the last write', () => {
	const rows = [request(0, 'm1', { write5m: 150_000 }), request(10, 'm2', { read: 150_000 })];
	assert.equal(decide(rows, now(310), RATES)?.ttlSec, 300);
});

test('under 100 000 tokens of context, no warning', () => {
	const rows = [request(0, 'm1', { read: 99_999 })];
	assert.equal(decide(rows, now(7200), RATES), null);
	assert.equal(decide([request(0, 'm1', { read: 100_000 })], now(7200), RATES)?.contextTokens, 100_000);
});

test('the rows of one response repeat the usage: the last row counts, one time', () => {
	const rows = [request(0, 'm1', { read: 150_000, output: 10 }), request(1, 'm1', { read: 150_000, output: 5000 })];
	const found = decide(rows, now(3601), RATES);
	assert.equal(found?.contextTokens, 155_000);
	assert.equal(found?.pauseSec, 3600);
});

test('after a compaction the large context is gone: no warning', () => {
	const rows = [request(0, 'm1', { read: 300_000, write1h: 1 }), { type: 'system', subtype: 'compact_boundary', timestamp: at(5) }];
	assert.equal(decide(rows, now(7200), RATES), null);
});

test('subagent rows and synthetic rows are not requests of the session', () => {
	const rows = [
		request(0, 'm1', { read: 50_000, write1h: 1 }),
		request(10, 'm2', { read: 300_000 }, { isSidechain: true }),
		{ type: 'assistant', timestamp: at(20), message: { id: 'm3', model: '<synthetic>', usage: { input_tokens: 400_000 } } }
	];
	assert.equal(decide(rows, now(7200), RATES), null);
});

test('a model without a price gives the warning with no dollar amount', () => {
	const rows = [request(0, 'm1', { read: 200_000, write1h: 1 })];
	assert.equal(decide(rows, now(3600), {})?.overWarm, null);
});

test('no request in the transcript: no warning', () => {
	assert.equal(decide([], now(0), RATES), null);
	assert.equal(decide([{ type: 'user', timestamp: at(0), message: { content: 'x' } }], now(9999), RATES), null);
});
