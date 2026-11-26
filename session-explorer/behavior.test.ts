import assert from 'node:assert/strict';
import { test } from 'node:test';

import { configureKnowledge } from '../context-tracer/tracer.ts';
import { behaviorOf } from './behavior.ts';

configureKnowledge({});

// Synthetic rows. One tool call per assistant row, its result in the next user row.
let clock = 0;
const at = () => new Date(Date.UTC(2026, 10, 1, 8, 0, clock++)).toISOString();
type Call = { name: string; input: Record<string, unknown>; result?: string; error?: boolean };
const call = (id: string, name: string, input: Record<string, unknown>, result = 'ok', error = false): Call & { id: string } => ({ id, name, input, result, error });
const bash = (id: string, command: string, result = 'ok', error = false) => call(id, 'Bash', { command }, result, error);
function rows(calls: Array<Call & { id: string }>, usage = { input_tokens: 10, cache_creation_input_tokens: 2000, cache_read_input_tokens: 20000, output_tokens: 50 }) {
	return calls.flatMap((entry, index) => [
		{ type: 'assistant', timestamp: at(), message: { id: `msg-${index}`, model: 'claude-x', usage, content: [{ type: 'tool_use', id: entry.id, name: entry.name, input: entry.input }] } },
		{ type: 'user', timestamp: at(), message: { content: [{ type: 'tool_result', tool_use_id: entry.id, is_error: entry.error, content: entry.result }] } }
	]);
}

test('one step per tool call, in order, with a primary class and the full class list', () => {
	const { steps } = behaviorOf(
		rows([
			call('a', 'Read', { file_path: '/r/a.ts' }),
			call('b', 'Grep', { pattern: 'x' }),
			call('c', 'Edit', { file_path: '/r/a.ts' }),
			bash('d', 'pnpm lint && pnpm test 2>&1 | tail -5', 'Tests  1 failed | 3 passed'),
			bash('e', 'pnpm check:types'),
			bash('f', 'git status'),
			call('g', 'TodoWrite', { todos: [] })
		])
	);
	assert.deepEqual(
		steps.map(({ primary, classes }) => [primary, classes]),
		[
			['explore', ['explore']],
			['explore', ['explore']],
			['edit', ['edit']],
			['test-failed', ['lint', 'test', 'test-failed']],
			['types', ['types']],
			['git', ['git']],
			['other', ['other']]
		]
	);
	assert.deepEqual(steps.map((step) => step.tool), ['Read', 'Grep', 'Edit', 'Bash', 'Bash', 'Bash', 'TodoWrite']);
});

test('a tool call written twice with the same id counts once', () => {
	const entries = rows([call('a', 'Read', { file_path: '/r/a.ts' }), bash('b', 'pnpm test')]);
	const { metrics } = behaviorOf([...entries, entries[0], { ...entries[2], timestamp: at() }]);
	assert.equal(metrics.toolCalls, 2);
	assert.equal(metrics.testRuns, 1);
});

test('a test fails on is_error or on a failure line, and a pass after a failure closes one red-green cycle', () => {
	const { metrics } = behaviorOf(
		rows([
			bash('a', 'pnpm test', 'exit 1', true),
			bash('b', 'pnpm test -- a', 'FAIL src/a.test.ts\n'),
			call('c', 'Edit', { file_path: '/r/a.ts' }),
			bash('d', 'pnpm test', 'Tests  4 passed'),
			bash('e', 'pnpm test', 'ℹ fail 2'),
			bash('f', 'pnpm test', 'ℹ fail 0')
		])
	);
	assert.equal(metrics.testRuns, 5);
	assert.equal(metrics.testFailures, 3);
	assert.equal(metrics.redGreenCycles, 2);
	assert.equal(metrics.toolErrors, 1);
});

test('a lint or type error in the output of a test call is not a test failure', () => {
	const { metrics } = behaviorOf(rows([bash('a', 'pnpm lint && pnpm test | tail', '✖ 2 problems (2 errors, 0 warnings)\nTests  3 passed'), bash('b', 'pnpm test && pnpm check:types | tail', 'error TS2304: x')]));
	assert.deepEqual([metrics.testRuns, metrics.testFailures], [2, 0]);
});

