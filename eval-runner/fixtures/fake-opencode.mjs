#!/usr/bin/env node
// A fake `opencode` for the tests. It writes the file a real run would write and prints `opencode run --format json` events.
// FAKE_AGENT_RECORD names a file where it writes its argv, the AGENTS.md of the clone and its config env.
// FAKE_AGENT_ESCAPE names a file outside the clone that it writes, as an agent with no sandbox can.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args.includes('--version')) {
	console.log('1.0.0');
	process.exit(0);
}
const prompt = args[args.indexOf('--') + 1];
appendFileSync('agent-output.txt', `agent was here: ${prompt}\n`);
if (process.env.FAKE_AGENT_RECORD) {
	writeFileSync(
		process.env.FAKE_AGENT_RECORD,
		JSON.stringify({ args, cwd: process.cwd(), pwd: process.env.PWD, agentsMd: existsSync('AGENTS.md') ? readFileSync('AGENTS.md', 'utf8') : null, xdg: process.env.XDG_CONFIG_HOME, noClaude: process.env.OPENCODE_DISABLE_CLAUDE_CODE })
	);
}
if (process.env.FAKE_AGENT_ESCAPE) writeFileSync(process.env.FAKE_AGENT_ESCAPE, 'escaped\n');
const at = Date.parse('2026-11-17T10:00:00Z');
const part = (fields) => ({ id: `p${Math.random()}`, sessionID: 's', messageID: 'm', ...fields });
const events = [
	{ type: 'step_start', timestamp: at, part: part({ type: 'step-start' }) },
	{ type: 'tool_use', timestamp: at + 1000, part: part({ type: 'tool', tool: 'edit', callID: 'c1', state: { status: 'completed', input: { filePath: `${process.cwd()}/agent-output.txt` }, output: '' } }) },
	{ type: 'tool_use', timestamp: at + 2000, part: part({ type: 'tool', tool: 'bash', callID: 'c2', state: { status: 'completed', input: { command: 'npm test' }, output: 'fail', metadata: { exit: 1 } } }) },
	{ type: 'tool_use', timestamp: at + 3000, part: part({ type: 'tool', tool: 'bash', callID: 'c3', state: { status: 'completed', input: { command: 'npm test' }, output: 'ok', metadata: { exit: 0 } } }) },
	{ type: 'step_finish', timestamp: at + 4000, part: part({ type: 'step-finish', reason: 'tool-calls', tokens: { input: 1000, output: 50, reasoning: 10, cache: { read: 500, write: 0 } }, cost: 0.0021 }) },
	{ type: 'text', timestamp: at + 5000, part: part({ type: 'text', text: 'Done.' }) },
	{ type: 'step_finish', timestamp: at + 6000, part: part({ type: 'step-finish', reason: 'stop', tokens: { input: 100, output: 5, reasoning: 0, cache: { read: 1500, write: 0 } }, cost: 0.0004 }) }
];
for (const event of events) console.log(JSON.stringify(event));
