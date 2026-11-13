#!/usr/bin/env node
// A fake `claude` for the tests. It makes the files a real run would make and prints a CLI result.
// FAKE_CLAUDE_MODE: "sleep" waits 30 s (timeout test), "budget" reports a budget stop, "notranscript" writes no transcript. FAKE_CLAUDE_COST sets the cost.
import { appendFileSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
if (process.env.FAKE_CLAUDE_ARGV) writeFileSync(process.env.FAKE_CLAUDE_ARGV, JSON.stringify({ args, cwd: process.cwd() }));
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
