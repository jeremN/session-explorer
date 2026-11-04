import assert from 'node:assert/strict';
import { test } from 'node:test';

import { heartbeat, hooksFrom, occurrencesOf, pluginHookSources, tracesOf, verdictOf } from './heartbeat.ts';
import type { Hook, Occurrence, Trace } from './heartbeat.ts';

const REPO = '/home/dev/acme';
const at = (minute: number) => new Date(Date.UTC(2026, 9, 15, 8, minute)).toISOString();
const row = (minute: number, rest: Record<string, unknown>) => ({ timestamp: at(minute), cwd: REPO, sessionId: 's1', ...rest });
const attachment = (minute: number, body: Record<string, unknown>) => row(minute, { type: 'attachment', attachment: body });

// One fixture per transcript shape observed in Claude Code 2.1 transcripts. The values are invented.
const SUCCESS = attachment(0, {
	type: 'hook_success',
	hookName: 'PreToolUse:Bash',
	hookEvent: 'PreToolUse',
	toolUseID: 'toolu_1',
	command: '/home/dev/.claude/hooks/guard.sh',
	stdout: '{"hookSpecificOutput":{}}',
	stderr: '',
	exitCode: 0,
	durationMs: 40
});
const WITH_STATUS = attachment(1, { ...SUCCESS.attachment, hookName: 'PostToolUse:Edit', hookEvent: 'PostToolUse', command: 'Linting...' });
const TIMED_OUT = attachment(2, {
	type: 'hook_cancelled',
	hookName: 'PreToolUse:Bash',
	hookEvent: 'PreToolUse',
	toolUseID: 'toolu_2',
	command: '/home/dev/.claude/hooks/guard.sh',
	durationMs: 5012,
	timedOut: true,
	timeoutMs: 5000
});
const NON_BLOCKING = attachment(3, {
	type: 'hook_non_blocking_error',
	hookName: 'SessionStart:startup',
	hookEvent: 'SessionStart',
	toolUseID: 'u1',
	command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/start.mjs"',
	stdout: '',
	stderr: 'Failed with non-blocking status code: boom\nstack line',
	exitCode: 1,
	durationMs: 200
});
const ASYNC = attachment(4, {
	type: 'async_hook_response',
	hookName: 'PostToolUse:Write',
	hookEvent: 'PostToolUse',
	processId: 'p1',
	command: '',
	exitCode: 0,
	stdout: 'done',
	stderr: '',
	response: {}
});
const ADDITIONAL_CONTEXT = attachment(5, { type: 'hook_additional_context', hookName: 'UserPromptSubmit', hookEvent: 'UserPromptSubmit', toolUseID: 'u2', content: ['note'] });
const SYSTEM_MESSAGE = attachment(6, { type: 'hook_system_message', hookName: 'UserPromptSubmit', hookEvent: 'UserPromptSubmit', toolUseID: 'u3', content: 'warning' });
const BLOCKING = attachment(7, { type: 'hook_blocking_error', hookName: 'PostToolUse:Edit', hookEvent: 'PostToolUse', toolUseID: 'toolu_3', blockingError: { blockingError: 'lint failed' } });
const STOP_SUMMARY = row(8, {
	type: 'system',
	subtype: 'stop_hook_summary',
	hookCount: 2,
	hookInfos: [{ command: '/home/dev/.claude/hooks/gate.sh', durationMs: 10031 }, { command: 'node "${CLAUDE_PLUGIN_ROOT}/stop.mjs"' }],
	hookErrors: ['the gate refused'],
	preventedContinuation: false
});
const STOP_CANCELLED = attachment(8, { ...TIMED_OUT.attachment, hookName: 'Stop', hookEvent: 'Stop', command: '/home/dev/.claude/hooks/gate.sh' });

const hook = (overrides: Partial<Hook>): Hook => ({ source: 'user', event: 'PreToolUse', matcher: '', command: '/home/dev/.claude/hooks/guard.sh', async: false, ...overrides });
const trace = (minute: number, overrides: Partial<Trace> = {}): Trace => ({
	t: at(minute),
	cwd: REPO,
	event: 'PreToolUse',
	name: 'PreToolUse:Bash',
	command: '/home/dev/.claude/hooks/guard.sh',
	async: false,
	...overrides
});
const occurrence = (minute: number, name = 'PreToolUse:Bash'): Occurrence => ({ t: at(minute), cwd: REPO, event: name.split(':')[0], name });

