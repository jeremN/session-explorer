import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { codexHome, codexInvocation, codexOutcome, opencodeInvocation, opencodeMajor, opencodeOutcome, unwrapShell } from './agents.ts';
import { scoreRun } from './score.ts';

const root = mkdtempSync(join(tmpdir(), 'eval-agents-'));
after(() => rmSync(root, { recursive: true, force: true }));

const lines = (events: unknown[]) => events.map((event) => JSON.stringify(event)).join('\n');
const START = Date.parse('2026-11-17T10:00:00Z');

test('unwrapShell gives the command inside `zsh -lc`, with its quotes restored', () => {
	assert.equal(unwrapShell("/bin/zsh -lc 'node --test'"), 'node --test');
	assert.equal(unwrapShell(`/bin/zsh -lc "rg -g 'AGENTS.md' --files"`), "rg -g 'AGENTS.md' --files");
	assert.equal(unwrapShell("/bin/bash -lc 'echo '\\''hi'\\'''"), "echo 'hi'");
	assert.equal(unwrapShell('npm test'), 'npm test');
});

test('codexHome holds the login and nothing else, in a private folder', () => {
	const source = join(root, 'codex-source');
	mkdirSync(source);
	writeFileSync(join(source, 'auth.json'), '{}');
	writeFileSync(join(source, 'config.toml'), 'model = "x"');
	writeFileSync(join(source, 'AGENTS.md'), 'Read ~/.claude/skills.');
	const home = codexHome(source);
	assert.deepEqual(readdirSync(home), ['auth.json']);
	assert.equal(statSync(home).mode & 0o777, 0o700);
});

test('the codex and opencode argv: sandbox, no user config, the model, and the prompt', () => {
	const codex = codexInvocation({ name: 'a', agent: 'codex', model: 'gpt-x' }, '/h', 'Fix it.');
	assert.deepEqual(codex.args, ['exec', '--json', '--sandbox', 'workspace-write', '--ephemeral', '--ignore-rules', '--skip-git-repo-check', '--model', 'gpt-x', '-']);
	assert.equal(codex.input, 'Fix it.');
	assert.equal(codex.env.CODEX_HOME, '/h');
	assert.equal(codex.env.GIT_CONFIG_VALUE_0, 'never');
	const opencode = opencodeInvocation({ name: 'b', agent: 'opencode', sandbox: false }, '/x', '--danger', '/clone');
	// The prompt comes after `--`, so a prompt that starts with a dash is never an option.
	// opencode works in $PWD unless --dir names the folder.
	assert.deepEqual(opencode.args, ['run', '--format', 'json', '--auto', '--pure', '--dir', '/clone', '--', '--danger']);
	assert.deepEqual([opencode.env.XDG_CONFIG_HOME, opencode.env.OPENCODE_DISABLE_CLAUDE_CODE], ['/x', '1']);
	// opencode 2 refuses --pure and --dir: it works in its cwd, on a private server.
	const v2 = opencodeInvocation({ name: 'b', agent: 'opencode', sandbox: false, model: 'm/x' }, '/x', 'Fix it.', '/clone', 'opencode v2.3.2');
	assert.deepEqual(v2.args, ['--standalone', 'run', '--format', 'json', '--auto', '--model', 'm/x', '--', 'Fix it.']);
	assert.deepEqual(opencodeInvocation({ name: 'b', agent: 'opencode', sandbox: false }, '/x', 'p', '/clone', '1.19.6').args.slice(4, 7), ['--pure', '--dir', '/clone']);
	assert.deepEqual([opencodeMajor('opencode v2.3.2'), opencodeMajor('1.19.6'), opencodeMajor('unknown'), opencodeMajor(undefined)], [2, 1, 1, 1]);
});

const codexEvents = [
	{ type: 'thread.started', thread_id: 't' },
	{ type: 'item.completed', item: { id: 'i1', type: 'file_change', changes: [{ path: '/c/hello.js', kind: 'add' }, { path: '/c/a.js', kind: 'update' }], status: 'completed' } },
	{ type: 'item.completed', item: { id: 'i2', type: 'command_execution', command: "/bin/zsh -lc 'node --test'", aggregated_output: 'not ok', exit_code: 1, status: 'failed' } },
	{ type: 'item.completed', item: { id: 'i3', type: 'command_execution', command: "/bin/zsh -lc 'node --test'", aggregated_output: 'ok', exit_code: 0, status: 'completed' } },
	{ type: 'item.completed', item: { id: 'i4', type: 'agent_message', text: 'Done.' } },
	{ type: 'turn.completed', usage: { input_tokens: 1_000_000, cached_input_tokens: 800_000, output_tokens: 10_000, reasoning_output_tokens: 2_000 } }
];

test('codexOutcome: the events become a transcript the pipeline scores, priced by the config', () => {
	const outcome = codexOutcome(lines(codexEvents), { model: 'gpt-x', prompt: 'Fix it.', start: START, price: { input: 1, output: 10, cacheRead: 0.1 } });
	assert.equal(outcome.isError, false);
	// 200k fresh at 1 $, 800k read at 0.1 $, 10k out at 10 $: 0.2 + 0.08 + 0.1.
	assert.equal(Math.round(outcome.costUsd! * 1000) / 1000, 0.38);
	const scored = scoreRun(outcome.entries!, {}, 's1')!;
	assert.equal(scored.metrics.errors, 1);
	assert.equal(scored.metrics.verified, 1);
	// Billed tokens leave out the cache reads: 200k fresh and 10k out.
	assert.equal(scored.metrics.billedTokens, 210_000);
	assert.equal(scored.metrics.cacheReadShare, 0.8);
});

