import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SessionEvent } from './parse.ts';
import { errorClass, findWaste, flattenFindings, totalsOf } from './waste.ts';

// model-a: input 1 dollar, output 5 dollars for one million tokens. Cache read 0.1, 1-hour write 2, 5-minute write 1.25.
const RATES = { 'model-a': { input: 1, output: 5 } };
const EXPLORE = [{ id: 'a1', name: 'Explore' }];
const at = (second: number) => new Date(Date.UTC(2026, 9, 5, 8, 0, second)).toISOString();
const llm = (second: number, tok: Partial<NonNullable<SessionEvent['tok']>>, extra: Partial<SessionEvent> = {}): SessionEvent => ({
	t: at(second),
	ta: second,
	kind: 'llm',
	agent: 0,
	model: 'model-a',
	tok: { fresh: 0, cw5m: 0, cw1h: 0, out: 0, cr: 0, ...tok },
	...extra
});
const error = (second: number, msg: string, agent = 0, target = 'pnpm test'): SessionEvent => ({
	t: at(second),
	ta: second,
	kind: 'error',
	agent,
	tool: 'Bash',
	target,
	msg
});
const prompt = (second: number): SessionEvent => ({ t: at(second), ta: second, kind: 'prompt', agent: 0 });
const round = (value: number | null) => (value === null ? null : Math.round(value * 1e6) / 1e6);

test('a request that rewrites a large context after a pause is a cold resume', () => {
	const events = [llm(0, { cr: 100_000 }, { cost: 0.01 }), llm(3600, { cw1h: 100_000 }, { cost: 0.2 })];
	const [found, ...others] = findWaste(events, [], RATES).coldResumes;
	assert.deepEqual(others, []);
	// Real cost 100 000 x 2 = 0.2. With a warm cache: 100 000 x 0.1 = 0.01.
	assert.deepEqual(
		{ ...found, overWarm: round(found.overWarm) },
		{
			index: 1,
			t: at(3600),
			agent: 0,
			agentId: '',
			kind: 'cold',
			pauseSec: 3600,
			afterPrompt: false,
			contextTokens: 100_000,
			writeTokens: 100_000,
			cost: 0.2,
			overWarm: 0.19
		}
	);
});

test('a 5-minute write costs 1.25: the extra cost follows the write lifetime', () => {
	const events = [llm(0, { cr: 100_000 }), llm(400, { cw5m: 100_000 }, { cost: 0.125 })];
	// 0.125 - 0.01
	assert.equal(round(findWaste(events, [], RATES).coldResumes[0].overWarm), 0.115);
});

test('tokens that are new since the previous request are not extra cost: a warm cache writes them too', () => {
	// Previous context 30 000 and 1000 output tokens. The request writes 131 000: 31 000 known, 100 000 new.
	const events = [llm(0, { cr: 30_000, out: 1000 }), llm(3600, { cw1h: 131_000 })];
	// Real 131 000 x 2 = 0.262. Warm: 100 000 x 2 + 31 000 x 0.1 = 0.2031.
	assert.equal(round(findWaste(events, [], RATES).coldResumes[0].overWarm), 0.0589);
});

test('a pause of 299 seconds is an invalidation, 300 is cold', () => {
	const kindAfter = (pause: number) => findWaste([llm(0, { cr: 100_000 }), llm(pause, { cw1h: 100_000 })], [], RATES).coldResumes[0].kind;
	assert.equal(kindAfter(299), 'invalidation');
	assert.equal(kindAfter(300), 'cold');
});

test('afterPrompt says that a user prompt came between the two requests', () => {
	const withPrompt = [llm(0, { cr: 100_000 }), prompt(3500), llm(3600, { cw1h: 100_000 })];
	assert.equal(findWaste(withPrompt, [], RATES).coldResumes[0].afterPrompt, true);
	const promptBefore = [prompt(0), llm(1, { cr: 100_000 }), llm(3600, { cw1h: 100_000 })];
	assert.equal(findWaste(promptBefore, [], RATES).coldResumes[0].afterPrompt, false);
});

