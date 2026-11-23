// Runs an agent CLI in a Docker container. The container sees the clone at /work and a private home at /home/agent,
// and nothing else from the host. The container is the boundary, so Codex runs without its own sandbox there: bwrap
// cannot create a namespace in an unprivileged container, and every command of the agent failed with it.
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Invocation } from './agents.ts';
import type { Exec } from './exec.ts';
import type { AgentName } from './spec.ts';

export const DOCKERFILE_DIR = join(import.meta.dirname, 'container');
export const WORK = '/work';
export const HOME = '/home/agent';

// The tag names the content of the Dockerfile, the network filter and its default hosts. A new CLI version or a new
// filter gives a new tag, so a new cache key: no cached run from another filter is reused.
export function imageTag(...parts: Buffer[]) {
	const content = parts.length ? parts : ['Dockerfile', 'proxy.ts', 'allow.json'].map((file) => readFileSync(join(DOCKERFILE_DIR, file)));
	const hash = createHash('sha256');
	for (const part of content) hash.update(part).update('\0');
	return `eval-runner-agents:${hash.digest('hex').slice(0, 12)}`;
}

// The hosts that the agent container may reach: the defaults of the agent (container/allow.json), and `extra` from
// the spec.
export function allowedHosts(agent: Exclude<AgentName, 'claude'>, extra: readonly string[] = []): string[] {
	const defaults = JSON.parse(readFileSync(join(DOCKERFILE_DIR, 'allow.json'), 'utf8')) as Record<string, string[]>;
	return [...new Set([...(defaults[agent] ?? []), ...extra.map((host) => host.toLowerCase())])];
}

export const PROXY_PORT = 3128;
// The name of the proxy on the network of the run. Each run has its own network, so the alias is unique there. The
// container name is too long for a DNS label (63 characters at most), so the agent could not resolve it.
export const PROXY_ALIAS = 'eval-proxy';
export type Network = { network: string; proxy: string; allow: string[] };
export const networkOf = (name: string, allow: string[]): Network => ({ network: `${name}-net`, proxy: `${name}-proxy`, allow });

