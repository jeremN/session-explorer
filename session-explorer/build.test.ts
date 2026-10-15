import assert from 'node:assert/strict';
import { test } from 'node:test';

import { allowedHost, priceEvents, resolveRequest, summarizeSession } from './build.ts';
import type { SessionEvent } from './parse.ts';

const RATES = { 'model-a': { input: 1, output: 5 } };
const llm = (ta: number, model: string, fresh: number, out: number, cr = 0): SessionEvent => ({
	t: '2026-10-05T08:00:00.000Z',
	ta,
	kind: 'llm',
	agent: 0,
	model,
	tok: { fresh, cw5m: 0, cw1h: 0, out, cr }
});
const tool = (ta: number, kind: SessionEvent['kind']): SessionEvent => ({ t: '2026-10-05T08:00:00.000Z', ta, kind, agent: 0 });

test('priceEvents sets a cost on llm events only, null for an unknown model', () => {
	const priced = priceEvents([llm(0, 'model-a', 1_000_000, 0), llm(1, 'opus', 1000, 10), tool(2, 'tool')], RATES);
	assert.deepEqual(
		priced.map((event) => event.cost),
		[1, null, undefined]
	);
});

test('summarizeSession: one index row', () => {
	const events = [
		tool(0, 'prompt'),
		{ ...llm(10, 'model-a', 1000, 200, 3000), cost: 1.234 },
		tool(20, 'error'),
		{ ...llm(30, 'opus', 0, 100, 0), cost: null },
		tool(90.4, 'edit')
	];
	const parsed = { title: 'Fix the cart', start: '2026-10-05T08:00:00.000Z', branch: 'feat-1/x', agents: [{ id: 'a1', name: 'Explore' }], events };
	const span = { start: '', end: '', memory: false, editAt: '' };
	const tasks = [
		{ ...span, brain: 'before' as const },
		{ ...span, brain: 'never' as const },
		{ ...span, brain: 'never' as const }
	];
	assert.deepEqual(summarizeSession('abc', 'proj', parsed, tasks), {
		id: 'abc',
		project: 'proj',
		branch: 'feat-1/x',
		title: 'Fix the cart',
		start: '2026-10-05T08:00:00.000Z',
		activeSec: 90,
		events: 5,
		llmRequests: 2,
		cost: 1.23,
		unpricedRequests: 1,
		billedTokens: 1300,
		cacheReadShare: 0.75,
		errors: 1,
		subagents: 1,
		tasks: { before: 1, after: 0, never: 2 },
		mrs: []
	});
});

test('summarizeSession: no llm request gives zero cost and zero cache share', () => {
	const parsed = { title: 't', start: 's', agents: [], events: [tool(0, 'prompt')] };
	const row = summarizeSession('abc', 'proj', parsed, []);
	assert.deepEqual([row.cost, row.cacheReadShare, row.llmRequests, row.branch], [0, 0, 0, undefined]);
});

test('resolveRequest maps the two roots and refuses a path outside them', () => {
	assert.equal(resolveRequest('/', '/app/viewer', '/app/out'), '/app/viewer/index.html');
	assert.equal(resolveRequest('/adapt.mjs?v=2', '/app/viewer', '/app/out'), '/app/viewer/adapt.mjs');
	assert.equal(resolveRequest('/data/sessions/abc.json', '/app/viewer', '/app/out'), '/app/out/sessions/abc.json');
	assert.equal(resolveRequest('/data/..%2F..%2Fsettings.json', '/app/viewer', '/app/out'), undefined);
	assert.equal(resolveRequest('/..%2Fbuild.ts', '/app/viewer', '/app/out'), undefined);
	assert.equal(resolveRequest('/%E0%A4%A', '/app/viewer', '/app/out'), undefined);
});

test('allowedHost accepts only the loopback names with the served port', () => {
	assert.equal(allowedHost('127.0.0.1:4173', 4173), true);
	assert.equal(allowedHost('localhost:4173', 4173), true);
	assert.equal(allowedHost('evil.example:4173', 4173), false);
	assert.equal(allowedHost('127.0.0.1:9999', 4173), false);
	assert.equal(allowedHost('127.0.0.1', 4173), false);
	assert.equal(allowedHost(undefined, 4173), false);
});
