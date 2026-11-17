#!/usr/bin/env node
// A fake `codex` for the tests. It writes the file a real run would write and prints `codex exec --json` events.
// FAKE_AGENT_RECORD names a file where it writes its argv, its cwd, the AGENTS.md of the clone and the files of CODEX_HOME.
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--version')) {
	console.log('codex-cli 0.0.0');
	process.exit(0);
}
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
appendFileSync('agent-output.txt', `agent was here: ${prompt.trim()}\n`);
if (process.env.FAKE_AGENT_RECORD) {
	const home = process.env.CODEX_HOME;
	writeFileSync(
		process.env.FAKE_AGENT_RECORD,
		JSON.stringify({ args, prompt, cwd: process.cwd(), agentsMd: existsSync('AGENTS.md') ? readFileSync('AGENTS.md', 'utf8') : null, home, homeFiles: home ? readdirSync(home) : null })
	);
}
const events = [
	{ type: 'thread.started', thread_id: 't1' },
	{ type: 'turn.started' },
	{ type: 'item.completed', item: { id: 'item_0', type: 'file_change', changes: [{ path: join(process.cwd(), 'agent-output.txt'), kind: 'update' }], status: 'completed' } },
	{ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: "/bin/zsh -lc 'node --test'", aggregated_output: 'ok\n', exit_code: 0, status: 'completed' } },
	{ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'Done.' } },
	{ type: 'turn.completed', usage: { input_tokens: 1_000_000, cached_input_tokens: 800_000, output_tokens: 10_000, reasoning_output_tokens: 0 } }
];
for (const event of events) console.log(JSON.stringify(event));
