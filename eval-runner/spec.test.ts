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

test('hiddenTests names a commit and relative paths that stay in the clone', () => {
	const task = (hiddenTests: unknown) => ({ ...base(), task: { ...base().task, hiddenTests } });
	assert.deepEqual(validateSpec(task({ commit: 'abc123', paths: ['test/a.test.ts'] }), '/s').task.hiddenTests, { commit: 'abc123', paths: ['test/a.test.ts'] });
	assert.equal(validateSpec(base(), '/s').task.hiddenTests, undefined);
	failure(task({ commit: 'abc123', paths: [] }), 'spec.task.hiddenTests.paths');
	failure(task({ commit: 'abc123', paths: ['../x.ts'] }), 'spec.task.hiddenTests.paths');
	failure(task({ commit: 'abc123', paths: ['/etc/x'] }), 'spec.task.hiddenTests.paths');
	failure(task({ commit: 'abc123', paths: ['.git/hooks/x'] }), 'spec.task.hiddenTests.paths');
	failure(task({ paths: ['a.ts'] }), 'spec.task.hiddenTests.commit');
});

test('sandbox is an optional boolean', () => {
	assert.equal(validateSpec({ ...base(), configs: [{ name: 'a', sandbox: true }] }, '/s').configs[0].sandbox, true);
	assert.equal(validateSpec(base(), '/s').configs[0].sandbox, undefined);
	failure({ ...base(), configs: [{ name: 'a', sandbox: 'yes' }] }, 'spec.configs[0].sandbox');
});

test('task.services: a container per run with its agent environment; names, variables and the ready command are checked', () => {
	const db = { name: 'db', image: 'postgres:17', port: 5432, env: { POSTGRES_PASSWORD: 'test' }, tmpfs: ['/var/lib/postgresql/data'], ready: ['pg_isready', '-h', '127.0.0.1'], agentEnv: { TEST_DATABASE_URL: 'postgres://postgres:test@${host}:${port}/t' } };
	const withServices = (services: unknown) => ({ ...base(), task: { ...base().task, services } });
	assert.deepEqual(validateSpec(withServices([db]), '/s').task.services, [db]);
	assert.equal(validateSpec(base(), '/s').task.services, undefined);
	failure(withServices([]), 'spec.task.services');
	failure(withServices([{ ...db, name: 'DB' }]), 'spec.task.services[0].name');
	failure(withServices([{ ...db, name: 'eval-proxy' }]), 'spec.task.services[0].name');
	failure(withServices([db, db]), 'spec.task.services[1].name');
	failure(withServices([{ ...db, ready: [] }]), 'spec.task.services[0].ready');
	failure(withServices([{ ...db, agentEnv: {} }]), 'spec.task.services[0].agentEnv');
	failure(withServices([{ ...db, agentEnv: { HTTPS_PROXY: 'x' } }]), 'spec.task.services[0].agentEnv.HTTPS_PROXY');
	failure(withServices([{ ...db, agentEnv: { 'A-B': 'x' } }]), 'spec.task.services[0].agentEnv.A-B');
	failure(withServices([{ ...db, env: { A: 1 } }]), 'spec.task.services[0].env.A');
	failure(withServices([{ ...db, tmpfs: ['data'] }]), 'spec.task.services[0].tmpfs');
	failure(withServices([{ ...db, port: 70000 }]), 'spec.task.services[0].port');
	failure(withServices([{ ...db, volumes: ['/x'] }]), 'spec.task.services[0].volumes');
	assert.deepEqual(validateSpec(withServices([{ ...db, capAdd: ['CHOWN', 'SETUID'] }]), '/s').task.services?.[0].capAdd, ['CHOWN', 'SETUID']);
	for (const cap of ['ALL', 'SYS_ADMIN', 'chown']) failure(withServices([{ ...db, capAdd: [cap] }]), 'spec.task.services[0].capAdd');
});

