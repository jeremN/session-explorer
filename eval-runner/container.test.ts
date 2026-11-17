import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { containerHome, containerName, containerize, imageTag } from './container.ts';

const root = mkdtempSync(join(tmpdir(), 'eval-container-'));
after(() => rmSync(root, { recursive: true, force: true }));

test('imageTag names the content of the Dockerfile', () => {
	assert.match(imageTag(), /^eval-runner-agents:[0-9a-f]{12}$/);
	assert.notEqual(imageTag(Buffer.from('FROM a')), imageTag(Buffer.from('FROM b')));
});

test('containerHome holds the login of the agent and nothing else, in a private folder', () => {
	const codex = join(root, 'codex');
	const opencode = join(root, 'opencode');
	mkdirSync(codex);
	mkdirSync(opencode);
	for (const dir of [codex, opencode]) {
		writeFileSync(join(dir, 'auth.json'), '{}');
		writeFileSync(join(dir, 'config.toml'), 'x');
	}
	const home = containerHome('codex', { codex, opencode });
	after(() => rmSync(home, { recursive: true, force: true }));
	assert.equal(statSync(home).mode & 0o777, 0o700);
	assert.deepEqual(readdirSync(home, { recursive: true }).sort(), ['.codex', join('.codex', 'auth.json')]);
	const other = containerHome('opencode', { codex, opencode });
	after(() => rmSync(other, { recursive: true, force: true }));
	assert.deepEqual(readdirSync(join(other, '.local', 'share', 'opencode')), ['auth.json']);
	assert.deepEqual(readdirSync(join(other, '.config', 'opencode')), []);
});

test('containerize passes each variable by name only, never PWD, and keeps the agent argv after the image', () => {
	process.env.EVAL_TEST_SECRET = 'value-that-must-not-show';
	try {
		const started = containerize({ args: ['run', '--', 'go'], files: [], env: { A: '1', PWD: '/x' }, input: '' }, 'opencode', { image: 'img:1', name: 'n', clone: '/c', home: '/h', user: '1:2', passEnv: ['EVAL_TEST_SECRET', 'EVAL_TEST_UNSET'] });
		assert.equal(started.command, 'docker');
		assert.deepEqual(started.args.slice(-5), ['img:1', 'opencode', 'run', '--', 'go']);
		assert.equal(started.args.join(' ').includes('value-that-must-not-show'), false);
		assert.equal(started.env.EVAL_TEST_SECRET, 'value-that-must-not-show');
		assert.equal(started.args.includes('EVAL_TEST_UNSET'), false);
		assert.equal(started.args.includes('PWD'), false);
		assert.ok(started.args.includes('/c:/work') && started.args.includes('/h:/home/agent'));
	} finally {
		delete process.env.EVAL_TEST_SECRET;
	}
});

test('containerName keeps the characters docker accepts', () => {
	assert.equal(containerName('20261117-095311-a b', 'codex-1'), 'eval-runner-20261117-095311-a-b-codex-1');
});
