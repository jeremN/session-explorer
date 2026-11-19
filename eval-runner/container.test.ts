import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { allowedHosts, blockedTargets, containerHome, containerName, containerize, imageTag, networkOf, startNetwork, stopNetwork } from './container.ts';
import type { Exec } from './exec.ts';

const root = mkdtempSync(join(tmpdir(), 'eval-container-'));
after(() => rmSync(root, { recursive: true, force: true }));

test('imageTag names the content of the Dockerfile', () => {
	assert.match(imageTag(), /^eval-runner-agents:[0-9a-f]{12}$/);
	assert.notEqual(imageTag(Buffer.from('FROM a')), imageTag(Buffer.from('FROM b')));
	// The filter is part of the tag: the same Dockerfile with another allow list is another image.
	assert.notEqual(imageTag(Buffer.from('FROM a'), Buffer.from('{"codex":["a"]}')), imageTag(Buffer.from('FROM a'), Buffer.from('{"codex":["b"]}')));
});

test('allowedHosts: the defaults of the agent, then the hosts of the spec, once each', () => {
	assert.deepEqual(allowedHosts('codex'), ['chatgpt.com', 'api.openai.com', 'auth.openai.com']);
	assert.deepEqual(allowedHosts('opencode', ['Registry.npmjs.org', 'opencode.ai']), ['opencode.ai', 'models.opencode.ai', 'registry.npmjs.org']);
});

test('blockedTargets: the refused targets of the proxy log, once each, and no crash on a line that is not JSON', () => {
	const log = ['{"listening":3128}', '{"verdict":"deny","target":"github.com:443"}', 'TypeError: boom', '{"verdict":"allow","target":"chatgpt.com:443"}', '{"verdict":"deny","target":"github.com:443"}'].join('\n');
	assert.deepEqual(blockedTargets(log), ['github.com:443']);
});

// A fake exec that answers each docker call from a table, and records the calls.
function fakeExec(answer: (args: string[]) => { code?: number; stdout?: string; stderr?: string }) {
	const calls: string[][] = [];
	const exec = (async (_command: string, args: string[]) => {
		calls.push(args);
		return { code: 0, stdout: '', stderr: '', timedOut: false, ...answer(args) };
	}) as unknown as Exec;
	return { exec, calls };
}

test('startNetwork waits for the proxy, and fails when a step fails or the proxy never listens', async () => {
	const network = networkOf('eval-runner-x-codex-1', ['chatgpt.com']);
	let polls = 0;
	const ready = fakeExec((args) => (args[0] === 'logs' ? { stdout: ++polls < 3 ? '' : '{"listening":3128}' } : {}));
	await startNetwork(ready.exec, network, 'img:1', '1:2', 'docker', { tries: 5, ms: 1 });
	assert.equal(polls, 3);
	assert.ok(ready.calls[1].includes('EVAL_PROXY_ALLOW=chatgpt.com') && ready.calls[1].includes('--read-only'));
	const broken = fakeExec((args) => (args[1] === 'create' ? { code: 1, stderr: 'network exists' } : {}));
	await assert.rejects(startNetwork(broken.exec, network, 'img:1', '1:2', 'docker', { tries: 1, ms: 1 }), /docker network create failed: network exists/);
	const silent = fakeExec(() => ({}));
	await assert.rejects(startNetwork(silent.exec, network, 'img:1', '1:2', 'docker', { tries: 2, ms: 1 }), /did not start/);
});

test('stopNetwork returns the log, says when the proxy had stopped, and removes the proxy before the network', async () => {
	const network = networkOf('n', []);
	const stopped = fakeExec((args) => (args[0] === 'inspect' ? { stdout: 'false\n' } : args[0] === 'logs' ? { stdout: 'trace' } : {}));
	assert.deepEqual(await stopNetwork(stopped.exec, network), { log: 'trace', proxyStopped: true });
	assert.deepEqual(stopped.calls.slice(-2), [['rm', '--force', 'n-proxy'], ['network', 'rm', 'n-net']]);
	// A second call finds no proxy: no log, and no claim that it stopped.
	const gone = fakeExec((args) => (args[0] === 'inspect' ? { code: 1 } : {}));
	assert.deepEqual(await stopNetwork(gone.exec, network), { log: '', proxyStopped: false });
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
	// With the key variable set, opencode reads the key from it: the config names the variable, and no auth.json goes in.
	const keyed = containerHome('opencode', { codex, opencode }, { OPENCODE_GO_API_KEY: 'value-that-must-not-show' });
	after(() => rmSync(keyed, { recursive: true, force: true }));
	assert.deepEqual(readdirSync(join(keyed, '.local', 'share', 'opencode')), []);
	const config = readFileSync(join(keyed, '.config', 'opencode', 'opencode.json'), 'utf8');
	assert.deepEqual(JSON.parse(config), { provider: { 'opencode-go': { options: { apiKey: '{env:OPENCODE_GO_API_KEY}' } } } });
	assert.equal(config.includes('value-that-must-not-show'), false);
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
		assert.equal(started.args.includes('--network'), false);
		const filtered = containerize({ args: [], files: [], env: {}, input: '' }, 'codex', { image: 'img:1', name: 'n', clone: '/c', home: '/h', user: '1:2', network: networkOf('n', ['chatgpt.com']) });
		assert.equal(filtered.args[filtered.args.indexOf('--network') + 1], 'n-net');
		assert.equal(filtered.args[filtered.args.indexOf('--dns') + 1], '127.0.0.1');
		assert.equal(filtered.env.HTTPS_PROXY, 'http://eval-proxy:3128');
		assert.equal(filtered.env.no_proxy, 'localhost,127.0.0.1');
	} finally {
		delete process.env.EVAL_TEST_SECRET;
	}
});

test('containerName keeps the characters docker accepts', () => {
	assert.equal(containerName('20261117-095311-a b', 'codex-1'), 'eval-runner-20261117-095311-a-b-codex-1');
});