test('other fields are checked: slug, runs range, config count, acceptance, unknown field, bad type', () => {
	failure({ ...base(), name: 'Bad Name' }, 'spec.name');
	failure({ ...base(), runs: 21 }, 'spec.runs');
	failure({ ...base(), runs: 0 }, 'spec.runs');
	failure({ ...base(), configs: [] }, 'spec.configs');
	failure({ ...base(), task: { ...base().task, acceptance: {} } }, 'spec.task.acceptance.command');
	assert.equal(validateSpec({ ...base(), task: { ...base().task, acceptance: { command: 'true', infraExitCode: 3 } } }, '/s').task.acceptance.infraExitCode, 3);
	for (const code of [0, 1, 256, 2.5, '3']) failure({ ...base(), task: { ...base().task, acceptance: { command: 'true', infraExitCode: code } } }, 'spec.task.acceptance.infraExitCode');
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

test('agent: claude stays unset, codex and opencode refuse the Claude Code options, opencode needs sandbox false', () => {
	const withConfig = (config: Record<string, unknown>) => ({ ...base(), configs: [{ name: 'a', ...config }] });
	assert.equal(validateSpec(withConfig({ agent: 'claude' }), '/s').configs[0].agent, undefined);
	assert.equal(validateSpec(withConfig({ agent: 'codex', model: 'gpt-x', claudeMd: { text: 'x' } }), '/s').configs[0].agent, 'codex');
	failure(withConfig({ agent: 'gemini' }), 'spec.configs[0].agent');
	failure(withConfig({ agent: 'codex', permissionMode: 'auto' }), 'spec.configs[0].permissionMode');
	failure(withConfig({ agent: 'codex', skills: ['./s'] }), 'spec.configs[0].skills');
	failure(withConfig({ agent: 'codex', sandbox: false }), 'spec.configs[0].sandbox');
	failure(withConfig({ agent: 'opencode', model: 'go/flash' }), 'spec.configs[0].sandbox');
	failure(withConfig({ agent: 'opencode', sandbox: false }), 'spec.configs[0].model');
	assert.equal(validateSpec(withConfig({ agent: 'opencode', model: 'go/flash', sandbox: false }), '/s').configs[0].sandbox, false);
	// A container replaces the sandbox: false acknowledgement.
	assert.equal(validateSpec(withConfig({ agent: 'opencode', model: 'go/flash', container: true }), '/s').configs[0].container, true);
});

test('price: codex only, rates of zero or more, cacheRead a multiple from 0 to 1', () => {
	const withConfig = (config: Record<string, unknown>) => ({ ...base(), configs: [{ name: 'a', ...config }] });
	assert.deepEqual(validateSpec(withConfig({ agent: 'codex', price: { input: 1.25, output: 10, cacheRead: 0.1 } }), '/s').configs[0].price, { input: 1.25, output: 10, cacheRead: 0.1 });
	failure(withConfig({ price: { input: 1, output: 2 } }), 'spec.configs[0].price');
	failure(withConfig({ agent: 'codex', price: { input: -1, output: 2 } }), 'spec.configs[0].price.input');
	failure(withConfig({ agent: 'codex', price: { input: 1, output: 2, cacheRead: 2 } }), 'spec.configs[0].price.cacheRead');
});

test('container: codex and opencode only, containerEnv names only with a container', () => {
	const withConfig = (config: Record<string, unknown>) => ({ ...base(), configs: [{ name: 'a', ...config }] });
	assert.deepEqual(validateSpec(withConfig({ agent: 'codex', container: true, containerEnv: ['OPENAI_API_KEY'] }), '/s').configs[0].containerEnv, ['OPENAI_API_KEY']);
	failure(withConfig({ container: true }), 'spec.configs[0].container');
	failure(withConfig({ agent: 'codex', containerEnv: ['X'] }), 'spec.configs[0].containerEnv');
	failure(withConfig({ agent: 'codex', container: true, containerEnv: ['A=b'] }), 'spec.configs[0].containerEnv');
	failure(withConfig({ agent: 'codex', container: 'yes' }), 'spec.configs[0].container');
	assert.deepEqual(validateSpec(withConfig({ agent: 'codex', container: true, containerAllow: ['registry.npmjs.org', '*.github.com'] }), '/s').configs[0].containerAllow, ['registry.npmjs.org', '*.github.com']);
	failure(withConfig({ agent: 'codex', containerAllow: ['registry.npmjs.org'] }), 'spec.configs[0].containerAllow');
	for (const host of ['1.1.1.1:443', 'localhost', '*', 'https://github.com']) failure(withConfig({ agent: 'codex', container: true, containerAllow: [host] }), 'spec.configs[0].containerAllow');
});

test('task.setup: a command with a default timeout of 600 s', () => {
	const spec = validateSpec({ ...base(), task: { ...base().task, setup: { command: 'pnpm install --frozen-lockfile' } } }, '/s');
	assert.deepEqual(spec.task.setup, { command: 'pnpm install --frozen-lockfile', timeoutSec: 600 });
	failure({ ...base(), task: { ...base().task, setup: { command: '' } } }, 'spec.task.setup.command');
	failure({ ...base(), task: { ...base().task, setup: { command: 'x', other: 1 } } }, 'spec.task.setup.other');
});

test('effort is checked against the levels of the agent, and opencode names its variant in the model', () => {
	const withConfig = (config: Record<string, unknown>) => ({ ...base(), configs: [{ name: 'a', ...config }] });
	assert.equal(validateSpec(withConfig({ effort: 'max' }), '/s').configs[0].effort, 'max');
	assert.equal(validateSpec(withConfig({ agent: 'codex', effort: 'xhigh' }), '/s').configs[0].effort, 'xhigh');
	failure(withConfig({ effort: 'huge' }), 'configs[0].effort');
	failure(withConfig({ agent: 'codex', effort: 'max' }), 'configs[0].effort');
	failure(withConfig({ agent: 'opencode', sandbox: false, effort: 'high' }), 'provider/model#variant');
});

test('userClaudeMd takes a text or a file, and only Claude Code reads it', () => {
	const withConfig = (config: Record<string, unknown>) => ({ ...base(), configs: [{ name: 'a', ...config }] });
	assert.deepEqual(validateSpec(withConfig({ userClaudeMd: { file: 'mine.md' } }), '/specs/demo').configs[0].userClaudeMd, { file: '/specs/demo/mine.md' });
	failure(withConfig({ userClaudeMd: { text: 'a', file: 'b' } }), 'configs[0].userClaudeMd');
	failure(withConfig({ agent: 'codex', userClaudeMd: { text: 'a' } }), 'configs[0].userClaudeMd');
});

test('remove takes relative paths inside the clone, for any agent', () => {
	const withConfig = (config: Record<string, unknown>) => ({ ...base(), configs: [{ name: 'a', ...config }] });
	assert.deepEqual(validateSpec(withConfig({ agent: 'codex', remove: ['AGENTS.md', '.claude'] }), '/specs/demo').configs[0].remove, ['AGENTS.md', '.claude']);
	for (const path of ['/etc', '../up', 'a/../b', '.git/config', 'a//b', '.']) failure(withConfig({ remove: [path] }), 'configs[0].remove');
});

test('files maps relative paths inside the clone to a text or a file, for any agent', () => {
	const withConfig = (config: Record<string, unknown>) => ({ ...base(), configs: [{ name: 'a', ...config }] });
	assert.deepEqual(validateSpec(withConfig({ agent: 'codex', files: { 'AGENTS.md': { file: 'lite.md' }, 'apps/bff/AGENTS.md': { text: 'x' } } }), '/specs/demo').configs[0].files, {
		'AGENTS.md': { file: '/specs/demo/lite.md' },
		'apps/bff/AGENTS.md': { text: 'x' }
	});
	failure(withConfig({ files: { 'AGENTS.md': { text: 'a', file: 'b' } } }), 'configs[0].files.AGENTS.md');
	failure(withConfig({ files: ['AGENTS.md'] }), 'configs[0].files');
	for (const path of ['/etc/x', '../up', 'a/../b', '.git/config', 'a//b', '.']) failure(withConfig({ files: { [path]: { text: 'x' } } }), 'configs[0].files');
});

test('edits takes each kind with its own fields, for any agent', () => {
	const withEdits = (edits: unknown, extra: Record<string, unknown> = {}) => ({ ...base(), configs: [{ name: 'a', ...extra, edits }] });
	const edits = [
		{ file: 'AGENTS.md', replace: '^Frequent commands: (.*)$', with: 'Run: $1', flags: 'm', count: 1 },
		{ file: 'AGENTS.md', replace: 'x', with: '' },
		{ file: 'AGENTS.md', moveSection: 'Code Review Rules', after: '/^## Cross/', pointer: 'See below.' },
		{ file: 'AGENTS.md', moveSection: 'Mission', before: 'Scope' },
		{ file: 'apps/bff/AGENTS.md', removeSection: '### Creating GitLab merge requests' },
		{ file: 'AGENTS.md', append: '\nLast.\n' },
		{ file: 'NEW.md', prepend: 'First.\n', create: true }
	];
	assert.deepEqual(validateSpec(withEdits(edits, { agent: 'codex' }), '/specs/demo').configs[0].edits, edits);
	assert.equal(validateSpec(base(), '/specs/demo').configs[0].edits, undefined);
});

test('edits refuses an unknown field, a path outside the clone, a bad regex, and a move with both after and before', () => {
	const withEdits = (...edits: unknown[]) => ({ ...base(), configs: [{ name: 'a', edits }] });
	const rejects = (raw: unknown, message: RegExp) =>
		assert.throws(
			() => validateSpec(raw, '/specs/demo'),
			(error: unknown) => error instanceof SpecError && message.test(error.message)
		);
	rejects({ ...base(), configs: [{ name: 'a', edits: [] }] }, /^spec\.configs\[0\]\.edits: required non-empty array$/);
	rejects(withEdits({ file: 'AGENTS.md' }), /^spec\.configs\[0\]\.edits\[0\]: set exactly one of replace, moveSection, removeSection, append, prepend$/);
	rejects(withEdits({ file: 'AGENTS.md', append: 'x', prepend: 'y' }), /edits\[0\]: set exactly one of/);
	rejects(withEdits({ file: 'AGENTS.md', append: 'x', pointer: 'p' }), /^spec\.configs\[0\]\.edits\[0\]\.pointer: unknown field$/);
	rejects(withEdits({ file: 'AGENTS.md', replace: 'x', with: 'y', create: true }), /edits\[0\]\.create: unknown field/);
	rejects(withEdits({ file: 'AGENTS.md', replace: 'x' }), /edits\[0\]\.with: required string/);
	rejects(withEdits({ file: 'AGENTS.md', replace: '(', with: '' }), /edits\[0\]\.replace: \( is not a valid regular expression/);
	rejects(withEdits({ file: 'AGENTS.md', replace: 'x', with: '', flags: 'g' }), /edits\[0\]\.flags: a combination of m, s and i/);
	rejects(withEdits({ file: 'AGENTS.md', replace: 'x', with: '', flags: 'mm' }), /edits\[0\]\.flags: a combination of m, s and i/);
	rejects(withEdits({ file: 'AGENTS.md', replace: 'x', with: '', count: 0 }), /edits\[0\]\.count: required integer/);
	rejects(withEdits({ file: 'AGENTS.md', moveSection: 'A', after: 'B', before: 'C' }), /^spec\.configs\[0\]\.edits\[0\]: set exactly one of after and before$/);
	rejects(withEdits({ file: 'AGENTS.md', moveSection: 'A' }), /edits\[0\]: set exactly one of after and before/);
	rejects(withEdits({ file: 'AGENTS.md', removeSection: '/(/' }), /edits\[0\]\.removeSection: \/\(\/ is not a valid regular expression/);
	rejects(withEdits({ file: 'AGENTS.md', append: 'x', create: 'yes' }), /edits\[0\]\.create: required boolean/);
	rejects(withEdits('AGENTS.md'), /edits\[0\]: required object/);
	for (const path of ['/etc/x', '../up', 'a/../b', '.git/config', 'a//b', '.']) rejects(withEdits({ file: path, append: 'x' }), /edits\[0\]\.file: .* must be a relative path inside the clone, outside \.git/);
});

test('an edit of a file that claudeMd, userClaudeMd or a skill writes after the edits is refused', () => {
	const config = (extra: Record<string, unknown>) => ({ ...base(), configs: [{ name: 'a', ...extra }] });
	failure(config({ claudeMd: { text: 'x' }, edits: [{ file: 'CLAUDE.md', append: 'y' }] }), 'configs[0].edits[0].file');
	failure(config({ agent: 'codex', claudeMd: { text: 'x' }, edits: [{ file: 'AGENTS.md', append: 'y' }] }), 'configs[0].edits[0].file');
	failure(config({ userClaudeMd: { text: 'x' }, edits: [{ file: 'CLAUDE.local.md', append: 'y' }] }), 'configs[0].edits[0].file');
	failure(config({ skills: ['skills/tidy'], edits: [{ file: '.claude/skills/tidy/SKILL.md', append: 'y' }] }), 'configs[0].edits[0].file');
	assert.equal(validateSpec(config({ claudeMd: { text: 'x' }, edits: [{ file: 'AGENTS.md', append: 'y' }] }), '/s').configs[0].edits?.length, 1);
});

test('graders: a command grader gets its defaults, a pattern grader keeps its rules, and budget.gradersUsd is optional', () => {
	const raw = {
		...base(),
		budget: { perRunUsd: 1, perEvalUsd: 6, gradersUsd: 3 },
		graders: [
			{ name: 'review', kind: 'command', command: 'node "$EVAL_SPEC_DIR/review.mjs"' },
			{ name: 'rules', kind: 'pattern', rules: [{ name: 'no-as-cast', pattern: '\\bas [A-Z]\\w+', paths: '\\.ts$', severity: 'minor' }], require: [{ name: 'changeset', paths: '^\\.changeset/.+\\.md$', severity: 'important' }] }
		]
	};
	const spec = validateSpec(raw, '/specs/demo');
	assert.equal(spec.budget.gradersUsd, 3);
	assert.deepEqual(spec.graders, [
		{ name: 'review', kind: 'command', command: 'node "$EVAL_SPEC_DIR/review.mjs"', timeoutSec: 1800, blind: true },
		{ name: 'rules', kind: 'pattern', rules: [{ name: 'no-as-cast', pattern: '\\bas [A-Z]\\w+', paths: '\\.ts$', severity: 'minor' }], require: [{ name: 'changeset', paths: '^\\.changeset/.+\\.md$', severity: 'important' }] }
	]);
	const open = validateSpec({ ...base(), graders: [{ name: 'r', kind: 'command', command: 'true', timeoutSec: 60, blind: false }] }, '/s').graders![0];
	assert.deepEqual(open, { name: 'r', kind: 'command', command: 'true', timeoutSec: 60, blind: false });
	// A rule without paths reads every file. A pattern grader can have only rules, or only require.
	assert.deepEqual(validateSpec({ ...base(), graders: [{ name: 'r', kind: 'pattern', rules: [{ name: 'x', pattern: 'a', severity: 'minor' }] }] }, '/s').graders![0], { name: 'r', kind: 'pattern', rules: [{ name: 'x', pattern: 'a', severity: 'minor' }], require: [] });
	// A spec without graders keeps the shape it had before the field existed.
	const plain = validateSpec(base(), '/s');
	assert.equal('graders' in plain, false);
	assert.equal('gradersUsd' in plain.budget, false);
});

test('graders: unknown field, duplicate or bad name, bad kind, bad regex and an empty pattern grader are refused', () => {
	const withGraders = (graders: unknown) => ({ ...base(), graders });
	failure(withGraders([{ name: 'r', kind: 'command', command: 'true', extra: 1 }]), 'spec.graders[0].extra');
	failure(withGraders([{ name: 'r', kind: 'pattern', rules: [{ name: 'x', pattern: 'a', severity: 'minor', paths: 'b', other: 1 }] }]), 'spec.graders[0].rules[0].other');
	failure(withGraders([{ name: 'r', kind: 'command', command: 'true' }, { name: 'r', kind: 'pattern', rules: [{ name: 'x', pattern: 'a', severity: 'minor' }] }]), 'spec.graders[1].name');
	failure(withGraders([{ name: 'Review', kind: 'command', command: 'true' }]), 'spec.graders[0].name');
	failure(withGraders([{ name: 'r', kind: 'llm', command: 'true' }]), 'spec.graders[0].kind');
	failure(withGraders([{ name: 'r', kind: 'command' }]), 'spec.graders[0].command');
	failure(withGraders([{ name: 'r', kind: 'command', command: 'true', blind: 'yes' }]), 'spec.graders[0].blind');
	failure(withGraders([{ name: 'r', kind: 'command', command: 'true', timeoutSec: 0 }]), 'spec.graders[0].timeoutSec');
	failure(withGraders([{ name: 'r', kind: 'pattern', rules: [{ name: 'x', pattern: '(', severity: 'minor' }] }]), 'spec.graders[0].rules[0].pattern');
	failure(withGraders([{ name: 'r', kind: 'pattern', rules: [{ name: 'x', pattern: 'a', paths: '[', severity: 'minor' }] }]), 'spec.graders[0].rules[0].paths');
	failure(withGraders([{ name: 'r', kind: 'pattern', require: [{ name: 'x', paths: '*', severity: 'minor' }] }]), 'spec.graders[0].require[0].paths');
	failure(withGraders([{ name: 'r', kind: 'pattern', rules: [{ name: 'x', pattern: 'a' }] }]), 'spec.graders[0].rules[0].severity');
	failure(withGraders([{ name: 'r', kind: 'pattern', rules: [{ name: 'x', pattern: 'a', severity: 'minor' }, { name: 'x', pattern: 'b', severity: 'minor' }] }]), 'spec.graders[0].rules[1].name');
	failure(withGraders([{ name: 'r', kind: 'pattern' }]), 'spec.graders[0]');
	failure(withGraders([{ name: 'r', kind: 'pattern', command: 'true', rules: [{ name: 'x', pattern: 'a', severity: 'minor' }] }]), 'spec.graders[0].command');
	failure(withGraders([]), 'spec.graders');
	failure(withGraders({}), 'spec.graders');
	failure({ ...base(), budget: { perRunUsd: 1, perEvalUsd: 6, gradersUsd: 0 } }, 'spec.budget.gradersUsd');
});

test('graders: a command grader takes samples from 1 to 5 and merge majority or union; a pattern grader takes neither', () => {
	const command = (extra: Record<string, unknown>) => ({ ...base(), graders: [{ name: 'r', kind: 'command', command: 'true', ...extra }] });
	assert.deepEqual(validateSpec(command({ samples: 3, merge: 'union' }), '/s').graders![0], { name: 'r', kind: 'command', command: 'true', timeoutSec: 1800, blind: true, samples: 3, merge: 'union' });
	assert.deepEqual(validateSpec(command({ samples: 5 }), '/s').graders![0], { name: 'r', kind: 'command', command: 'true', timeoutSec: 1800, blind: true, samples: 5 });
	assert.deepEqual(validateSpec(command({ samples: 1, merge: 'majority' }), '/s').graders![0], { name: 'r', kind: 'command', command: 'true', timeoutSec: 1800, blind: true, samples: 1, merge: 'majority' });
	for (const samples of [0, 6, 2.5, '3']) failure(command({ samples }), 'spec.graders[0].samples');
	failure(command({ samples: 3, merge: 'all' }), 'spec.graders[0].merge');
	const pattern = (extra: Record<string, unknown>) => ({ ...base(), graders: [{ name: 'r', kind: 'pattern', rules: [{ name: 'x', pattern: 'a', severity: 'minor' }], ...extra }] });
	failure(pattern({ samples: 2 }), 'spec.graders[0].samples');
	failure(pattern({ merge: 'union' }), 'spec.graders[0].merge');
});

test('commands: regexes per class that add to the default command classes', () => {
	const spec = validateSpec({ ...base(), commands: { test: ['^make check\\b'], lint: ['stylelint'] } }, '/s');
	assert.deepEqual(spec.commands, { test: ['^make check\\b'], lint: ['stylelint'] });
	assert.equal('commands' in validateSpec(base(), '/s'), false);
	failure({ ...base(), commands: { tests: ['x'] } }, 'spec.commands.tests');
	failure({ ...base(), commands: { test: 'x' } }, 'spec.commands.test');
	failure({ ...base(), commands: { types: ['('] } }, 'spec.commands.types[0]');
	failure({ ...base(), commands: [] }, 'spec.commands');
});
