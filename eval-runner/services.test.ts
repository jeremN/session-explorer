import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Exec } from './exec.ts';
import { agentEnvOf, hostPort, startServices, stopServices } from './services.ts';
import type { Services } from './services.ts';

const db = { name: 'db', image: 'postgres:17', port: 5432, env: { POSTGRES_PASSWORD: 'test' }, tmpfs: ['/data'], capAdd: ['CHOWN'], ready: ['pg_isready', '-h', '127.0.0.1'], agentEnv: { TEST_DATABASE_URL: 'postgres://u:p@${host}:${port}/t' } };
const NOW = { tries: 3, ms: 0 };

// A fake docker: `port` prints a published address, `exec` (the ready command) fails `notReady` times first.
function fakeDocker({ notReady = 0, runFails = false } = {}) {
	const calls: string[][] = [];
	let misses = notReady;
	const exec: Exec = async (_command, args) => {
		calls.push(args);
		const ok = { code: 0, stdout: '', stderr: '', timedOut: false };
		if (args[0] === 'run') return runFails ? { ...ok, code: 125, stderr: 'pull access denied' } : ok;
		if (args[0] === 'port') return { ...ok, stdout: '127.0.0.1:55012\n' };
		if (args[0] === 'exec') return misses-- > 0 ? { ...ok, code: 2 } : ok;
		return ok;
	};
	return { exec, calls };
}

test('agentEnvOf and hostPort', () => {
	assert.deepEqual(agentEnvOf(db, 'db', 5432), { TEST_DATABASE_URL: 'postgres://u:p@db:5432/t' });
	assert.equal(hostPort('127.0.0.1:55012\n[::1]:55013\n'), 55012);
	assert.equal(hostPort(''), undefined);
});

test('a host run publishes the port on 127.0.0.1 only, and the agent gets the port that Docker picked', async () => {
	const { exec, calls } = fakeDocker({ notReady: 2 });
	const started: Services = { env: {}, containers: [] };
	await startServices(exec, [db], { name: 'run-1' }, started, NOW);
	assert.deepEqual(calls[0], ['run', '-d', '--name', 'run-1-svc-db', '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--security-opt', 'no-new-privileges', '--read-only', '--pids-limit', '512', '--memory', '1g', '--cpus', '2', '--tmpfs', '/data', '-e', 'POSTGRES_PASSWORD=test', '-p', '127.0.0.1::5432', 'postgres:17']);
	assert.deepEqual(calls[1], ['port', 'run-1-svc-db', '5432/tcp']);
	assert.equal(calls.filter((args) => args[0] === 'exec').length, 3);
	assert.deepEqual(started.env, { TEST_DATABASE_URL: 'postgres://u:p@127.0.0.1:55012/t' });
	await stopServices(exec, started);
	await stopServices(exec, started);
	assert.deepEqual(calls.filter((args) => args[0] === 'rm'), [['rm', '--force', 'run-1-svc-db']]);
});

test('a container run puts the service on the run network under its name, with nothing published', async () => {
	const { exec, calls } = fakeDocker();
	const started: Services = { env: {}, containers: [] };
	await startServices(exec, [db], { name: 'run-1', network: 'net-1' }, started, NOW);
	// No DNS: the Docker daemon would resolve a name on the host, a way out of the internal network.
	assert.deepEqual(calls[0].slice(-7), ['--network', 'net-1', '--network-alias', 'db', '--dns', '127.0.0.1', 'postgres:17']);
	assert.ok(!calls[0].includes('-p'));
	assert.ok(!calls.some((args) => args[0] === 'port'));
	assert.deepEqual(started.env, { TEST_DATABASE_URL: 'postgres://u:p@db:5432/t' });
});

test('a service that does not start, or never answers, is an error, and its container is still listed for removal', async () => {
	for (const fake of [fakeDocker({ runFails: true }), fakeDocker({ notReady: 10 })]) {
		const started: Services = { env: {}, containers: [] };
		await assert.rejects(startServices(fake.exec, [db], { name: 'run-1' }, started, NOW), /service db did not (start: pull access denied|answer its ready command)/);
		assert.deepEqual(started.containers, ['run-1-svc-db']);
		assert.deepEqual(started.env, {});
	}
});
