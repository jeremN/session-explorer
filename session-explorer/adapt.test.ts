import assert from 'node:assert/strict';
import { test } from 'node:test';

import { adapt, esc, packLanes } from './viewer/adapt.mjs';

const at = (minute: number) => `2026-10-05T08:${String(minute).padStart(2, '0')}:00.000Z`;
const tok = { fresh: 10, cw5m: 100, cw1h: 200, out: 50, cr: 4000 };
const row = { id: 'abc', project: 'proj--worktrees-cart', branch: 'feat-1/x', start: at(0), unpricedRequests: 1 };

const data = {
	id: 'abc',
	title: 'Fix the cart',
	agents: [
		{ id: 'a1', name: 'Explore', description: 'Find the cart code' },
		{ id: 'b2', name: 'Explore' },
		{ id: 'c3', name: 'reviewer' }
	],
	events: [
		{ t: at(0), ta: 0, kind: 'prompt', agent: 0 },
		{ t: at(1), ta: 60, kind: 'llm', agent: 0, model: 'm', tok, cost: 0.5 },
		{ t: at(1), ta: 60, kind: 'tool', agent: 0, tool: 'MCP', target: 'qmd · query', node: 'mcp:qmd · query', mark: 'brain' },
		{ t: at(2), ta: 120, kind: 'error', agent: 1, tool: 'Bash', target: 'pnpm test', node: 'tool:Bash', msg: 'Exit code 1' },
		{ t: at(3), ta: 180, kind: 'error', agent: 2, tool: 'Bash', target: 'pnpm test', node: 'tool:Bash', msg: 'Exit code 1' },
		{ t: at(4), ta: 240, kind: 'llm', agent: 0, model: 'opus', tok, cost: null },
		{ t: at(5), ta: 300, kind: 'edit', agent: 0, tool: 'Edit', target: 'src/a.ts', node: 'file:src/a.ts' },
		{ t: at(35), ta: 320, kind: 'prompt', agent: 0 },
		{ t: at(36), ta: 380, kind: 'tool', agent: 3, tool: 'Grep', target: 'x', node: 'tool:Grep' }
	],
	tasks: [{ start: at(0), end: at(35), brain: 'before', memory: false, editAt: at(5), brainAt: at(1) }]
};

test('esc turns markup into text', () => {
	assert.equal(esc('<img src=x onerror="a&b">'), '&lt;img src=x onerror=&quot;a&amp;b&quot;&gt;');
	assert.equal(esc(42), '42');
});

test('packLanes puts spans that do not overlap on the same lane', () => {
	assert.deepEqual(
		packLanes([
			{ t0: 0, t1: 10 },
			{ t0: 5, t1: 8 },
			{ t0: 10, t1: 12 },
			{ t0: 9, t1: 20 }
		]),
		[0, 1, 0, 1]
	);
	assert.deepEqual(packLanes([]), []);
});

test('adapt: events use active time and keep the wall time', () => {
	const S = adapt(row, data);
	assert.deepEqual([S.ev[7].t, S.ev[7].wall, S.ev[7].i], [320, at(35), 7]);
	assert.equal(S.ev[0].node, null);
	assert.equal(S.dur, 380);
	assert.deepEqual(S.cfg, { title: 'Fix the cart', date: at(0), durMin: 380 / 60, tags: ['feat-1/x', 'worktrees-cart'] });
});

test('adapt: llm requests carry a number, a merged cache write and a running cost', () => {
	const S = adapt(row, data);
	assert.deepEqual(
		S.llms.map((event) => [event.n, event.cum, event.tok.cw]),
		[
			[1, 0.5, 300],
			[2, 0.5, 300]
		]
	);
	assert.deepEqual(S.tot, { cost: 0.5, fresh: 20, cw: 600, out: 100, cr: 8000 });
	assert.equal(S.unpriced, 1);
});

