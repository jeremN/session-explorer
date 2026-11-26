// Computes the behavior counts and the steps of each run again, from the saved transcripts. For an eval of an older
// runner, or after a change to the command patterns of the spec. The other metrics keep their values.
// Usage: node eval-runner/metrics.ts <evalDir>
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { CommandPatterns } from '../context-tracer/tracer.ts';
import { behaviorFiles } from './score.ts';
import { BEHAVIOR_KEYS, aggregate } from './stats.ts';
import type { ConfigStats, RunRecord } from './stats.ts';

type SavedEval = { spec?: { commands?: CommandPatterns }; configs?: Array<{ name: string } & Partial<ConfigStats>>; runs: RunRecord[] };

const USAGE = 'Usage: node eval-runner/metrics.ts <evalDir>';

export async function main(argv: string[]): Promise<number> {
	const [flag, ...rest] = argv;
	if (!flag || flag.startsWith('-') || rest.length) {
		console.error(`${flag && flag.startsWith('-') ? `${flag}: unknown option` : rest.length ? `${rest[0]}: unknown argument` : 'No eval dir.'}\n\n${USAGE}`);
		return 2;
	}
	const evalDir = resolve(flag);
	if (!existsSync(join(evalDir, 'eval.json'))) {
		console.error(`No eval.json in ${evalDir}.\n\n${USAGE}`);
		return 2;
	}
	const ev = JSON.parse(readFileSync(join(evalDir, 'eval.json'), 'utf8')) as SavedEval;
	let updated = 0;
	let missing = 0;
	for (const record of ev.runs) {
		if (record.status === 'skipped' || !record.metrics) continue;
		// A cached run has its files in the eval that ran it.
		const transcript = record.cached ? join(dirname(evalDir), record.cached.evalId, 'runs', record.cached.id, 'transcript.jsonl') : join(evalDir, 'runs', record.id, 'transcript.jsonl');
		if (!existsSync(transcript)) {
			missing++;
			continue;
		}
		const { metrics, steps } = behaviorFiles(transcript, ev.spec?.commands);
		for (const key of BEHAVIOR_KEYS) delete record.metrics[key];
		Object.assign(record.metrics, metrics);
		record.steps = steps;
		updated++;
	}
	const configs = ev.configs ?? [];
	const stats = aggregate(ev.runs, configs.map((config) => config.name));
	for (const config of configs) config.metrics = stats[config.name].metrics;
	// A new file, then a rename: a reader never sees half an eval.json.
	const temporary = join(evalDir, `eval.json.${process.pid}.tmp`);
	writeFileSync(temporary, JSON.stringify(ev));
	renameSync(temporary, join(evalDir, 'eval.json'));
	console.log(`${updated} runs updated${missing ? `, ${missing} without a transcript` : ''}.`);
	return 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
