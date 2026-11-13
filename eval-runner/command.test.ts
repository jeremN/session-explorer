import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildCommand, setupFiles } from './command.ts';
import type { Config } from './spec.ts';

const context = { sessionId: '11111111-2222-3333-4444-555555555555', perRunUsd: 1, runDir: '/out/e/runs/baseline-1' };
const ALWAYS = ['-p', '--output-format', 'json', '--session-id', context.sessionId, '--max-budget-usd', '1', '--permission-prompts', 'none', '--setting-sources', 'project,local'];

test('an empty config gets the always-on flags, a strict empty MCP config and the push ban', () => {
	const { args, files } = buildCommand({ name: 'baseline' }, context);
	assert.deepEqual(args, [...ALWAYS, '--permission-mode', 'auto', '--mcp-config', '/out/e/runs/baseline-1/mcp.json', '--strict-mcp-config', '--disallowedTools', 'Bash(git push:*)']);
	assert.deepEqual(files, [{ path: '/out/e/runs/baseline-1/mcp.json', content: '{"mcpServers":{}}' }]);
});

test('a config that sets every field maps each one to its flag or file', () => {
	const config: Config = {
		name: 'full',
		model: 'sonnet',
		claudeMd: { text: 'Be terse.' },
		appendSystemPrompt: 'Answer in one line.',
		settings: { hooks: {} },
		skills: ['/s/skills/x'],
		plugins: ['/p/one', '/p/two'],
		permissionMode: 'acceptEdits',
		allowedTools: ['Read', 'Bash(node:*)'],
		disallowedTools: ['WebFetch'],
		mcpConfig: { mcpServers: { a: { command: 'x' } } },
		bare: true
	};
	const { args, files } = buildCommand(config, context);
	assert.deepEqual(args, [
		...ALWAYS,
		'--permission-mode',
		'acceptEdits',
		'--bare',
		'--model',
		'sonnet',
		'--append-system-prompt',
		'Answer in one line.',
		'--settings',
		'/out/e/runs/baseline-1/settings.json',
		'--plugin-dir',
		'/p/one',
		'--plugin-dir',
		'/p/two',
		'--mcp-config',
		'/out/e/runs/baseline-1/mcp.json',
		'--strict-mcp-config',
		'--allowedTools',
		'Read',
		'Bash(node:*)',
		'--disallowedTools',
		'Bash(git push:*)',
		'WebFetch'
	]);
	assert.deepEqual(files, [
		{ path: '/out/e/runs/baseline-1/settings.json', content: '{"hooks":{}}' },
		{ path: '/out/e/runs/baseline-1/mcp.json', content: '{"mcpServers":{"a":{"command":"x"}}}' }
	]);
});

test('settings and MCP config given as a file path are copied into the run directory', () => {
	const read = (path: string) => `content of ${path}`;
	const { files } = buildCommand({ name: 'a', settings: '/s/settings.json', mcpConfig: '/s/mcp.json' }, context, read);
	assert.deepEqual(files, [
		{ path: '/out/e/runs/baseline-1/settings.json', content: 'content of /s/settings.json' },
		{ path: '/out/e/runs/baseline-1/mcp.json', content: 'content of /s/mcp.json' }
	]);
});

test('setupFiles lists the CLAUDE.md source and the skill directories for the setup commit', () => {
	assert.deepEqual(setupFiles({ name: 'a' }), { claudeMd: undefined, skills: [] });
	assert.deepEqual(setupFiles({ name: 'a', claudeMd: { text: 'x' }, skills: ['/s/skills/x'] }), { claudeMd: { text: 'x' }, skills: ['/s/skills/x'] });
});