test('codexOutcome: no price gives no cost and a note; a failed turn or a missing end is an error', () => {
	const unpriced = codexOutcome(lines(codexEvents), { model: 'gpt-x', prompt: 'x', start: START });
	assert.equal(unpriced.costUsd, null);
	assert.match(unpriced.note!, /no price for model gpt-x/);
	assert.equal(unpriced.isError, false);
	const failed = codexOutcome(lines([...codexEvents.slice(0, 2), { type: 'turn.failed', error: { message: 'quota' } }]), { prompt: 'x', start: START });
	assert.deepEqual([failed.isError, failed.note], [true, 'quota']);
	const cut = codexOutcome(lines(codexEvents.slice(0, 3)) + '\n{"type":"item.comp', { prompt: 'x', start: START });
	assert.equal(cut.isError, true);
	assert.match(cut.note!, /no turn.completed/);
});

const opencodeEvents = [
	{ type: 'tool_use', timestamp: START + 1000, part: { id: 'p1', tool: 'write', callID: 'c1', state: { status: 'completed', input: { filePath: '/c/a.js' }, output: '' } } },
	{ type: 'tool_use', timestamp: START + 2000, part: { id: 'p2', tool: 'bash', callID: 'c2', state: { status: 'completed', input: { command: 'npm test' }, output: 'fail', metadata: { exit: 1 } } } },
	{ type: 'tool_use', timestamp: START + 3000, part: { id: 'p3', tool: 'bash', callID: 'c3', state: { status: 'completed', input: { command: 'npm test' }, output: 'ok', metadata: { exit: 0 } } } },
	{ type: 'step_finish', timestamp: START + 4000, part: { id: 'p4', reason: 'tool-calls', tokens: { input: 1000, output: 50, reasoning: 10, cache: { read: 500, write: 0 } }, cost: 0.0021 } },
	{ type: 'step_finish', timestamp: START + 5000, part: { id: 'p5', reason: 'stop', tokens: { input: 100, output: 5, reasoning: 0, cache: { read: 1500, write: 0 } }, cost: 0.0004 } }
];

test('opencodeOutcome: the cost is the sum of the steps, and a shell exit code other than 0 is an error', () => {
	const outcome = opencodeOutcome(lines(opencodeEvents), { prompt: 'Fix it.', start: START });
	assert.equal(outcome.isError, false);
	assert.equal(Math.round(outcome.costUsd! * 10_000) / 10_000, 0.0025);
	const scored = scoreRun(outcome.entries!, {}, 's2')!;
	assert.equal(scored.metrics.errors, 1);
	assert.equal(scored.metrics.verified, 1);
	// Fresh input and output, reasoning included. The cache reads are not billed tokens.
	assert.equal(scored.metrics.billedTokens, 1000 + 60 + 100 + 5);
});

test('opencodeOutcome: opencode 2 names the file `path`, and a cost of 0 for billed tokens is an unknown cost', () => {
	const v2 = opencodeEvents.map((event) => (event.type === 'step_finish' ? { ...event, part: { ...event.part, cost: 0 } } : event));
	v2.splice(1, 0, { type: 'tool_use', timestamp: START + 500, part: { id: 'p9', callID: 'c9', tool: 'write', state: { status: 'completed', input: { path: '/clone/b.txt', content: 'ok' }, output: '' } } } as (typeof opencodeEvents)[number]);
	const outcome = opencodeOutcome(lines(v2), { prompt: 'x', start: START });
	assert.equal(outcome.costUsd, null);
	assert.match(outcome.note ?? '', /cost of 0 for billed tokens/);
	assert.equal(outcome.isError, false);
	const write = outcome.entries.flatMap((row) => ((row as { message?: { content?: unknown[] } }).message?.content ?? []) as { name?: string; input?: { file_path?: string } }[]).filter((part) => part.name === 'Write');
	assert.ok(write.some((part) => part.input?.file_path === '/clone/b.txt'));
});

test('opencodeOutcome: an error event, or no step with reason stop, is an error', () => {
	const failed = opencodeOutcome(lines([...opencodeEvents, { type: 'error', error: { name: 'APIError', data: { message: 'rate limited' } } }]), { prompt: 'x', start: START });
	assert.deepEqual([failed.isError, failed.note], [true, 'rate limited']);
	const cut = opencodeOutcome(lines(opencodeEvents.slice(0, 4)), { prompt: 'x', start: START });
	assert.equal(cut.isError, true);
});

test('codex gets its effort as a quoted TOML value', () => {
	const { args } = codexInvocation({ name: 'a', agent: 'codex', model: 'gpt-x', effort: 'high' }, '/h', 'Fix it.');
	assert.deepEqual(args.slice(-3), ['-c', 'model_reasoning_effort="high"', '-']);
});

