import assert from 'node:assert/strict';
import { test } from 'node:test';

import { realExec } from './exec.ts';

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

// The parent starts a child that ignores SIGTERM and closes its streams, prints the child pid, then waits.
const PARENT = `
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
console.log(child.pid);
setInterval(() => {}, 1000);
`;

test('F3: on timeout, a descendant that ignores SIGTERM is dead when realExec resolves', async () => {
	const result = await realExec(process.execPath, ['-e', PARENT], { timeoutMs: 1000, killGraceMs: 300 });
	const pid = Number(result.stdout.trim());
	assert.ok(pid > 0, result.stdout + result.stderr);
	try {
		assert.equal(result.timedOut, true);
		assert.equal(alive(pid), false);
	} finally {
		if (alive(pid)) process.kill(pid, 'SIGKILL');
	}
});

test('a process that ends before its timeout resolves with its output', async () => {
	const result = await realExec(process.execPath, ['-e', 'console.log("hi")'], { timeoutMs: 5000 });
	assert.deepEqual([result.code, result.stdout, result.timedOut], [0, 'hi\n', false]);
});
