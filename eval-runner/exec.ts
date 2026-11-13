// One way to run a process. Modules take an `Exec`, so a test can check the argv without a process.
import { spawn } from 'node:child_process';

export type ExecOptions = { cwd?: string; input?: string; env?: Record<string, string | undefined>; timeoutMs?: number; killGraceMs?: number };
export type ExecResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };
export type Exec = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

const KILL_GRACE_MS = 10_000;
// After the SIGKILL, the wait for the process group and for the pipes stops at this limit.
const GROUP_WAIT_MS = 5_000;
const POLL_MS = 50;
// After a normal exit, the SIGTERM to the rest of the group gets this grace before the SIGKILL.
const EXIT_GRACE_MS = 1_000;

const sleep = (ms: number) => new Promise((wake) => setTimeout(wake, ms));

// True while a process of the group exists, a zombie included.
function groupAlive(pid: number) {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

// No shell: the command and its arguments stay separate. The child leads its own process group,
// so a timeout reaches the processes that it started too.
export const realExec: Exec = (command, args, { cwd, input, env, timeoutMs, killGraceMs = KILL_GRACE_MS } = {}) =>
	new Promise((resolve) => {
		const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
		let stdout = '';
		let stderr = '';
		let timedOut = false;
		let killedAt: number | undefined;
		let killTimer: NodeJS.Timeout | undefined;
		let forceTimer: NodeJS.Timeout | undefined;
		const signal = (name: NodeJS.Signals) => {
			try {
				process.kill(-child.pid!, name);
			} catch {
				child.kill(name);
			}
		};
		const timer =
			timeoutMs === undefined
				? undefined
				: setTimeout(() => {
						timedOut = true;
						signal('SIGTERM');
						// This SIGKILL stays scheduled after the parent closes: a descendant can ignore SIGTERM and outlive it.
						killTimer = setTimeout(() => {
							killedAt = Date.now();
							signal('SIGKILL');
							// A descendant in another session can keep the pipes open, so close never comes. The result stops waiting.
							forceTimer = setTimeout(() => {
								child.stdout.destroy();
								child.stderr.destroy();
								finish(child.exitCode, '\neval-runner: a descendant kept the output open after the kill');
							}, GROUP_WAIT_MS);
						}, killGraceMs);
					}, timeoutMs);
		child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
		child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
		child.stdin.on('error', () => {});
		child.stdin.end(input ?? '');
		let done = false;
		const finish = async (code: number | null, extra = '') => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			// On a timeout, the result waits until the whole group is gone: the SIGKILL comes after the grace period at most.
			if (timedOut && child.pid !== undefined) {
				const pid = child.pid;
				while (groupAlive(pid) && (killedAt === undefined || Date.now() < killedAt + GROUP_WAIT_MS)) await sleep(POLL_MS);
			}
			// After a normal exit, a descendant of the group must not change the clone after the diff.
			// A descendant in another session (setsid) stays out of reach.
			if (!timedOut && child.pid !== undefined && groupAlive(child.pid)) {
				const pid = child.pid;
				signal('SIGTERM');
				const termAt = Date.now();
				while (groupAlive(pid) && Date.now() < termAt + EXIT_GRACE_MS) await sleep(POLL_MS);
				if (groupAlive(pid)) {
					signal('SIGKILL');
					const killAt = Date.now();
					while (groupAlive(pid) && Date.now() < killAt + GROUP_WAIT_MS) await sleep(POLL_MS);
				}
			}
			clearTimeout(killTimer);
			clearTimeout(forceTimer);
			resolve({ code, stdout, stderr: stderr + extra, timedOut });
		};
		child.on('error', (error) => finish(null, error.message));
		child.on('close', (code) => finish(code));
	});