test('lintOnlyAtEnd: 1 when every lint comes after the last edit, 0 when a lint precedes an edit, absent without lint', () => {
	const end = behaviorOf(rows([call('a', 'Edit', { file_path: '/r/a.ts' }), bash('b', 'pnpm exec eslint src'), bash('c', 'pnpm lint')])).metrics;
	assert.equal(end.lintOnlyAtEnd, 1);
	assert.equal(end.lintRuns, 2);
	const early = behaviorOf(rows([bash('a', 'pnpm lint'), call('b', 'Write', { file_path: '/r/b.ts' }), bash('c', 'pnpm lint')])).metrics;
	assert.equal(early.lintOnlyAtEnd, 0);
	// A shell write to a source file is an edit too.
	assert.equal(behaviorOf(rows([bash('a', 'pnpm lint'), bash('b', "sed -i '' 's/a/b/' src/a.ts")])).metrics.lintOnlyAtEnd, 0);
	const none = behaviorOf(rows([call('a', 'Edit', { file_path: '/r/a.ts' })])).metrics;
	assert.equal('lintOnlyAtEnd' in none, false);
});

test('rereads: a Read of a file read before, with no edit to that file in between', () => {
	const { metrics } = behaviorOf(
		rows([
			call('a', 'Read', { file_path: '/r/a.ts' }),
			call('b', 'Read', { file_path: '/r/a.ts', offset: 200 }),
			call('c', 'Read', { file_path: '/r/b.ts' }),
			call('d', 'Edit', { file_path: '/r/a.ts' }),
			call('e', 'Read', { file_path: '/r/a.ts' }),
			call('f', 'Read', { file_path: '/r/b.ts' })
		])
	);
	assert.equal(metrics.rereads, 2);
	assert.equal(metrics.explore, 5);
	assert.equal(metrics.edits, 1);
});

test('reruns: a verify command repeated with no edit in between', () => {
	const { metrics } = behaviorOf(
		rows([
			bash('a', 'pnpm test'),
			bash('b', 'pnpm  test'),
			bash('c', 'pnpm check:types'),
			call('d', 'Edit', { file_path: '/r/a.ts' }),
			bash('e', 'pnpm test'),
			bash('f', 'git status'),
			bash('g', 'git status'),
			bash('h', 'pnpm check:types')
		])
	);
	assert.equal(metrics.reruns, 1);
	assert.equal(metrics.typeChecks, 2);
});

test('firstContextTokens: the input of the first main request, cache read and cache creation included', () => {
	const entries = rows([bash('a', 'ls')]);
	const sidechain = { type: 'assistant', isSidechain: true, timestamp: '2026-10-01T00:00:00.000Z', message: { id: 'side', model: 'claude-x', usage: { input_tokens: 5, cache_read_input_tokens: 0, output_tokens: 1 }, content: [] } };
	assert.equal(behaviorOf([sidechain, ...entries]).metrics.firstContextTokens, 22010);
});

test('a call that a classifier outage blocked never ran: no step', () => {
	const outage = 'The server-side auto mode classifier gave no verdict (error), so auto mode cannot determine the safety of Bash.';
	const { metrics, steps } = behaviorOf(rows([bash('a', 'pnpm test', outage, true), bash('b', 'pnpm test')]));
	assert.equal(steps.length, 1);
	assert.deepEqual([metrics.toolCalls, metrics.testRuns, metrics.testFailures, metrics.toolErrors, metrics.reruns], [1, 1, 0, 0, 0]);
});

test('a session without a tool call gives zero counts', () => {
	assert.deepEqual(behaviorOf([]), {
		steps: [],
		metrics: { toolCalls: 0, explore: 0, edits: 0, testRuns: 0, testFailures: 0, redGreenCycles: 0, typeChecks: 0, lintRuns: 0, rereads: 0, reruns: 0, toolErrors: 0, firstContextTokens: 0 }
	});
});
