import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseSession } from './parse.ts';

const CWD = '/Users/dev/Documents/Code/Work/acme';

const at = (minute: number, second = 0) =>
	`2026-10-05T${String(8 + Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:${String(second).padStart(2, '0')}.000Z`;
const prompt = (minute: number, content = 'fix the bug') => ({ type: 'user', timestamp: at(minute), message: { content } });
const usage = { input_tokens: 10, cache_creation_input_tokens: 300, cache_read_input_tokens: 4000, output_tokens: 50, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 } };
const assistant = (minute: number, id: string, content: unknown[], extra: Record<string, unknown> = {}) => ({
	type: 'assistant',
	timestamp: at(minute),
	cwd: CWD,
	message: { id, model: 'claude-opus-5-5', usage, content },
	...extra
});
const call = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });
const result = (minute: number, toolUseId: string, content: unknown, isError = true) => ({
	type: 'user',
	timestamp: at(minute),
	message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: isError, content }] }
});

test('one llm event per message id, with the usage read once', () => {
	const session = parseSession([
		assistant(1, 'msg_1', [{ type: 'text', text: 'I will read the file.' }]),
		assistant(1, 'msg_1', [call('t1', 'Read', { file_path: `${CWD}/src/a.ts` })]),
		assistant(2, 'msg_2', [{ type: 'text', text: 'Done.' }])
	]);
	assert.deepEqual(
		session?.events.map((event) => event.kind),
		['llm', 'tool', 'llm']
	);
	assert.deepEqual(session?.events[0].tok, { fresh: 10, cw5m: 100, cw1h: 200, out: 50, cr: 4000 });
	assert.equal(session?.events[0].model, 'claude-opus-5-5');
});

test('without the cache split, the whole cache write counts as five-minute', () => {
	const row = assistant(1, 'msg_1', [{ type: 'text', text: 'x' }]);
	row.message.usage = { input_tokens: 10, cache_creation_input_tokens: 300, cache_read_input_tokens: 0, output_tokens: 5 } as typeof usage;
	assert.deepEqual(parseSession([row])?.events[0].tok, { fresh: 10, cw5m: 300, cw1h: 0, out: 5, cr: 0 });
});

test('a synthetic assistant row gives no llm event', () => {
	const row = assistant(1, 'msg_1', [{ type: 'text', text: 'x' }]);
	row.message.model = '<synthetic>';
	assert.equal(parseSession([prompt(0), row])?.events.length, 1);
});

test('a tool call: kind, tool, target and map node', () => {
	const session = parseSession([
		assistant(1, 'msg_1', [
			call('t1', 'Read', { file_path: `${CWD}/src/a.ts` }),
			call('t2', 'Edit', { file_path: `${CWD}/src/a.ts` }),
			call('t3', 'Bash', { command: 'pnpm test' }),
			call('t4', 'Grep', { pattern: 'createOrder' }),
			call('t5', 'Skill', { skill: 'superpowers:brainstorming' }),
			call('t6', 'Agent', { subagent_type: 'Explore', prompt: 'find it' }),
			call('t7', 'mcp__plugin_qmd_qmd__query', { searches: [] }),
			call('t8', 'ToolSearch', { query: 'x' })
		])
	]);
	assert.deepEqual(
		session?.events.slice(1).map(({ kind, tool, target, node, mark }) => ({ kind, tool, target, node, mark })),
		[
			{ kind: 'tool', tool: 'Read', target: 'src/a.ts', node: 'file:src/a.ts', mark: undefined },
			{ kind: 'edit', tool: 'Edit', target: 'src/a.ts', node: 'file:src/a.ts', mark: undefined },
			{ kind: 'tool', tool: 'Bash', target: 'pnpm test', node: 'tool:Bash', mark: undefined },
			{ kind: 'tool', tool: 'Grep', target: 'createOrder', node: 'tool:Grep', mark: undefined },
			{ kind: 'tool', tool: 'Skill', target: 'superpowers:brainstorming', node: 'skill:superpowers:brainstorming', mark: undefined },
			{ kind: 'subagent', tool: 'Agent', target: 'Explore', node: 'sub:Explore', mark: undefined },
			{ kind: 'tool', tool: 'MCP', target: 'plugin_qmd_qmd · query', node: 'mcp:plugin_qmd_qmd · query', mark: 'brain' },
			{ kind: 'tool', tool: 'ToolSearch', target: '', node: 'tool:ToolSearch', mark: undefined }
		]
	);
});

test('a file outside the working directory keeps its full path', () => {
	const session = parseSession([assistant(1, 'msg_1', [call('t1', 'Read', { file_path: '/etc/hosts' })])]);
	assert.equal(session?.events[1].target, '/etc/hosts');
});

test('an error result turns its call into an error with the first line as message', () => {
	const session = parseSession([
		assistant(1, 'msg_1', [call('t1', 'Bash', { command: 'pnpm test' })]),
		result(2, 't1', '\nExit code 1\n 2 tests failed\n')
	]);
	const { kind, msg, tool } = session!.events[1];
	assert.deepEqual({ kind, msg, tool }, { kind: 'error', msg: 'Exit code 1', tool: 'Bash' });
});

test('an error result given as text blocks', () => {
	const session = parseSession([
		assistant(1, 'msg_1', [call('t1', 'Edit', { file_path: `${CWD}/a.ts` })]),
		result(2, 't1', [{ type: 'text', text: 'old_string not found in file' }])
	]);
	assert.equal(session?.events[1].msg, 'old_string not found in file');
});