// The network of one run. The agent container joins an internal network, with no route out. The proxy joins that
// network and the default one, so it is the only way out, and it lets only the allowed hosts through.
export async function startNetwork(exec: Exec, network: Network, image: string, user: string, docker = 'docker', wait = { tries: 50, ms: 200 }) {
	const step = async (args: string[]) => {
		const result = await exec(docker, args);
		if (result.code !== 0) throw new Error(`docker ${args[0]} ${args[1]} failed: ${(result.stderr || result.stdout).trim().slice(0, 200)}`);
		return result.stdout;
	};
	await step(['network', 'create', '--internal', network.network]);
	await step(['run', '-d', '--name', network.proxy, '--user', user, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--pids-limit', '64', '--memory', '128m', '-e', `EVAL_PROXY_ALLOW=${network.allow.join(',')}`, image, 'node', '/opt/eval-runner/proxy.ts', String(PROXY_PORT)]);
	await step(['network', 'connect', '--alias', PROXY_ALIAS, network.network, network.proxy]);
	for (let index = 0; index < wait.tries; index++) {
		if ((await exec(docker, ['logs', network.proxy])).stdout.includes('"listening"')) return;
		await new Promise((resolve) => setTimeout(resolve, wait.ms));
	}
	throw new Error(`the network proxy ${network.proxy} did not start`);
}

// Removes the proxy and the network, and returns what the proxy logged and whether it still ran. Safe to call twice:
// a second call finds nothing and returns an empty log.
export async function stopNetwork(exec: Exec, network: Network, docker = 'docker') {
	const running = (await exec(docker, ['inspect', '--format', '{{.State.Running}}', network.proxy])).stdout.trim();
	const log = running ? (await exec(docker, ['logs', network.proxy])).stdout : '';
	await exec(docker, ['rm', '--force', network.proxy]);
	await exec(docker, ['network', 'rm', network.network]);
	return { log, proxyStopped: running === 'false' };
}

// The targets that the proxy refused, from its log, in the order of the first refusal.
export function blockedTargets(log: string): string[] {
	const targets = new Set<string>();
	for (const line of log.split('\n')) {
		try {
			const entry = JSON.parse(line) as { verdict?: string; target?: string };
			if (entry.verdict === 'deny' && entry.target) targets.add(entry.target);
		} catch {
			// A line that is not JSON (a crash trace) is no decision.
		}
	}
	return [...targets];
}

export async function imageExists(exec: Exec, tag: string, docker = 'docker') {
	return (await exec(docker, ['image', 'inspect', '--format', '{{.Id}}', tag])).code === 0;
}

// Why the image is not usable: the daemon does not answer (stopped, or another docker context), or the image is not
// built. Both made `docker image inspect` fail, and the runner said "missing" for the two.
export async function imageProblem(exec: Exec, tag: string, docker = 'docker'): Promise<string | undefined> {
	if (await imageExists(exec, tag, docker)) return undefined;
	const server = await exec(docker, ['version', '--format', '{{.Server.Version}}']);
	if (server.code !== 0 || !server.stdout.trim()) {
		const context = (await exec(docker, ['context', 'show'])).stdout.trim();
		const reason = (server.stderr.trim().split('\n').pop() ?? '').slice(0, 200);
		return `Docker does not answer${context ? ` (context ${context})` : ''}: ${reason || `exit code ${server.code}`}. Start it, or pick the context that holds the image: docker context use <name>, or DOCKER_CONTEXT=<name>.`;
	}
	return `The image ${tag} is missing. Build it with: pnpm eval:image`;
}

// opencode keeps its valid key in its background service, and its auth.json can still hold an expired key. When this
// host variable is set, opencode in the container reads its key from it, and the container gets no auth.json. Both
// names are accepted; the first that is set wins.
export const OPENCODE_KEY_ENVS = ['OPENCODE_GO_API_KEY', 'OPENCODE_API_KEY'];

// The private home of one run: the login of the agent and nothing else. It is mounted at /home/agent.
export function containerHome(agent: Exclude<AgentName, 'claude'>, source = { codex: process.env.CODEX_HOME ?? join(homedir(), '.codex'), opencode: join(homedir(), '.local', 'share', 'opencode') }, env: NodeJS.ProcessEnv = process.env) {
	const home = mkdtempSync(join(tmpdir(), 'eval-runner-home-'));
	chmodSync(home, 0o700);
	const login = agent === 'codex' ? { from: join(source.codex, 'auth.json'), to: join(home, '.codex') } : { from: join(source.opencode, 'auth.json'), to: join(home, '.local', 'share', 'opencode') };
	mkdirSync(login.to, { recursive: true });
	if (agent === 'opencode') {
		const config = join(home, '.config', 'opencode');
		mkdirSync(config, { recursive: true });
		const keyEnv = OPENCODE_KEY_ENVS.find((name) => env[name]);
		if (keyEnv) {
			// The file names the variable, never its value: docker passes the value with `-e NAME`.
			writeFileSync(join(config, 'opencode.json'), JSON.stringify({ provider: { 'opencode-go': { options: { apiKey: `{env:${keyEnv}}` } } } }));
			return home;
		}
	}
	if (existsSync(login.from)) copyFileSync(login.from, join(login.to, 'auth.json'));
	return home;
}

export type ContainerRun = { image: string; name: string; clone: string; home: string; user: string; passEnv?: string[]; network?: Network; noProxy?: string[] };

// The `docker run` argv around the invocation of the agent. Every variable goes as `-e NAME`: docker reads the value
// from its own environment, so no value shows in the argv or the process list.
export function containerize(invocation: Invocation, command: string, run: ContainerRun, docker = 'docker'): Invocation & { command: string } {
	const env = { ...invocation.env, ...Object.fromEntries((run.passEnv ?? []).filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]!])) };
	delete env.PWD;
	// The CLIs reach their API through the proxy. A CLI that ignores these variables gets no network at all.
	if (run.network) {
		const proxy = `http://${PROXY_ALIAS}:${PROXY_PORT}`;
		// The services of the run (task.services) are on the run network: the agent reaches them directly, not through the proxy.
		const noProxy = ['localhost', '127.0.0.1', ...(run.noProxy ?? [])].join(',');
		Object.assign(env, { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy, NO_PROXY: noProxy, no_proxy: noProxy });
	}
	const args = ['run', '--rm', '--init', '-i', '--name', run.name, '--user', run.user, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '512', '--memory', '4g', '--cpus', '2'];
	// The embedded DNS of Docker still resolves the proxy alias. --dns sets where it forwards the other names: to an
	// address with no server, so a DNS query cannot carry data out (older Docker versions forward from internal networks).
	if (run.network) args.push('--network', run.network.network, '--dns', '127.0.0.1');
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

// pnpm eval:image: builds the image under the tag the runner expects.
if (import.meta.main) {
	const { spawnSync } = await import('node:child_process');
	const tag = imageTag();
	console.log(`docker build -t ${tag} ${DOCKERFILE_DIR}`);
	process.exitCode = spawnSync('docker', ['build', '-t', tag, DOCKERFILE_DIR], { stdio: 'inherit' }).status ?? 1;
}
