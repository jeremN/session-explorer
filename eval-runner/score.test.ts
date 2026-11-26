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
		subagentCost: 0,
		skillLoads: 0,
		skills: {},
		toolCalls: 3,
		explore: 1,
		edits: 1,
		testRuns: 1,
		testFailures: 0,
		redGreenCycles: 0,
		typeChecks: 0,
		lintRuns: 0,
		rereads: 0,
		reruns: 0,
		toolErrors: 1,
		firstContextTokens: 30000
	});
	assert.deepEqual(scored.steps, ['edit', 'explore', 'test']);
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

test('skillLoads counts the Skill tool calls, and skills counts them per skill, subagents included', () => {
	const call = (id: string, skill: unknown, sidechain = false) => ({
		type: 'assistant',
		isSidechain: sidechain,
		timestamp: '2026-11-13T10:00:30.000Z',
		sessionId: ID,
		message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Skill', input: { skill } }] }
	});
	const scored = scoreRun([...entries, call('s1', 'svelte:svelte-code-writer'), call('s2', 'svelte:svelte-code-writer', true), call('s3', 'tdd'), call('s4', 42)], {}, ID)!;
	assert.equal(scored.metrics.skillLoads, 4);
	assert.deepEqual(scored.metrics.skills, { 'svelte:svelte-code-writer': 2, tdd: 1, unknown: 1 });
});

test('the command patterns of a spec add to the default classes', () => {
	const make = { type: 'assistant', timestamp: '2026-11-13T10:00:40.000Z', sessionId: ID, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_make', name: 'Bash', input: { command: 'make check' } }] } };
	assert.deepEqual(scoreRun([...entries, make], {}, ID)!.steps.at(-1), 'other');
	const scored = scoreRun([...entries, make], {}, ID, { test: ['^make check'] })!;
	assert.deepEqual([scored.steps.at(-1), scored.metrics.testRuns], ['test', 2]);
	// The patterns hold for one call only.
	assert.deepEqual(scoreRun([...entries, make], {}, ID)!.steps.at(-1), 'other');
});

test('an empty transcript gives no score', () => {
	assert.equal(scoreRun([], {}, ID), undefined);
});
