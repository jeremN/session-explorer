// One way to run a process. Modules take an `Exec`, so a test can check the argv without a process.
import { spawn } from 'node:child_process';

export type ExecOptions = { cwd?: string; input?: string; env?: Record<string, string | undefined>; timeoutMs?: number; killGraceMs?: number };
export type ExecResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };
export type Exec = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

const KILL_GRACE_MS = 10_000;
// After the SIGKILL, the wait for the process group to go away stops at this limit.
const GROUP_WAIT_MS = 5_000;
const POLL_MS = 50;

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
		let killed = false;
		let killTimer: NodeJS.Timeout | undefined;
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
							killed = true;
							signal('SIGKILL');
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
				let deadline = Infinity;
				while (groupAlive(pid)) {
					if (killed && deadline === Infinity) deadline = Date.now() + GROUP_WAIT_MS;
					if (Date.now() > deadline) break;
					await new Promise((wake) => setTimeout(wake, POLL_MS));
				}
			}
			clearTimeout(killTimer);
			resolve({ code, stdout, stderr: stderr + extra, timedOut });
		};
		child.on('error', (error) => finish(null, error.message));
		child.on('close', (code) => finish(code));
	});
