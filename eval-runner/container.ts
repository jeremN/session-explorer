// Runs an agent CLI in a Docker container. The container sees the clone at /work and a private home at /home/agent,
// and nothing else from the host. The container is the boundary, so Codex runs without its own sandbox there: bwrap
// cannot create a namespace in an unprivileged container, and every command of the agent failed with it.
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Invocation } from './agents.ts';
import type { Exec } from './exec.ts';
import type { AgentName } from './spec.ts';

export const DOCKERFILE_DIR = join(import.meta.dirname, 'container');
export const WORK = '/work';
export const HOME = '/home/agent';

// The tag names the content of the Dockerfile, so a new CLI version gives a new tag and a new cache key.
export function imageTag(dockerfile = readFileSync(join(DOCKERFILE_DIR, 'Dockerfile'))) {
	return `eval-runner-agents:${createHash('sha256').update(dockerfile).digest('hex').slice(0, 12)}`;
}

export async function imageExists(exec: Exec, tag: string, docker = 'docker') {
	return (await exec(docker, ['image', 'inspect', '--format', '{{.Id}}', tag])).code === 0;
}

// The private home of one run: the login of the agent and nothing else. It is mounted at /home/agent.
export function containerHome(agent: Exclude<AgentName, 'claude'>, source = { codex: process.env.CODEX_HOME ?? join(homedir(), '.codex'), opencode: join(homedir(), '.local', 'share', 'opencode') }) {
	const home = mkdtempSync(join(tmpdir(), 'eval-runner-home-'));
	chmodSync(home, 0o700);
	const login = agent === 'codex' ? { from: join(source.codex, 'auth.json'), to: join(home, '.codex') } : { from: join(source.opencode, 'auth.json'), to: join(home, '.local', 'share', 'opencode') };
	mkdirSync(login.to, { recursive: true });
	if (agent === 'opencode') mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
	if (existsSync(login.from)) copyFileSync(login.from, join(login.to, 'auth.json'));
	return home;
}

export type ContainerRun = { image: string; name: string; clone: string; home: string; user: string; passEnv?: string[] };

// The `docker run` argv around the invocation of the agent. Every variable goes as `-e NAME`: docker reads the value
// from its own environment, so no value shows in the argv or the process list.
export function containerize(invocation: Invocation, command: string, run: ContainerRun, docker = 'docker'): Invocation & { command: string } {
	const env = { ...invocation.env, ...Object.fromEntries((run.passEnv ?? []).filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]!])) };
	delete env.PWD;
	const args = ['run', '--rm', '--init', '-i', '--name', run.name, '--user', run.user, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '512', '--memory', '4g', '--cpus', '2'];
	args.push('-v', `${run.clone}:${WORK}`, '-v', `${run.home}:${HOME}`, '-w', WORK);
	for (const name of Object.keys(env).sort()) args.push('-e', name);
	args.push(run.image, command, ...invocation.args);
	return { command: docker, args, env, input: invocation.input, files: invocation.files };
}

// A killed `docker run` client leaves its container running. The runner removes it by name after every run.
export async function removeContainer(exec: Exec, name: string, docker = 'docker') {
	await exec(docker, ['rm', '--force', name]);
}

// Docker names allow [a-zA-Z0-9_.-].
export const containerName = (evalId: string, runId: string) => `eval-runner-${evalId}-${runId}`.replace(/[^a-zA-Z0-9_.-]/g, '-');

// npm run eval:image: builds the image under the tag the runner expects.
if (import.meta.main) {
	const { spawnSync } = await import('node:child_process');
	const tag = imageTag();
	console.log(`docker build -t ${tag} ${DOCKERFILE_DIR}`);
	process.exitCode = spawnSync('docker', ['build', '-t', tag, DOCKERFILE_DIR], { stdio: 'inherit' }).status ?? 1;
}
