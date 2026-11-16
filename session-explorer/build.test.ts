import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
		{ ...tool(40, 'error'), refusal: 'user' as const },
		{ ...tool(50, 'error'), refusal: 'system' as const },
		tool(60, 'interrupt'),
		tool(90.4, 'edit')
	];
	const parsed = { title: 'Fix the cart', start: '2026-10-05T08:00:00.000Z', branch: 'feat-1/x', agents: [{ id: 'a1', name: 'Explore' }], events };
	const span = { start: '', end: '', memory: false, editAt: '' };
	const tasks = [
		{ ...span, brain: 'before' as const, verified: true },
		{ ...span, brain: 'never' as const, verified: false },
		{ ...span, brain: 'never' as const, verified: true, check: 'failed' as const }
	];
	assert.deepEqual(summarizeSession('abc', 'proj', parsed, tasks), {
		id: 'abc',
		project: 'proj',
		branch: 'feat-1/x',
		title: 'Fix the cart',
		start: '2026-10-05T08:00:00.000Z',
		activeSec: 90,
		events: 8,
		llmRequests: 2,
		cost: 1.23,
		unpricedRequests: 1,
		billedTokens: 1300,
		cacheReadShare: 0.75,
		errors: 3,
		interrupts: 1,
		refusals: 1,
		denials: 1,
		outages: 0,
		subagents: 1,
		tasks: { before: 1, after: 0, never: 2, verified: 2, failed: 1 },
		mrs: []
	});
});

test('summarizeSession: no llm request gives zero cost and zero cache share', () => {
	const parsed = { title: 't', start: 's', agents: [], events: [tool(0, 'prompt')] };
	const row = summarizeSession('abc', 'proj', parsed, []);
	assert.deepEqual([row.cost, row.cacheReadShare, row.llmRequests, row.branch], [0, 0, 0, undefined]);
});

test('resolveRequest maps the three roots and refuses a path outside them', () => {
	const at = (url: string) => resolveRequest(url, '/app/viewer', '/app/out', '/app/evals');
	assert.equal(at('/'), '/app/viewer/index.html');
	assert.equal(at('/adapt.mjs?v=2'), '/app/viewer/adapt.mjs');
	assert.equal(at('/data/sessions/abc.json'), '/app/out/sessions/abc.json');
	assert.equal(at('/data/..%2F..%2Fsettings.json'), undefined);
	assert.equal(at('/..%2Fbuild.ts'), undefined);
	assert.equal(at('/%E0%A4%A'), undefined);
	assert.equal(at('/evals/a/eval.json'), '/app/evals/a/eval.json');
	assert.equal(at('/evals/index.json'), '/app/evals/index.json');
	assert.equal(at('/evals/../x'), undefined);
	assert.equal(at('/evals/%2e%2e/x'), undefined);
	assert.equal(at('/evals/..%2Fout%2Findex.json'), undefined);
});

test('allowedHost accepts only the loopback names with the served port', () => {
	assert.equal(allowedHost('127.0.0.1:4173', 4173), true);
	assert.equal(allowedHost('localhost:4173', 4173), true);
	assert.equal(allowedHost('evil.example:4173', 4173), false);
	assert.equal(allowedHost('127.0.0.1:9999', 4173), false);
	assert.equal(allowedHost('127.0.0.1', 4173), false);
	assert.equal(allowedHost(undefined, 4173), false);
});

test('resolveRequest refuses a symlink that leaves its root, in every root', () => {
	const base = mkdtempSync(join(tmpdir(), 'resolve-'));
	try {
		const [viewer, out, evals, secret] = ['viewer', 'out', 'evals', 'secret'].map((name) => join(base, name));
		for (const dir of [viewer, out, evals, secret]) mkdirSync(dir);
		writeFileSync(join(secret, 'x.json'), '{}');
		writeFileSync(join(evals, 'ok.json'), '{}');
		for (const dir of [viewer, out, evals]) symlinkSync(secret, join(dir, 'link'));
		symlinkSync(join(secret, 'x.json'), join(evals, 'file-link.json'));
		const at = (url: string) => resolveRequest(url, viewer, out, evals);
		assert.equal(at('/evals/link/x.json'), undefined);
		assert.equal(at('/evals/file-link.json'), undefined);
		assert.equal(at('/data/link/x.json'), undefined);
		assert.equal(at('/link/x.json'), undefined);
		assert.equal(at('/evals/ok.json'), join(evals, 'ok.json'));
		assert.equal(at('/evals/missing.json'), join(evals, 'missing.json'));
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});
