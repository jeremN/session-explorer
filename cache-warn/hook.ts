// UserPromptSubmit hook: warn the user when the prompt meets a cold cache on a large context.
// The prompt is never blocked. Any failure ends with exit code 0 and no output.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { decide } from './decide.ts';
import type { Row } from './decide.ts';

// The end of the transcript holds the last request. A full read of a long session is too slow for a hook.
const TAIL_BYTES = 4 * 1024 * 1024;
const STATE_DIR = path.join(os.tmpdir(), 'cc-cache-warn');
const LOG = path.join(os.homedir(), '.claude', 'logs', 'cache-warn.jsonl');

function tailRows(file: string): Row[] {
	const { size } = fs.statSync(file);
	const start = Math.max(0, size - TAIL_BYTES);
	const buffer = Buffer.alloc(size - start);
	const descriptor = fs.openSync(file, 'r');
	try {
		fs.readSync(descriptor, buffer, 0, buffer.length, start);
	} finally {
		fs.closeSync(descriptor);
	}
	const lines = buffer.toString('utf8').split('\n');
	// A read that starts in the middle of the file starts in the middle of a row.
	if (start > 0) lines.shift();
	return lines.flatMap((line) => {
		try {
			return line ? [JSON.parse(line) as Row] : [];
		} catch {
			return [];
		}
	});
}

const duration = (seconds: number) => {
	const minutes = Math.round(seconds / 60);
	return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`;
};

try {
	// A headless child that a hook starts with CC_HANDOFF_LLM set must not run the hooks of its parent.
	if (process.env.CC_HANDOFF_LLM) process.exit(0);
	const event = JSON.parse(fs.readFileSync(0, 'utf8')) as { transcript_path?: string; session_id?: string };
	if (!event.transcript_path || !fs.existsSync(event.transcript_path)) process.exit(0);
	const found = decide(tailRows(event.transcript_path), Date.now());
	if (!found) process.exit(0);

	// One warning for one pause: a second prompt sent before the first answer meets the same cold cache.
	const state = path.join(STATE_DIR, (event.session_id ?? 'unknown').replace(/[^\w-]/g, '_'));
	if (fs.existsSync(state) && fs.readFileSync(state, 'utf8') === found.lastRequest) process.exit(0);
	fs.mkdirSync(STATE_DIR, { recursive: true });
	fs.writeFileSync(state, found.lastRequest);

	// Numbers and ids only: the log never holds prompt text.
	fs.mkdirSync(path.dirname(LOG), { recursive: true });
	fs.appendFileSync(LOG, `${JSON.stringify({ t: new Date().toISOString(), session: event.session_id ?? '', ...found })}\n`);

	const cost = found.overWarm === null ? '' : ` Ce prompt réécrit le cache : environ ${found.overWarm.toFixed(2)} $ de plus qu'avec un cache chaud.`;
	const message = `Cache expiré : pause de ${duration(found.pauseSec)}, contexte de ${Math.round(found.contextTokens / 1000)} k tokens.${cost} Avant une prochaine longue pause sur cette session : /clear à la frontière de tâche.`;
	process.stdout.write(JSON.stringify({ systemMessage: message }));
} catch {
	// A hook that fails must not stop a prompt.
}
process.exit(0);
