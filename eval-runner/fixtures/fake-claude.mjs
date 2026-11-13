#!/usr/bin/env node
// A fake `claude` for the tests. It makes the files a real run would make and prints a CLI result.
// FAKE_CLAUDE_MODE: "sleep" waits 30 s (timeout test), "budget" reports a budget stop, "notranscript" writes no transcript. FAKE_CLAUDE_COST sets the cost.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--version')) {
	console.log('fake-claude 0.0.0');
	process.exit(0);
}
const sessionId = args[args.indexOf('--session-id') + 1];
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;

appendFileSync('agent-output.txt', `agent was here: ${prompt.trim()}\n`);
// The argv goes to a file next to the clone, so a test can read what the runner passed.
// It also records what an agent could find: the git dirs next to the paths of its argv, and the runner git dirs in TMPDIR.
if (process.env.FAKE_CLAUDE_ARGV) {
	const isGitDir = (path) => existsSync(join(path, 'HEAD')) && existsSync(join(path, 'objects'));
	const near = [];
	for (const arg of args.filter((value) => value.startsWith('/'))) {
		const folder = dirname(arg);
		if (!existsSync(folder) || !statSync(folder).isDirectory()) continue;
		for (const name of readdirSync(folder)) if (isGitDir(join(folder, name))) near.push(join(folder, name));
	}
	const tmp = process.env.TMPDIR ?? '/tmp';
	const runnerGitDirs = readdirSync(tmp).filter((name) => name.startsWith('eval-runner-git-')).map((name) => join(tmp, name));
	const generated = args.filter((value) => value.startsWith('/') && existsSync(value) && statSync(value).isFile()).map((path) => readFileSync(path, 'utf8'));
	writeFileSync(
		process.env.FAKE_CLAUDE_ARGV,
		JSON.stringify({ args, cwd: process.cwd(), env: { GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT, GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0, GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0 }, fullEnv: process.env, near, runnerGitDirs, generated })
	);
}
const mode = process.env.FAKE_CLAUDE_MODE;
if (mode !== 'notranscript') {
	const projects = join(process.env.EVAL_RUNNER_PROJECTS_DIR, 'fake');
	mkdirSync(projects, { recursive: true });
	copyFileSync(join(import.meta.dirname, 'transcript.jsonl'), join(projects, `${sessionId}.jsonl`));
}
if (mode === 'sleep') await new Promise((resolve) => setTimeout(resolve, 30_000));
const cost = Number(process.env.FAKE_CLAUDE_COST ?? 0.6);
if (mode === 'budget') {
	console.log(JSON.stringify({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: cost, session_id: sessionId }));
	process.exit(1);
}
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', total_cost_usd: cost, session_id: sessionId }));
