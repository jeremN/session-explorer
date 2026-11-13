import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { SpecError, loadSpec, validateSpec } from './spec.ts';

const base = () => ({
	name: 'demo',
	task: { repo: '../repo', prompt: 'Do it', acceptance: { command: 'true' } },
	budget: { perRunUsd: 1, perEvalUsd: 6 },
	configs: [{ name: 'baseline' }]
});
const failure = (raw: unknown, field: string) =>
	assert.throws(
		() => validateSpec(raw, '/specs/demo'),
		(error: unknown) => error instanceof SpecError && error.message.includes(field) && error.exitCode === 2
	);

test('a minimal spec gets its defaults and absolute paths', () => {
	const spec = validateSpec(base(), '/specs/demo');
	assert.equal(spec.runs, 3);
	assert.equal(spec.task.repo, '/specs/repo');
	assert.equal(spec.task.base, 'HEAD');
	assert.equal(spec.task.timeoutSec, 900);
	assert.equal(spec.task.acceptance.timeoutSec, 300);
	assert.equal(spec.task.promptFile, undefined);
	assert.equal(spec.dir, '/specs/demo');
});

test('a null promptFile counts as absent', () => {
	assert.equal(validateSpec({ ...base(), task: { ...base().task, promptFile: null } }, '/s').task.prompt, 'Do it');
});

test('config paths resolve against the spec directory', () => {
	const raw = { ...base(), configs: [{ name: 'a', claudeMd: { file: 'terse.md' }, skills: ['skills/x'], plugins: ['/abs/plugin'], settings: 'settings.json', mcpConfig: { mcpServers: {} } }] };
	const [config] = validateSpec(raw, '/specs/demo').configs;
	assert.deepEqual(config.claudeMd, { file: '/specs/demo/terse.md' });
	assert.deepEqual(config.skills, ['/specs/demo/skills/x']);
	assert.deepEqual(config.plugins, ['/abs/plugin']);
	assert.equal(config.settings, '/specs/demo/settings.json');
	assert.deepEqual(config.mcpConfig, { mcpServers: {} });
});

test('a missing budget field is refused and the message names it', () => {
	failure({ ...base(), budget: { perEvalUsd: 6 } }, 'spec.budget.perRunUsd');
	failure({ ...base(), budget: { perRunUsd: 1 } }, 'spec.budget.perEvalUsd');
	failure({ ...base(), budget: undefined }, 'spec.budget');
});

test('prompt and promptFile together, or neither, are refused', () => {
	failure({ ...base(), task: { ...base().task, promptFile: 'p.md' } }, 'spec.task.prompt');
	failure({ ...base(), task: { repo: 'r', acceptance: { command: 'true' } } }, 'spec.task.prompt');
});

test('a duplicate config name is refused', () => {
	failure({ ...base(), configs: [{ name: 'a' }, { name: 'a' }] }, 'spec.configs[1].name');
});

test('bypassPermissions is refused, a known mode is kept', () => {
	failure({ ...base(), configs: [{ name: 'a', permissionMode: 'bypassPermissions' }] }, 'spec.configs[0].permissionMode');
	assert.equal(validateSpec({ ...base(), configs: [{ name: 'a', permissionMode: 'plan' }] }, '/s').configs[0].permissionMode, 'plan');
});

test('other fields are checked: slug, runs range, config count, acceptance, unknown field, bad type', () => {
	failure({ ...base(), name: 'Bad Name' }, 'spec.name');
	failure({ ...base(), runs: 21 }, 'spec.runs');
	failure({ ...base(), runs: 0 }, 'spec.runs');
	failure({ ...base(), configs: [] }, 'spec.configs');
	failure({ ...base(), task: { ...base().task, acceptance: {} } }, 'spec.task.acceptance.command');
	failure({ ...base(), configs: [{ name: 'a', modle: 'x' }] }, 'spec.configs[0].modle');
	failure({ ...base(), configs: [{ name: 'a', bare: 'yes' }] }, 'spec.configs[0].bare');
	failure({ ...base(), budget: { perRunUsd: 0, perEvalUsd: 6 } }, 'spec.budget.perRunUsd');
	failure('nope', 'spec');
});

test('loadSpec reads promptFile and names a missing or invalid file', () => {
	const dir = mkdtempSync(join(tmpdir(), 'eval-spec-'));
	try {
		writeFileSync(join(dir, 'p.md'), 'Prompt from file\n');
		writeFileSync(join(dir, 'spec.json'), JSON.stringify({ ...base(), task: { repo: '.', promptFile: 'p.md', acceptance: { command: 'true' } } }));
		const spec = loadSpec(join(dir, 'spec.json'));
		assert.equal(spec.task.prompt, 'Prompt from file\n');
		assert.equal(spec.dir, dir);
		assert.throws(() => loadSpec(join(dir, 'missing.json')), SpecError);
		writeFileSync(join(dir, 'bad.json'), '{');
		assert.throws(() => loadSpec(join(dir, 'bad.json')), /not valid JSON/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