test('settings: one hook per command, with event, matcher, status message, async flag and timeout', () => {
	const settings = {
		hooks: {
			PostToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: 'lint.sh', statusMessage: 'Linting...', timeout: 30, async: true }] }],
			Stop: [{ hooks: [{ type: 'command', command: 'gate.sh' }] }]
		}
	};
	assert.deepEqual(hooksFrom(settings, 'project-local', { project: REPO }), [
		{ source: 'project-local', event: 'PostToolUse', matcher: 'Write|Edit', command: 'lint.sh', statusMessage: 'Linting...', async: true, timeoutSec: 30, project: REPO },
		{ source: 'project-local', event: 'Stop', matcher: '', command: 'gate.sh', async: false, project: REPO }
	]);
	assert.deepEqual(hooksFrom({}, 'user'), []);
	assert.deepEqual(hooksFrom({ hooks: { Stop: 'broken' } }, 'user'), []);
});

test('settings: arguments join the command, a background rewake hook is async, an if condition is kept', () => {
	const settings = {
		hooks: {
			PostToolUse: [
				{ matcher: 'Bash', hooks: [{ type: 'command', command: 'review.sh', if: 'Bash(git*commit*)', asyncRewake: true }] },
				{ matcher: 'Skill', hooks: [{ type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/post.mjs'] }] }
			]
		}
	};
	assert.deepEqual(
		hooksFrom(settings, 'plugin').map(({ command, async, condition }) => ({ command, async, condition })),
		[
			{ command: 'review.sh', async: true, condition: 'Bash(git*commit*)' },
			{ command: 'node ${CLAUDE_PLUGIN_ROOT}/post.mjs', async: false, condition: undefined }
		]
	);
});

test('plugins: enabled user plugins, and project plugins only for a project given on the command line', () => {
	const installed = {
		plugins: {
			'lint@acme': [{ scope: 'user', installPath: '/p/lint/2', lastUpdated: '2026-10-02' }],
			'off@acme': [{ scope: 'user', installPath: '/p/off/1', lastUpdated: '2026-10-01' }],
			'local@acme': [
				{ scope: 'local', projectPath: REPO, installPath: '/p/local/1', lastUpdated: '2026-09-01' },
				{ scope: 'local', projectPath: REPO, installPath: '/p/local/2', lastUpdated: '2026-10-01' },
				{ scope: 'local', projectPath: '/home/dev/other', installPath: '/p/local/3', lastUpdated: '2026-10-05' }
			]
		}
	};
	const enabled = { 'lint@acme': true, 'off@acme': false };
	assert.deepEqual(pluginHookSources(installed, enabled, { [REPO]: { 'local@acme': true } }), [
		{ plugin: 'lint@acme', installPath: '/p/lint/2' },
		{ plugin: 'local@acme', installPath: '/p/local/2', project: REPO }
	]);
});

test('traces: a hook that printed output, with the command it ran', () => {
	assert.deepEqual(tracesOf(SUCCESS), [{ t: at(0), cwd: REPO, event: 'PreToolUse', name: 'PreToolUse:Bash', command: '/home/dev/.claude/hooks/guard.sh', async: false, durationMs: 40 }]);
});

test('traces: a timeout is an error; a Stop timeout is left to the stop summary', () => {
	assert.equal(tracesOf(TIMED_OUT)[0].error, 'timed out after 5 s');
	assert.deepEqual(tracesOf(STOP_CANCELLED), []);
});

test('traces: a non-blocking error keeps the first line of stderr', () => {
	assert.equal(tracesOf(NON_BLOCKING)[0].error, 'Failed with non-blocking status code: boom');
});

test('traces: an async response is async, and an empty command is no command', () => {
	const [found] = tracesOf(ASYNC);
	assert.equal(found.async, true);
	assert.equal(found.command, undefined);
	assert.equal(tracesOf(attachment(4, { ...ASYNC.attachment, exitCode: 1 }))[0].error, 'exit code 1');
	assert.equal(tracesOf(attachment(4, { ...ASYNC.attachment, exitCode: 2 }))[0].error, undefined);
});

test('traces: context, system message and blocking error carry no command and are no error', () => {
	for (const entry of [ADDITIONAL_CONTEXT, SYSTEM_MESSAGE, BLOCKING]) {
		const [found] = tracesOf(entry);
		assert.equal(found.command, undefined);
		assert.equal(found.error, undefined);
	}
	assert.equal(tracesOf(BLOCKING)[0].name, 'PostToolUse:Edit');
});

test('traces: the stop summary names every Stop hook that ran, quiet or not', () => {
	assert.deepEqual(
		tracesOf(STOP_SUMMARY).map(({ command, durationMs }) => ({ command, durationMs })),
		[
			{ command: '/home/dev/.claude/hooks/gate.sh', durationMs: 10031 },
			{ command: 'node "${CLAUDE_PLUGIN_ROOT}/stop.mjs"', durationMs: undefined }
		]
	);
});

test('traces: a row without a hook gives nothing', () => {
	assert.deepEqual(tracesOf(row(0, { type: 'user', message: { content: 'hello' } })), []);
	assert.deepEqual(tracesOf(null), []);
});

test('occurrences: tool calls, successful tool results, prompts, stop summaries, session starts, compactions', () => {
	const entries = [
		row(0, { type: 'user', message: { content: 'fix the bug' } }),
		row(1, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Edit', input: {} }, { type: 'tool_use', id: 'b', name: 'Bash', input: {} }] } }),
		row(2, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }, { type: 'tool_result', tool_use_id: 'b', is_error: true, content: 'Exit code 1' }] } }),
		attachment(0, { type: 'hook_success', hookName: 'SessionStart:startup', hookEvent: 'SessionStart', command: 'a', stdout: 'x' }),
		attachment(0, { type: 'hook_success', hookName: 'SessionStart:startup', hookEvent: 'SessionStart', command: 'b', stdout: 'x' }),
		row(3, { type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto' } }),
		STOP_SUMMARY
	];
	assert.deepEqual(
		occurrencesOf(entries).map((found) => found.name),
		['UserPromptSubmit', 'PreToolUse:Edit', 'PreToolUse:Bash', 'PostToolUse:Edit', 'SessionStart:startup', 'PreCompact:auto', 'Stop']
	);
});

test('occurrences: two session-start traces within a minute are one session start', () => {
	const start = (minute: number) => attachment(minute, { type: 'hook_success', hookName: 'SessionStart:compact', hookEvent: 'SessionStart', command: 'a', stdout: 'x' });
	const twentySecondsLater = { ...start(0), timestamp: new Date(Date.parse(at(0)) + 20_000).toISOString() };
	assert.equal(occurrencesOf([start(0), twentySecondsLater, start(30)]).length, 2);
});

test('verdict: no fire while the event happened and the hook used to leave traces is silent', () => {
	assert.deepEqual(verdictOf({ fires: [], shared: 0, occurrences: 40, expected: 20 }), { verdict: 'silent', reason: 'no trace in 40 events, 20 expected' });
});

test('verdict: a hook whose event never happened is not dead', () => {
	assert.deepEqual(verdictOf({ fires: [], shared: 0, occurrences: 0, expected: 0 }), { verdict: 'unknown', reason: 'the event did not occur' });
});

test('verdict: few expected traces is too little to call a hook silent', () => {
	assert.equal(verdictOf({ fires: [], shared: 0, occurrences: 40, expected: 4.9 }).verdict, 'unknown');
	assert.equal(verdictOf({ fires: [], shared: 0, occurrences: 40, expected: 5 }).verdict, 'silent');
});

test('verdict: a hook that never left a trace before the window is unknown, not silent', () => {
	assert.deepEqual(verdictOf({ fires: [], shared: 0, occurrences: 40, expected: null }), {
		verdict: 'unknown',
		reason: 'no trace before the window: a quiet hook, or dead from the start'
	});
});

test('verdict: no event count is unknown', () => {
	assert.deepEqual(verdictOf({ fires: [], shared: 0, occurrences: null, expected: 9 }), { verdict: 'unknown', reason: 'no event count for this hook' });
});

test('verdict: anonymous traces that could be the hook are unknown, not silent', () => {
	assert.equal(verdictOf({ fires: [], shared: 3, occurrences: 40, expected: 20 }).verdict, 'unknown');
});

test('verdict: the last three fires are errors is erroring; one success among them is alive', () => {
	const error = { t: at(1), error: 'x' };
	const ok = { t: at(2) };
	assert.equal(verdictOf({ fires: [ok, error, error, error], shared: 0, occurrences: 4, expected: 4 }).verdict, 'erroring');
	assert.equal(verdictOf({ fires: [error, error, ok, error], shared: 0, occurrences: 4, expected: 4 }).verdict, 'alive');
	assert.equal(verdictOf({ fires: [error], shared: 0, occurrences: 4, expected: 4 }).verdict, 'erroring');
	assert.equal(verdictOf({ fires: [ok], shared: 0, occurrences: 4, expected: 4 }).verdict, 'alive');
	assert.equal(verdictOf({ fires: [ok, error, error], shared: 0, occurrences: 4, expected: 4 }).verdict, 'alive');
});

test('heartbeat: traces match by command, or by status message, then by matcher', () => {
	const guard = hook({});
	const lint = hook({ event: 'PostToolUse', matcher: 'Write|Edit', command: 'lint.sh', statusMessage: 'Linting...' });
	const traces = [...tracesOf(SUCCESS), ...tracesOf(WITH_STATUS), trace(9, { name: 'PreToolUse:Read' })];
	const [guardRow, lintRow] = heartbeat([guard, lint], { traces, occurrences: [] }, { traces: [], occurrences: [] }).hooks;
	assert.equal(guardRow.fires, 2);
	assert.equal(guardRow.lastFire, at(9));
	assert.equal(lintRow.fires, 1);
});

test('heartbeat: the matcher bounds the events a hook can miss', () => {
	const edit = hook({ event: 'PostToolUse', matcher: 'Edit', command: 'mutate.sh' });
	const baseline = { traces: [trace(0, { event: 'PostToolUse', name: 'PostToolUse:Edit', command: 'mutate.sh' })], occurrences: [occurrence(0, 'PostToolUse:Edit')] };
	const bash = Array.from({ length: 10 }, (_, minute) => occurrence(minute, 'PostToolUse:Bash'));
	assert.equal(heartbeat([edit], { traces: [], occurrences: bash }, baseline).hooks[0].occurrences, 0);
	const edits = Array.from({ length: 10 }, (_, minute) => occurrence(minute, 'PostToolUse:Edit'));
	const [found] = heartbeat([edit], { traces: [], occurrences: edits }, baseline).hooks;
	assert.deepEqual([found.occurrences, found.expected, found.verdict], [10, 10, 'silent']);
});

test('heartbeat: a matcher of star or nothing matches every tool, a broken regex matches itself only', () => {
	const occurrences = [occurrence(0, 'PreToolUse:Bash'), occurrence(1, 'PreToolUse:mcp__acme__run'), occurrence(2, 'PreToolUse:(')];
	const counts = ['', '*', 'mcp__acme__.*', '('].map((matcher) => heartbeat([hook({ matcher })], { traces: [], occurrences }, { traces: [], occurrences: [] }).hooks[0].occurrences);
	assert.deepEqual(counts, [3, 3, 1, 1]);
});

test('heartbeat: a Stop hook missing from the stop summaries is silent with no history', () => {
	const gate = hook({ event: 'Stop', command: 'gate.sh' });
	const stops = Array.from({ length: 6 }, (_, minute) => occurrence(minute, 'Stop'));
	const [found] = heartbeat([gate], { traces: [], occurrences: stops }, { traces: [], occurrences: [] }).hooks;
	assert.deepEqual([found.expected, found.verdict], [6, 'silent']);
});

test('heartbeat: a Stop run that took the whole timeout is an error', () => {
	const gate = hook({ event: 'Stop', command: '/home/dev/.claude/hooks/gate.sh', timeoutSec: 10 });
	const [found] = heartbeat([gate], { traces: tracesOf(STOP_SUMMARY), occurrences: [] }, { traces: [], occurrences: [] }).hooks;
	assert.deepEqual([found.errors, found.lastError, found.verdict], [1, 'timed out after 10 s', 'erroring']);
});

test('heartbeat: a trace without a command goes to the only candidate, else stays anonymous', () => {
	const nudge = hook({ event: 'UserPromptSubmit', command: 'nudge.sh' });
	const warn = hook({ event: 'UserPromptSubmit', command: 'warn.sh' });
	const traces = tracesOf(SYSTEM_MESSAGE);
	assert.equal(heartbeat([nudge], { traces, occurrences: [] }, { traces: [], occurrences: [] }).hooks[0].fires, 1);
	const shared = heartbeat([nudge, warn], { traces, occurrences: [] }, { traces: [], occurrences: [] });
	assert.deepEqual(shared.hooks.map((found) => [found.fires, found.shared, found.verdict]), [[0, 1, 'unknown'], [0, 1, 'unknown']]);
	assert.deepEqual(shared.unattributed, { UserPromptSubmit: 1 });
});

test('heartbeat: an async response goes to async hooks only, and a plugin trace to its plugin', () => {
	const sync = hook({ event: 'PostToolUse', matcher: 'Write', command: 'lint.sh' });
	const typecheck = hook({ event: 'PostToolUse', matcher: 'Write', command: 'types.sh', async: true });
	const [syncRow, asyncRow] = heartbeat([sync, typecheck], { traces: tracesOf(ASYNC), occurrences: [] }, { traces: [], occurrences: [] }).hooks;
	assert.deepEqual([syncRow.fires, asyncRow.fires], [0, 1]);

	const command = 'run.sh';
	const mine = hook({ source: 'plugin', plugin: 'a@acme', command, async: true, event: 'PostToolUse' });
	const theirs = hook({ source: 'plugin', plugin: 'b@acme', command, async: true, event: 'PostToolUse' });
	const fromA = trace(0, { event: 'PostToolUse', name: 'PostToolUse:Write', command, plugin: 'a@acme', async: true });
	assert.deepEqual(heartbeat([mine, theirs], { traces: [fromA], occurrences: [] }, { traces: [], occurrences: [] }).hooks.map((found) => found.fires), [1, 0]);
});

test('heartbeat: a sync trace never goes to an async hook; an anonymous async trace may be any async hook', () => {
	const sync = hook({ event: 'SessionStart', command: 'index.sh' });
	const background = hook({ event: 'SessionStart', command: 'refresh.sh', async: true });
	const pluginBackground = hook({ source: 'plugin', plugin: 'a@acme', event: 'SessionStart', command: 'scan.sh', async: true });
	const context = trace(0, { event: 'SessionStart', name: 'SessionStart:startup', command: undefined });
	// Claude Code 2.1 before mid-October wrote plugin async responses with no command and no pluginId.
	const response = trace(1, { event: 'SessionStart', name: 'SessionStart:startup', command: undefined, async: true });
	const rows = heartbeat([sync, background, pluginBackground], { traces: [context, response], occurrences: [] }, { traces: [], occurrences: [] }).hooks;
	assert.deepEqual(rows.map((found) => [found.fires, found.shared]), [[1, 0], [0, 1], [0, 1]]);
});

test('heartbeat: the stop summary lists async Stop hooks too', () => {
	const rewake = hook({ event: 'Stop', command: 'node "${CLAUDE_PLUGIN_ROOT}/stop.mjs"', async: true });
	const [found] = heartbeat([rewake], { traces: tracesOf(STOP_SUMMARY), occurrences: [] }, { traces: [], occurrences: [] }).hooks;
	assert.equal(found.fires, 1);
});

test('heartbeat: an if condition narrows the event below what the transcript counts', () => {
	const review = hook({ event: 'PostToolUse', matcher: 'Bash', command: 'review.sh', condition: 'Bash(git*commit*)' });
	const [found] = heartbeat([review], { traces: [], occurrences: [occurrence(0, 'PostToolUse:Bash')] }, { traces: [], occurrences: [] }).hooks;
	assert.deepEqual([found.occurrences, found.verdict], [null, 'unknown']);
});

test('heartbeat: a project hook counts the events of its project only', () => {
	const local = hook({ project: REPO });
	const occurrences = [occurrence(0), { ...occurrence(1), cwd: '/home/dev/other' }, { ...occurrence(2), cwd: `${REPO}/.claude/worktrees/x` }];
	const traces = [trace(0), trace(1, { cwd: '/home/dev/other' })];
	const [found] = heartbeat([local], { traces, occurrences }, { traces: [], occurrences: [] }).hooks;
	assert.deepEqual([found.occurrences, found.fires], [2, 1]);
});

test('heartbeat: an anonymous trace after the last error keeps a timing-out hook alive', () => {
	const nudge = hook({ event: 'UserPromptSubmit', command: 'nudge.sh' });
	const warn = hook({ event: 'UserPromptSubmit', command: 'warn.sh' });
	const timeout = trace(0, { event: 'UserPromptSubmit', name: 'UserPromptSubmit', command: 'nudge.sh', error: 'timed out after 5 s' });
	const later = trace(1, { event: 'UserPromptSubmit', name: 'UserPromptSubmit', command: undefined });
	const [found] = heartbeat([nudge, warn], { traces: [timeout, later], occurrences: [] }, { traces: [], occurrences: [] }).hooks;
	assert.deepEqual([found.errors, found.verdict], [1, 'alive']);
});

test('heartbeat: the expected count comes from the trace rate before the window', () => {
	const baseline = { traces: [trace(0), trace(1)], occurrences: Array.from({ length: 8 }, (_, minute) => occurrence(minute)) };
	const window = { traces: [], occurrences: Array.from({ length: 20 }, (_, minute) => occurrence(minute)) };
	assert.equal(heartbeat([hook({})], window, baseline).hooks[0].expected, 5);
});
