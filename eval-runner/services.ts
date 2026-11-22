// The services of a run (task.services): containers that run while the agent works, for example the database of the
// tests. Each run gets its own, from a fresh start, and loses it before the diff and the acceptance check: the check
// keeps its own environment.
// A host agent reaches a service on 127.0.0.1, at a port that Docker picks. A container agent reaches it on the internal
// network of the run, by its name, at its own port: it never needs the proxy, and nothing is published on the host.
import type { Exec } from './exec.ts';
import type { Service } from './spec.ts';

export type Services = { env: Record<string, string>; containers: string[] };

export const serviceContainer = (run: string, service: Service) => `${run}-svc-${service.name}`;

// `${host}` and `${port}` in a value of agentEnv.
export function agentEnvOf(service: Service, host: string, port: number): Record<string, string> {
	return Object.fromEntries(Object.entries(service.agentEnv).map(([key, value]) => [key, value.replaceAll('${host}', host).replaceAll('${port}', String(port))]));
}

// The host port of a published container port, from `docker port` ("127.0.0.1:55012", one line per address).
export function hostPort(output: string): number | undefined {
	const port = Number(output.trim().split('\n')[0]?.split(':').pop());
	return Number.isInteger(port) && port > 0 ? port : undefined;
}

// Starts the services in order and waits until each one answers its ready command. On a failure, the containers
// already started are in `started.containers`: the caller removes them with stopServices.
export async function startServices(exec: Exec, services: Service[], run: { name: string; network?: string; docker?: string }, started: Services, wait = { tries: 60, ms: 1000 }) {
	const docker = run.docker ?? 'docker';
	for (const service of services) {
		const name = serviceContainer(run.name, service);
		// The agent can run commands in the service (a Postgres superuser can, with COPY FROM PROGRAM), so the service gets
		// the limits of the proxy: no capability but those it names, no new privilege, a read-only root (its tmpfs
		// mounts are the only places it writes), and no DNS on the run network, which the Docker daemon resolves on the host.
		const args = ['run', '-d', '--name', name, '--cap-drop', 'ALL', ...(service.capAdd ?? []).flatMap((cap) => ['--cap-add', cap]), '--security-opt', 'no-new-privileges', '--read-only', '--pids-limit', '512', '--memory', '1g', '--cpus', '2'];
		for (const path of service.tmpfs ?? []) args.push('--tmpfs', path);
		for (const [key, value] of Object.entries(service.env ?? {})) args.push('-e', `${key}=${value}`);
		if (run.network) args.push('--network', run.network, '--network-alias', service.name, '--dns', '127.0.0.1');
		else args.push('-p', `127.0.0.1::${service.port}`);
		args.push(service.image);
		started.containers.push(name);
		const created = await exec(docker, args);
		if (created.code !== 0) throw new Error(`service ${service.name} did not start: ${(created.stderr || created.stdout).trim().slice(0, 200)}`);
		let port = service.port;
		if (!run.network) {
			const published = hostPort((await exec(docker, ['port', name, `${service.port}/tcp`])).stdout);
			if (!published) throw new Error(`service ${service.name}: Docker gave no host port for ${service.port}`);
			port = published;
		}
		let ready = false;
		for (let index = 0; index < wait.tries && !ready; index++) {
			ready = (await exec(docker, ['exec', name, ...service.ready])).code === 0;
			if (!ready) await new Promise((resolve) => setTimeout(resolve, wait.ms));
		}
		if (!ready) throw new Error(`service ${service.name} did not answer its ready command in ${Math.round((wait.tries * wait.ms) / 1000)} s`);
		Object.assign(started.env, agentEnvOf(service, run.network ? service.name : '127.0.0.1', port));
	}
}

// Removes the containers of the services. Safe to call twice. Before `network rm`: a network with a container stays.
export async function stopServices(exec: Exec, started: Services, docker = 'docker') {
	for (const name of started.containers.splice(0)) await exec(docker, ['rm', '--force', name]);
}
