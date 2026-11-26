import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { killLiveGroups, realExec } from './exec.ts';

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

// The parent starts a grandchild in the same process group with no pipes, writes its pid, then exits 0.
const BACKGROUND = `
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
child.unref();
require('node:fs').writeFileSync(process.env.PID_FILE, String(child.pid));
`;

test('after a normal exit, a background descendant in the same group is dead when realExec resolves', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'eval-exec-'));
	const pidFile = join(dir, 'pid');
	let pid = 0;
	try {
		const result = await realExec(process.execPath, ['-e', BACKGROUND], { env: { PID_FILE: pidFile } });
		pid = Number(readFileSync(pidFile, 'utf8'));
		assert.ok(pid > 0);
		assert.deepEqual([result.code, result.timedOut], [0, false]);
		assert.equal(alive(pid), false);
	} finally {
		if (pid > 0 && alive(pid)) process.kill(pid, 'SIGKILL');
		rmSync(dir, { recursive: true, force: true });
	}
});

test('an abort signal kills the process group and sets aborted', async () => {
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 300);
	const started = Date.now();
	const result = await realExec('sh', ['-c', 'sleep 30 & echo $!; wait'], { signal: controller.signal, killGraceMs: 300 });
	const pid = Number(result.stdout.trim());
	try {
		assert.equal(result.aborted, true);
		assert.equal(result.timedOut, false);
		assert.ok(Date.now() - started < 10_000);
		assert.ok(pid > 0);
		assert.equal(alive(pid), false);
	} finally {
		if (alive(pid)) process.kill(pid, 'SIGKILL');
	}
});

test('a signal that is already aborted starts no process', async () => {
	const controller = new AbortController();
	controller.abort();
	const mark = join(tmpdir(), `exec-mark-${process.pid}`);
	const result = await realExec(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.env.MARK, "ran")'], { signal: controller.signal, env: { MARK: mark } });
	assert.equal(result.aborted, true);
	assert.equal(result.code, null);
	assert.throws(() => readFileSync(mark));
});

test('killLiveGroups kills the running process groups at once', async () => {
	const running = realExec('sleep', ['30']);
	await new Promise((wake) => setTimeout(wake, 100));
	const started = Date.now();
	killLiveGroups();
	const result = await running;
	assert.ok(Date.now() - started < 5000);
	assert.equal(result.code, null);
});