test('no cold resume: small context, cache still read, or small write after a compaction', () => {
	const none = (events: SessionEvent[]) => assert.deepEqual(findWaste(events, [], RATES).coldResumes, []);
	none([llm(0, { cr: 20_000 }), llm(3600, { cw1h: 20_000 })]);
	none([llm(0, { cr: 100_000 }), llm(3600, { cr: 60_000, cw1h: 60_000 })]);
	none([llm(0, { cr: 100_000 }), llm(3600, { cw1h: 30_000 })]);
});

test('the previous request is the previous one of the same agent', () => {
	const events = [llm(0, { cr: 100_000 }), llm(10, { cr: 1000 }, { agent: 1 }), llm(3600, { cw1h: 100_000 })];
	assert.deepEqual(
		findWaste(events, EXPLORE, RATES).coldResumes.map((found) => [found.index, found.agent]),
		[[2, 0]]
	);
	// The first request of a subagent writes its own context. The large context of the parent is not its past.
	const firstOfSubagent = [llm(0, { cr: 100_000 }), llm(3600, { cw1h: 100_000 }, { agent: 1 })];
	assert.deepEqual(findWaste(firstOfSubagent, EXPLORE, RATES).coldResumes, []);
});

test('a finding of a subagent names the transcript file of that subagent', () => {
	const events = [llm(0, { cr: 100_000 }, { agent: 1 }), llm(3600, { cw1h: 100_000 }, { agent: 1 })];
	assert.equal(findWaste(events, EXPLORE, RATES).coldResumes[0].agentId, 'a1');
});

test('a model without a price keeps the finding, with no extra cost', () => {
	const events = [llm(0, { cr: 100_000 }, { model: 'other' }), llm(3600, { cw1h: 100_000 }, { model: 'other', cost: null })];
	const [found] = findWaste(events, [], RATES).coldResumes;
	assert.equal(found.overWarm, null);
	assert.equal(found.cost, null);
});

test('the same failure 3 times is a loop; its cost is the requests that launched the repeats', () => {
	const events = [
		llm(0, {}, { cost: 8 }),
		error(1, 'Exit code 1'),
		llm(2, {}, { cost: 1 }),
		error(3, 'Exit code 1'),
		llm(4, {}, { cost: 2 }),
		llm(5, {}, { cost: 9, agent: 1 }),
		llm(6, {}, { cost: 3 }),
		error(7, 'Exit code 1'),
		llm(8, {}, { cost: 4 })
	];
	// Second failure: launched by the request that costs 1. Third failure: by the one that costs 3.
	assert.deepEqual(findWaste(events, EXPLORE, RATES).loops, [
		{ index: 1, t: at(1), agent: 0, agentId: '', tool: 'Bash', msg: 'Exit code 1', cls: 'exit_code', count: 3, costAtLeast: 4 }
	]);
});

test('one request that launches several repeats is counted one time', () => {
	const events = [llm(0, {}, { cost: 8 }), error(1, 'x'), llm(2, {}, { cost: 5 }), error(3, 'x'), error(4, 'x')];
	assert.equal(findWaste(events, [], RATES).loops[0].costAtLeast, 5);
});

test('an exit code alone does not make a loop: three different commands that fail are three failures', () => {
	const different = [error(0, 'Exit code 1', 0, 'pnpm test'), error(1, 'Exit code 1', 0, 'pnpm lint'), error(2, 'Exit code 1', 0, 'git push')];
	assert.deepEqual(findWaste(different, [], RATES).loops, []);
	// A message that says more than the exit code is the same failure whatever the command.
	const denied = [error(0, 'Permission denied', 0, 'rm a'), error(1, 'Permission denied', 0, 'rm b'), error(2, 'Permission denied', 0, 'rm c')];
	assert.equal(findWaste(denied, [], RATES).loops[0].count, 3);
});

