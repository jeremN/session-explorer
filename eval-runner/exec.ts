// One way to run a process. Modules take an `Exec`, so a test can check the argv without a process.
import { spawn } from 'node:child_process';

export type ExecOptions = { cwd?: string; input?: string; env?: Record<string, string | undefined>; timeoutMs?: number; killGraceMs?: number };
export type ExecResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };
export type Exec = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

const KILL_GRACE_MS = 10_000;

// No shell: the command and its arguments stay separate. The child leads its own process group,
// so a timeout reaches the processes that it started too.
export const realExec: Exec = (command, args, { cwd, input, env, timeoutMs, killGraceMs = KILL_GRACE_MS } = {}) =>
	new Promise((resolve) => {
		const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
		let stdout = '';
		let stderr = '';
		let timedOut = false;
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
						killTimer = setTimeout(() => signal('SIGKILL'), killGraceMs);
					}, timeoutMs);
		child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
		child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
		child.stdin.on('error', () => {});
		child.stdin.end(input ?? '');
		const finish = (code: number | null, extra = '') => {
			clearTimeout(timer);
			clearTimeout(killTimer);
			resolve({ code, stdout, stderr: stderr + extra, timedOut });
		};
		child.on('error', (error) => finish(null, error.message));
		child.on('close', (code) => finish(code));
	});
