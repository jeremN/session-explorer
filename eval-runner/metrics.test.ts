import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { main } from './metrics.ts';

// The knowledge config of the user must not change the counts of a test.
process.env.SESSION_EXPLORER_CONFIG = join(tmpdir(), 'eval-runner-no-such-config.json');
const TRANSCRIPT = join(import.meta.dirname, 'fixtures', 'transcript.jsonl');
const root = mkdtempSync(join(tmpdir(), 'eval-metrics-'));
after(() => rmSync(root, { recursive: true, force: true }));

// An eval.json of an older runner: metrics without the behavior counts, no steps.
const oldMetrics = { cost: 9.99, billedTokens: 1, cacheReadShare: 0, errors: 0, denials: 0, outages: 0, verified: 0, failed: 0, loops: 0, retries: 0, subagentCost: 0, skillLoads: 0, skills: {} };
function oldEval(name: string, commands?: Record<string, string[]>) {
	const dir = join(root, name);
	for (const id of ['a-1', 'a-2']) {
		mkdirSync(join(dir, 'runs', id), { recursive: true });
		copyFileSync(TRANSCRIPT, join(dir, 'runs', id, 'transcript.jsonl'));
	}
	const runs = [
		{ id: 'a-1', config: 'a', status: 'ok', metrics: { ...oldMetrics } },
		{ id: 'a-2', config: 'a', status: 'ok', metrics: { ...oldMetrics, cost: 1 } },
		{ id: 'a-3', config: 'a', status: 'skipped', note: 'budget' },
		{ id: 'b-1', config: 'b', status: 'ok', metrics: { ...oldMetrics }, cached: { evalId: 'source', id: 'b-7' } }
	];
	const configs = [
		{ name: 'a', model: null, pass: { passed: 0, n: 2 }, metrics: {}, grades: { review: { graded: 2, withFindings: 0, findings: 0, bySeverity: {} } } },
		{ name: 'b', model: null, pass: { passed: 0, n: 1 }, metrics: {} }
	];
	writeFileSync(join(dir, 'eval.json'), JSON.stringify({ schema: 'eval-runner/v1', id: name, spec: { ...(commands ? { commands } : {}) }, configs, runs }));
	return dir;
}
mkdirSync(join(root, 'source', 'runs', 'b-7'), { recursive: true });
copyFileSync(TRANSCRIPT, join(root, 'source', 'runs', 'b-7', 'transcript.jsonl'));

test('eval:metrics fills the behavior counts and the steps of each run, and keeps every other value', async () => {
	const dir = oldEval('old');
	assert.equal(await main([dir]), 0);
	const ev = JSON.parse(readFileSync(join(dir, 'eval.json'), 'utf8'));
	const [first, second, skipped, cached] = ev.runs;
	assert.deepEqual(first.steps, ['edit', 'explore', 'test']);
	assert.deepEqual([first.metrics.toolCalls, first.metrics.explore, first.metrics.toolErrors, first.metrics.firstContextTokens], [3, 1, 1, 30000]);
	// No new score: the cost of the run stays what the runner saved.
	assert.deepEqual([first.metrics.cost, second.metrics.cost], [9.99, 1]);
	assert.deepEqual(skipped, { id: 'a-3', config: 'a', status: 'skipped', note: 'budget' });
	// A cached run reads the transcript in the eval that holds its files.
	assert.deepEqual(cached.steps, ['edit', 'explore', 'test']);
	// The spreads per config are computed again; the other fields of a config stay.
	assert.deepEqual(ev.configs[0].metrics.toolCalls.values, [3, 3]);
	assert.equal(ev.configs[0].metrics.cost.median, 5.495);
	assert.deepEqual(ev.configs[0].grades.review.graded, 2);
	assert.equal(ev.configs[1].metrics.testRuns.median, 1);
	assert.deepEqual(readdirSync(dir).sort(), ['eval.json', 'runs']);
});

test('eval:metrics uses the command patterns of the saved spec', async () => {
	const dir = oldEval('patterns', { test: ['^cat '] });
	assert.equal(await main([dir]), 0);
	const ev = JSON.parse(readFileSync(join(dir, 'eval.json'), 'utf8'));
	assert.deepEqual(ev.runs[0].steps, ['edit', 'test-failed', 'test']);
});

test('eval:metrics without an eval dir exits 2', async () => {
	assert.equal(await main([]), 2);
	assert.equal(await main([join(root, 'nothing')]), 2);
	assert.equal(await main([oldEval('flag'), '--nope']), 2);
});
