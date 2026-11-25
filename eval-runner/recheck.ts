// Runs the acceptance check again on the saved diff of each run, without the agent. For a check that failed for a
// reason outside the agent (a port in use, a database that did not start), or a hidden test that was wrong.
// Each run gets a new clone at the base, the setup command, its diff.patch, the hidden tests and the acceptance command.
// The record keeps the acceptance it replaced in `rechecked.previous`, and the old log stays as acceptance.original.log.
// Usage: node eval-runner/recheck.ts <evalDir> [--runs <id>[,<id>]] [--spec <spec.json>]
//   --spec takes the acceptance command, the hidden tests and the category of that spec. It must name the same task: same repo, base
//   and prompt. The cached copies of the rechecked runs are then removed: they belong to the old cache key.
import { mkdtempSync, existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { runCheck } from './check.ts';
import { setupFiles } from './command.ts';
import { realExec } from './exec.ts';
import type { Exec } from './exec.ts';
import { loadSpec } from './spec.ts';
import type { Config, Spec } from './spec.ts';
import type { RunRecord } from './stats.ts';
import { collectDiff, rebuildRun, removeWorkspace } from './workspace.ts';

type SavedEval = { id: string; baseSha: string; spec: { dir: string; task: Spec['task']; configs: Config[] }; runs: RunRecord[] };

const USAGE = 'Usage: node eval-runner/recheck.ts <evalDir> [--runs <id>[,<id>]] [--spec <spec.json>]';

// Applies the saved diff in a new clone, and checks that the clone then holds the same change as the run.
async function recheckRun(exec: Exec, ev: SavedEval, task: Spec['task'], specDir: string, record: RunRecord, runDir: string) {
	const config = ev.spec.configs.find((entry) => entry.name === record.config);
	if (!config) throw new Error(`no config ${record.config} in the eval`);
	const clone = mkdtempSync(join(tmpdir(), 'eval-recheck-'));
	const gitDir = mkdtempSync(join(tmpdir(), 'eval-recheck-git-'));
	try {
		const { setupSha, fileMode } = await rebuildRun(exec, { task, baseSha: ev.baseSha, specDir, setup: setupFiles(config), patch: join(runDir, 'diff.patch'), dir: clone, gitDir });
		// The saved patch has no binary content: a run whose diff counts differ is not the same change.
		const { patch: _patch, ...diff } = await collectDiff(exec, clone, setupSha, gitDir, fileMode);
		const saved = record.diff ?? { files: 0, added: 0, deleted: 0 };
		if (diff.files !== saved.files || diff.added !== saved.added || diff.deleted !== saved.deleted) throw new Error(`the applied diff (${JSON.stringify(diff)}) is not the diff of the run (${JSON.stringify(saved)})`);
		const original = join(runDir, 'acceptance.original.log');
		if (!existsSync(original) && existsSync(join(runDir, 'acceptance.log'))) renameSync(join(runDir, 'acceptance.log'), original);
		return await runCheck(exec, task, specDir, clone, runDir);
	} finally {
		await removeWorkspace(clone);
		await removeWorkspace(gitDir);
	}
}

export async function main(argv: string[], exec: Exec = realExec, now = () => new Date().toISOString()): Promise<number> {
	let evalDir: string | undefined;
	let only: string[] | undefined;
	let specPath: string | undefined;
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		if (flag === '--runs') only = argv[++index]?.split(',');
		else if (flag === '--spec') specPath = argv[++index];
		else if (!flag.startsWith('-') && !evalDir) evalDir = resolve(flag);
		else {
			console.error(`${flag}: unknown option\n\n${USAGE}`);
			return 2;
		}
	}
	if (!evalDir || !existsSync(join(evalDir, 'eval.json'))) {
		console.error(`No eval.json in ${evalDir ?? 'the arguments'}.\n\n${USAGE}`);
		return 2;
	}
	const ev = JSON.parse(readFileSync(join(evalDir, 'eval.json'), 'utf8')) as SavedEval;
	let task = ev.spec.task;
	let specDir = ev.spec.dir;
	if (specPath) {
		let spec: Spec;
		try {
			spec = loadSpec(resolve(specPath));
		} catch (error) {
			console.error(`${specPath}: ${(error as Error).message}`);
			return 2;
		}
		if (spec.task.repo !== task.repo || spec.task.prompt !== task.prompt || spec.task.base !== task.base) {
			console.error(`${specPath} names another task than the eval: same repo, base and prompt are required.`);
			return 2;
		}
		task = { ...task, acceptance: spec.task.acceptance, ...(spec.task.hiddenTests ? { hiddenTests: spec.task.hiddenTests } : {}), ...(spec.task.category ? { category: spec.task.category } : {}) };
		specDir = spec.dir;
	}
	const targets = ev.runs.filter((run) => !run.cached && run.status !== 'skipped' && existsSync(join(evalDir, 'runs', run.id, 'diff.patch')) && (!only || only.includes(run.id)));
	let failed = 0;
	const done = new Map<string, RunRecord>();
	for (const record of targets) {
		const before = record.acceptance;
		try {
			const acceptance = await recheckRun(exec, ev, task, specDir, record, join(evalDir, 'runs', record.id));
			record.rechecked = { at: now(), ...(record.rechecked ? { previous: record.rechecked.previous } : before ? { previous: before } : {}) };
			record.acceptance = acceptance;
			done.set(record.id, record);
			const tests = (value?: RunRecord['acceptance']) => (value?.tests ? ` ${value.tests.passed}/${value.tests.total}` : '');
			console.log(`${record.id}: ${before ? (before.passed ? 'passed' : 'failed') + tests(before) : 'no check'} -> ${acceptance.passed ? 'passed' : acceptance.infra ? 'check failed (infra)' : 'failed'}${tests(acceptance)}`);
		} catch (error) {
			failed++;
			console.error(`${record.id}: not rechecked: ${(error as Error).message}`);
		}
	}
	if (specPath) ev.spec.task = task;
	writeFileSync(join(evalDir, 'eval.json'), JSON.stringify(ev, null, '\t'));

	// The cache holds a copy of each record. Same task: the copy gets the new acceptance. New hidden tests or a new
	// check: the copy goes, since its key names the old ones.
	const cacheDir = join(dirname(evalDir), 'cache');
	if (done.size && existsSync(cacheDir)) {
		for (const name of readdirSync(cacheDir).filter((file) => file.endsWith('.jsonl'))) {
			const file = join(cacheDir, name);
			const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
			const kept = lines.flatMap((line) => {
				const entry = JSON.parse(line) as { evalId: string; record: RunRecord };
				const fresh = entry.evalId === ev.id ? done.get(entry.record.id) : undefined;
				if (!fresh) return [line];
				return specPath ? [] : [JSON.stringify({ evalId: entry.evalId, record: fresh })];
			});
			if (kept.join('\n') !== lines.join('\n')) writeFileSync(file, kept.map((line) => `${line}\n`).join(''));
		}
	}
	return failed ? 1 : 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