test('a successful result and a call without a result leave the call as a tool', () => {
	const session = parseSession([
		assistant(1, 'msg_1', [call('t1', 'Bash', { command: 'ls' }), call('t2', 'Bash', { command: 'pwd' })]),
		result(2, 't1', 'a.ts', false)
	]);
	assert.deepEqual(
		session?.events.slice(1).map((event) => event.kind),
		['tool', 'tool']
	);
});

test('an error result for an unknown call is ignored', () => {
	const session = parseSession([prompt(0), result(1, 'gone', 'Exit code 1')]);
	assert.deepEqual(
		session?.events.map((event) => event.kind),
		['prompt']
	);
});

test('subagent rows get an agent number and a name from the meta file', () => {
	const session = parseSession(
		[
			prompt(0),
			assistant(1, 'msg_1', [call('t1', 'Agent', { subagent_type: 'Explore' })]),
			assistant(2, 'msg_2', [call('t2', 'Grep', { pattern: 'x' })], { agentId: 'a1', isSidechain: true }),
			assistant(3, 'msg_3', [call('t3', 'Grep', { pattern: 'y' })], { agentId: 'b2', isSidechain: true })
		],
		{ a1: { agentType: 'Explore', description: 'Find the cart code' } }
	);
	assert.deepEqual(session?.agents, [
		{ id: 'a1', name: 'Explore', description: 'Find the cart code' },
		{ id: 'b2', name: 'subagent' }
	]);
	assert.deepEqual(
		session?.events.map((event) => event.agent),
		[0, 0, 0, 1, 1, 2, 2]
	);
});

test('a compaction summary and a subagent prompt are not prompts', () => {
	const session = parseSession([
		prompt(0),
		{ ...prompt(1, 'Summary of the conversation'), isCompactSummary: true },
		{ ...prompt(2, 'You implement one task'), isSidechain: true, agentId: 'a1' },
		{ ...prompt(3, '<system-reminder>hook</system-reminder>') }
	]);
	assert.equal(session?.events.length, 1);
});

test('active time: a gap longer than 300 seconds counts as 20 seconds', () => {
	const session = parseSession([prompt(0), prompt(1), prompt(31), prompt(32), prompt(37)]);
	assert.deepEqual(
		session?.events.map((event) => event.ta),
		[0, 60, 80, 140, 440]
	);
	assert.equal(session?.events[2].t, at(31));
});

test('a command longer than 200 characters is cut with an ellipsis', () => {
	const session = parseSession([assistant(1, 'msg_1', [call('t1', 'Bash', { command: 'x'.repeat(300) })])]);
	assert.equal(session?.events[1].target, `${'x'.repeat(199)}…`);
});

test('the title is the last ai-title row, else the first line of the first prompt', () => {
	const titled = parseSession([{ type: 'ai-title', aiTitle: 'Old' }, prompt(0), { type: 'ai-title', aiTitle: 'FEAT-1611' }]);
	assert.equal(titled?.title, 'FEAT-1611');
	assert.equal(parseSession([prompt(0, 'fix the cart\nsecond line')])?.title, 'fix the cart');
	assert.equal(parseSession([assistant(1, 'msg_1', [{ type: 'text', text: 'x' }])])?.title, 'Session sans titre');
});

test('a title typed by the user wins over the generated title', () => {
	const renamed = parseSession([{ type: 'custom-title', customTitle: 'Tooling' }, prompt(0), { type: 'ai-title', aiTitle: 'FEAT-1611' }]);
	assert.equal(renamed?.title, 'Tooling');
	const renamedTwice = parseSession([{ type: 'custom-title', customTitle: 'Old' }, prompt(0), { type: 'custom-title', customTitle: 'New' }]);
	assert.equal(renamedTwice?.title, 'New');
});

test('start and branch come from the rows; rows are sorted by time', () => {
	const session = parseSession([{ ...prompt(5, 'second') }, { ...prompt(2, 'first'), gitBranch: 'feat-1/x' }]);
	assert.equal(session?.start, at(2));
	assert.equal(session?.branch, 'feat-1/x');
	assert.equal(session?.title, 'first');
});

test('no event gives undefined; a row without a timestamp is skipped', () => {
	assert.equal(parseSession([]), undefined);
	assert.equal(parseSession([{ type: 'user', message: { content: 'no time' } }, null, 'junk']), undefined);
});

test('the tokens of a message come from its last row, the time from its first', () => {
	const first = assistant(1, 'msg_1', [{ type: 'text', text: 'I will read the file.' }]);
	first.message.usage = { ...usage, output_tokens: 5 };
	const last = assistant(2, 'msg_1', [call('t1', 'Read', { file_path: `${CWD}/src/a.ts` })]);
	last.message.usage = { ...usage, output_tokens: 50 };
	const session = parseSession([first, last]);
	assert.deepEqual(
		session?.events.map((event) => event.kind),
		['llm', 'tool']
	);
	assert.equal(session?.events[0].tok?.out, 50);
	assert.equal(session?.events[0].t, at(1));
});

test('an error message longer than 200 characters is cut with an ellipsis', () => {
	const session = parseSession([assistant(1, 'msg_1', [call('t1', 'Bash', { command: 'pnpm test' })]), result(2, 't1', 'e'.repeat(300))]);
	assert.equal(session?.events[1].msg, `${'e'.repeat(199)}…`);
});

test('a prompt event carries its text on one line, cut at 500 characters', () => {
	const session = parseSession([prompt(0, 'fix the cart\n\nthe total is wrong'), prompt(1, 'y'.repeat(600))]);
	assert.equal(session?.events[0].msg, 'fix the cart the total is wrong');
	assert.equal(session?.events[1].msg, `${'y'.repeat(499)}…`);
});