test('two failures, or the same failure split between two agents, give no loop', () => {
	assert.deepEqual(findWaste([error(0, 'x'), error(1, 'x'), error(2, 'y')], [], RATES).loops, []);
	assert.deepEqual(findWaste([error(0, 'x'), error(1, 'x', 1), error(2, 'x')], EXPLORE, RATES).loops, []);
});

test('one row per subagent run, most costly first', () => {
	const agents = [
		{ id: 'a1', name: 'Explore', description: 'Find the cart' },
		{ id: 'b2', name: 'reviewer' }
	];
	const events = [
		llm(0, {}, { cost: 5 }),
		llm(1, {}, { cost: 1, agent: 1 }),
		llm(2, {}, { cost: 3, agent: 2 }),
		llm(3, {}, { cost: null, agent: 2 }),
		llm(4, {}, { cost: 0.5, agent: 1 })
	];
	assert.deepEqual(findWaste(events, agents, RATES).subagents, [
		{ index: 2, t: at(2), agent: 2, agentId: 'b2', name: 'reviewer', description: '', requests: 2, cost: 3 },
		{ index: 1, t: at(1), agent: 1, agentId: 'a1', name: 'Explore', description: 'Find the cart', requests: 2, cost: 1.5 }
	]);
});

const cold = { index: 1, t: at(1), agent: 0, agentId: '', pauseSec: 3600, contextTokens: 1, writeTokens: 1, cost: 0.2 };
const loop = { index: 0, t: at(0), agent: 0, agentId: '', tool: 'Bash', msg: 'x', cls: 'exit_code', costAtLeast: 2 };
const retry = { index: 0, t: at(0), agent: 0, agentId: '', tool: 'Bash', target: 'pnpm test', attempts: 2, fixed: true, costAtLeast: 1 };
const run = { index: 1, t: at(1), agent: 1, agentId: 'a1', name: 'Explore', description: '', requests: 2 };
const SESSIONS = [
	{
		session: 's1',
		project: 'p',
		title: 'First',
		start: at(0),
		coldResumes: [
			{ ...cold, kind: 'cold' as const, afterPrompt: true, overWarm: 0.19 },
			{ ...cold, kind: 'cold' as const, afterPrompt: false, overWarm: 0.5 },
			{ ...cold, kind: 'cold' as const, afterPrompt: true, overWarm: null },
			{ ...cold, kind: 'invalidation' as const, afterPrompt: true, overWarm: 0.05 }
		],
		loops: [
			{ ...loop, count: 3 },
			{ ...loop, count: 4, costAtLeast: 1, cls: 'permission' }
		],
		retries: [retry, { ...retry, attempts: 4, fixed: false, costAtLeast: 3 }],
		subagents: [{ ...run, cost: 1.5 }]
	},
	{ session: 's2', project: 'p', title: 'Second', start: at(9), coldResumes: [], loops: [{ ...loop, count: 5 }], retries: [], subagents: [{ ...run, cost: 7 }] }
];

test('totalsOf adds the findings of all sessions; cold resumes after a user prompt are counted apart', () => {
	assert.deepEqual(totalsOf(SESSIONS), {
		coldResumes: { count: 3, overWarm: 0.69, afterPrompt: { count: 2, overWarm: 0.19 } },
		invalidations: { count: 1, overWarm: 0.05 },
		loops: { count: 3, sessions: 2, errors: 12, costAtLeast: 5, byClass: { exit_code: { count: 2, costAtLeast: 4 }, permission: { count: 1, costAtLeast: 1 } } },
		retries: { count: 2, sessions: 1, attempts: 6, fixed: 1, costAtLeast: 4 },
		subagents: { runs: 2, cost: 8.5 }
	});
});

test('flattenFindings gives one row per finding with its session, most costly first', () => {
	const flat = flattenFindings(SESSIONS);
	assert.deepEqual(
		flat.coldResumes.map((found) => [found.session, found.overWarm]),
		[
			['s1', 0.5],
			['s1', 0.19],
			['s1', 0.05],
			['s1', null]
		]
	);
	assert.deepEqual(
		flat.loops.map((found) => [found.session, found.title, found.costAtLeast, found.count]),
		[
			['s2', 'Second', 2, 5],
			['s1', 'First', 2, 3],
			['s1', 'First', 1, 4]
		]
	);
	assert.deepEqual(
		flat.subagents.map((found) => [found.session, found.project, found.start, found.cost]),
		[
			['s2', 'p', at(9), 7],
			['s1', 'p', at(0), 1.5]
		]
	);
});

