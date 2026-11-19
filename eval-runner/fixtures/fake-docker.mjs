#!/usr/bin/env node
// A fake `docker` for the tests. `run` starts the fake agent of the same name in the folder mounted at /work, with only
// the variables named by `-e`, and HOME set to the folder mounted at /home/agent. `image inspect` succeeds unless
// FAKE_DOCKER_NO_IMAGE is set. FAKE_DOCKER_LOG names a file where every call appends its argv as one JSON line.
// The network calls succeed: `network`, a detached `run -d` (the proxy), `inspect` (the proxy runs), and `logs` (the
// proxy listens, and refuses FAKE_DOCKER_DENY when it is set).
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (process.env.FAKE_DOCKER_LOG) appendFileSync(process.env.FAKE_DOCKER_LOG, `${JSON.stringify({ args, passed: args[0] === 'run' ? Object.fromEntries(args.flatMap((value, index) => (args[index - 1] === '-e' ? [[value, process.env[value]]] : []))) : undefined })}\n`);
if (args[0] === 'image') process.exit(process.env.FAKE_DOCKER_NO_IMAGE ? 1 : 0);
if (args[0] === 'rm' || args[0] === 'network') process.exit(0);
if (args[0] === 'inspect') {
	console.log('true');
	process.exit(0);
}
if (args[0] === 'logs') {
	console.log(JSON.stringify({ listening: 3128, allow: [] }));
	if (process.env.FAKE_DOCKER_DENY) console.log(JSON.stringify({ verdict: 'deny', method: 'CONNECT', target: process.env.FAKE_DOCKER_DENY }));
	process.exit(0);
}
if (args[0] === 'run' && args[1] === '-d') process.exit(0);
if (args[0] !== 'run') process.exit(2);

const WITH_VALUE = new Set(['--name', '--user', '--cap-drop', '--security-opt', '--pids-limit', '--memory', '--cpus', '--network', '-v', '-w', '-e']);
const mounts = {};
const names = [];
let index = 1;
for (; index < args.length && args[index].startsWith('-'); index++) {
	const flag = args[index];
	if (!WITH_VALUE.has(flag)) continue;
	const value = args[++index];
	if (flag === '-v') mounts[value.slice(value.lastIndexOf(':') + 1)] = value.slice(0, value.lastIndexOf(':'));
	if (flag === '-e') names.push(value);
}
const [, command, ...rest] = args.slice(index);
// A value that names a path in the container gets the host path of its mount, as the process would see it.
const host = (value) => Object.entries(mounts).reduce((path, [inside, outside]) => (path === inside || path?.startsWith(`${inside}/`) ? outside + path.slice(inside.length) : path), value);
const env = { PATH: process.env.PATH, HOME: mounts['/home/agent'], ...Object.fromEntries(names.map((name) => [name, host(process.env[name])])) };
const child = spawn(process.execPath, [join(import.meta.dirname, `fake-${command}.mjs`), ...rest], { cwd: mounts['/work'], env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
