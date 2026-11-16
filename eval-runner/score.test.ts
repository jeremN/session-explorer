import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { readLines } from '../context-tracer/tracer.ts';
import { scoreRun } from './score.ts';

// The knowledge config of the user must not change the verdicts of a test.
process.env.SESSION_EXPLORER_CONFIG = join(tmpdir(), 'eval-runner-no-such-config.json');
const entries = readLines(join(import.meta.dirname, 'fixtures', 'transcript.jsonl'));
const ID = '00000000-0000-4000-8000-000000000001';

test('scoreRun gives the metrics of the synthetic transcript', () => {
	const scored = scoreRun(entries, {}, ID)!;
	assert.deepEqual(scored.metrics, {
		// Request 1: (10000 + 20000 * 1.25) * 2 + 2000 * 10 = 90000. Request 2: (1000 + 30000 * 0.1) * 2 + 1000 * 10 = 18000. Dollars per million tokens.
		cost: 0.11,
		billedTokens: 34000,
		cacheReadShare: 0.49,
		errors: 1,
		denials: 0,
		outages: 0,
		verified: 1,
		failed: 0,
		loops: 0,
		retries: 0,
		subagentCost: 0
	});
	assert.deepEqual(scored.mrs, []);
	assert.equal(scored.summary.llmRequests, 2);
	assert.equal(scored.summary.id, ID);
});

test('the session file has the shape of out/sessions/<id>.json', () => {
	const { session } = scoreRun(entries, {}, ID)!;
	assert.deepEqual(Object.keys(session).sort(), ['agents', 'events', 'id', 'tasks', 'title']);
	assert.equal(session.title, 'Add a helper that formats dollars and run the tests.');
	assert.equal(session.events.filter((event) => event.kind === 'llm').every((event) => typeof event.cost === 'number'), true);
	assert.equal(session.tasks.length, 1);
	assert.equal(session.tasks[0].check, 'passed');
});

test('an empty transcript gives no score', () => {
	assert.equal(scoreRun([], {}, ID), undefined);
});