test('adapt: subagents get a span and a packed lane', () => {
	const S = adapt(row, data);
	assert.deepEqual(
		S.subs.map((sub) => [sub.name, sub.agent, sub.t0, sub.t1, sub.lane]),
		[
			['Explore', 1, 120, 120, 0],
			['Explore', 2, 180, 180, 0],
			['reviewer', 3, 380, 380, 0]
		]
	);
	assert.equal(S.nLanes, 1);
});

test('adapt: map nodes count the tool, the knowledge mark and the subagent type', () => {
	const S = adapt(row, data);
	assert.deepEqual(S.nodesOf(S.ev[2]), ['mcp:qmd · query', 'know:brain']);
	assert.deepEqual(S.nodesOf(S.ev[3]), ['tool:Bash', 'sub:Explore']);
	assert.deepEqual([S.counts['tool:Bash'], S.counts['sub:Explore'], S.counts['know:brain'], S.first['sub:Explore']], [2, 2, 1, 3]);
});

test('adapt: the same error message from the same tool forms one group', () => {
	assert.deepEqual(adapt(row, data).errors, [{ msg: 'Exit code 1', tool: 'Bash', n: 2, first: 3, t0: 120, t1: 180 }]);
});

test('adapt: a break sits in the middle of each collapsed gap', () => {
	assert.deepEqual(adapt(row, data).breaks, [310]);
});

test('adapt: a task gets its position, its first event and its first edit', () => {
	const S = adapt(row, data);
	const { n, t0, t1, i0, iEdit } = S.tasks[0];
	assert.deepEqual({ n, t0, t1, i0, iEdit }, { n: 1, t0: 0, t1: 320, i0: 0, iEdit: 6 });
	assert.equal(S.taskOf(S.ev[4]).n, 1);
	assert.equal(S.taskOf(S.ev[8]), undefined);
});

test('adapt: a session without llm request and without task still adapts', () => {
	const S = adapt({ ...row, branch: undefined, project: 'proj' }, { id: 'x', title: 't', agents: [], events: [{ t: at(0), ta: 0, kind: 'prompt', agent: 0 }], tasks: [] });
	assert.deepEqual([S.llms.length, S.tot.cost, S.nLanes, S.dur, S.cfg.tags], [0, 0, 0, 1, []]);
});

test('adapt: the first edit of a task is found even when that edit failed', () => {
	const failed = {
		id: 'x',
		title: 't',
		agents: [],
		events: [
			{ t: at(0), ta: 0, kind: 'prompt', agent: 0 },
			{ t: at(1), ta: 60, kind: 'tool', agent: 0, tool: 'Read', target: 'src/a.ts', node: 'file:src/a.ts' },
			{ t: at(2), ta: 120, kind: 'error', agent: 0, tool: 'Edit', target: 'src/a.ts', node: 'file:src/a.ts', msg: 'File has not been read yet' }
		],
		tasks: [{ start: at(0), end: at(2), brain: 'never', memory: false, editAt: at(2) }]
	};
	assert.equal(adapt(row, failed).tasks[0].iEdit, 2);
});

test('adapt: a task carries its opening prompt, its prompt count and its first edited file', () => {
	const session = {
		id: 'x',
		title: 't',
		agents: [],
		events: [
			{ t: at(0), ta: 0, kind: 'prompt', agent: 0, msg: 'plan the cart fix' },
			{ t: at(1), ta: 60, kind: 'tool', agent: 0, tool: 'Read', target: 'src/a.ts', node: 'file:src/a.ts' },
			{ t: at(2), ta: 120, kind: 'prompt', agent: 0, msg: 'go' },
			{ t: at(3), ta: 180, kind: 'edit', agent: 0, tool: 'Edit', target: 'src/cart.ts', node: 'file:src/cart.ts' },
			{ t: at(4), ta: 240, kind: 'prompt', agent: 0, msg: 'thanks' }
		],
		tasks: [{ start: at(0), end: at(4), brain: 'never', memory: false, editAt: at(3) }]
	};
	const [task] = adapt(row, session).tasks;
	assert.equal(task.ask, 'plan the cart fix');
	assert.equal(task.prompts, 2);
	assert.equal(task.file, 'src/cart.ts');
});