test('an error message gets a class from a closed list', () => {
	const cases: Array<[string, string]> = [
		['Exit code 1', 'exit_code'],
		['This command requires approval', 'permission'],
		['Permission to use Bash has been denied. IMPORTANT: You *may* attempt to accomplish this action', 'permission'],
		['Claude requested permissions to write to /repo/src/a.ts, but you haven\'t granted it yet.', 'permission'],
		['Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Irreversible]', 'permission'],
		['The server-side auto mode classifier gave no verdict (error), so auto mode cannot determine', 'permission'],
		['This Bash command contains multiple operations. The following part requires approval: git push', 'permission'],
		['This Bash command contains multiple operations. The following parts require approval: git fetch, git rebase', 'permission'],
		["The user doesn't want to proceed with this tool use. The tool use was rejected", 'permission'],
		['This command changes directory before running a version-control command, which can pick up', 'blocked'],
		['<tool_use_error>Blocked: sleep 30 followed by: cat out.txt</tool_use_error>', 'blocked'],
		['<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>', 'stale_file'],
		['<tool_use_error>File has been modified since read, either by the user or by a linter.', 'stale_file'],
		['File does not exist. Note: your current working directory is /repo', 'not_found'],
		['Ripgrep search timed out after 20 seconds.', 'timeout'],
		['### Error', 'other']
	];
	assert.deepEqual(
		cases.map(([msg]) => [msg, errorClass(msg)]),
		cases
	);
});

test('an error loop carries the class of its message', () => {
	const events = [error(0, 'This command requires approval'), error(10, 'This command requires approval'), error(20, 'This command requires approval')];
	assert.equal(findWaste(events, [], RATES).loops[0].cls, 'permission');
});

const call = (second: number, target = 'pnpm test', agent = 0): SessionEvent => ({ t: at(second), ta: second, kind: 'tool', agent, tool: 'Bash', target });

test('the same call after a failure is a retry; the streak counts its attempts and the requests that launched them', () => {
	const events = [
		error(0, 'Exit code 1'),
		llm(1, {}, { cost: 1 }),
		error(2, 'FAIL src/a.test.ts'),
		llm(3, {}, { cost: 2 }),
		call(4)
	];
	assert.deepEqual(findWaste(events, [], RATES).retries, [
		{ index: 0, t: at(0), agent: 0, agentId: '', tool: 'Bash', target: 'pnpm test', attempts: 3, fixed: true, costAtLeast: 3 }
	]);
});

test('a retry needs a failure before it', () => {
	assert.deepEqual(findWaste([call(0), call(1)], [], RATES).retries, []);
});

test('a call more than 8 calls after the failure is not a retry', () => {
	const between = Array.from({ length: 8 }, (_, n) => call(n + 1, `ls ${n}`));
	assert.deepEqual(findWaste([error(0, 'Exit code 1'), ...between, call(9)], [], RATES).retries, []);
});

test('a retry stays inside one agent', () => {
	assert.deepEqual(findWaste([error(0, 'Exit code 1', 0), error(1, 'Exit code 1', 1)], EXPLORE, RATES).retries, []);
});

test('a streak that ends on a failure is not fixed', () => {
	assert.equal(findWaste([error(0, 'Exit code 1'), error(1, 'Exit code 1')], [], RATES).retries[0].fixed, false);
});

test('a request sent before the first failure launched no retry', () => {
	// Two calls of one response: the second one repeats the first without a new request.
	const events = [llm(0, {}, { cost: 5 }), error(1, 'Exit code 1'), call(2)];
	assert.equal(findWaste(events, [], RATES).retries[0].costAtLeast, 0);
});
