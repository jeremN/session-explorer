import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

// The parent starts a grandchild in its own session that holds the stdout and stderr pipes and ignores SIGTERM.
const HOLDER = `
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'inherit', 'inherit'], detached: true });
require('node:fs').writeFileSync(process.env.PID_FILE, String(child.pid));
setInterval(() => {}, 1000);
`;

test('G2: on timeout, realExec resolves even when a detached descendant keeps the pipes open', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'eval-exec-'));
	const pidFile = join(dir, 'pid');
	const timeoutMs = 500;
	const killGraceMs = 300;
	const bound = timeoutMs + killGraceMs + 5_000 + 1_000;
	const started = Date.now();
	let guard: NodeJS.Timeout | undefined;
	try {
		const result = await Promise.race([
			realExec(process.execPath, ['-e', HOLDER], { timeoutMs, killGraceMs, env: { PID_FILE: pidFile } }),
			new Promise<'hung'>((resolve) => (guard = setTimeout(() => resolve('hung'), bound + 2_000)))
		]);
		assert.notEqual(result, 'hung');
		assert.equal((result as { timedOut: boolean }).timedOut, true);
		assert.ok(Date.now() - started <= bound, `${Date.now() - started} ms`);
	} finally {
		clearTimeout(guard);
		try {
			process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
		} catch {
			// Already gone.
		}
		rmSync(dir, { recursive: true, force: true });
	}
});
