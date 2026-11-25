// Grades the diff of each run with the graders of the spec, after the eval. The acceptance check says pass or fail; a
// grader says what is wrong with a change that passed.
// A command grader is a process. It gets a new clone of the change (the base, the setup files of the config, the setup
// command, diff.patch) and prints its findings as JSON. Blind, it never sees the config name or the run id: the clone,
// the copy of the patch and the environment name only a random grade id. A pattern grader reads the added lines of
// diff.patch, with no clone and no process.
// Usage: node eval-runner/grade.ts <evalDir> [--graders <name>[,<name>]] [--runs <id>[,<id>]] [--spec <spec.json>] [--force]
//   --spec takes the graders and budget.gradersUsd of that spec. It must name the same task: same repo, base and prompt.
//   --force runs every grader again, even when the grade cache holds its result.
// Exit codes: 0 done, 1 a grade has the status error, 2 invalid arguments.
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { setupFiles } from './command.ts';
import { realExec } from './exec.ts';
import type { Exec } from './exec.ts';
import { loadSpec } from './spec.ts';
import type { CommandGrader, Config, Grader, PatternGrader, Spec } from './spec.ts';
import { gradeStats } from './stats.ts';
import type { Finding, Grade, RunRecord } from './stats.ts';
import { rebuildRun, removeWorkspace } from './workspace.ts';

const USAGE = 'Usage: node eval-runner/grade.ts <evalDir> [--graders <name>[,<name>]] [--runs <id>[,<id>]] [--spec <spec.json>] [--force]';
// Bump it when a grader gets a different input for the same diff.
const SCHEMA = 'eval-runner-grade/v1';
// A run that stopped on an error or the budget, or never started, has no change worth a grade.
const GRADED: ReadonlySet<RunRecord['status']> = new Set(['ok', 'timeout']);
const SUMMARY_MAX = 200;

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const dollars = (value: number) => Math.round(value * 100) / 100;

type Section = { path?: string; deleted: boolean; header: boolean };
type AddedLine = { file: string; line: number; text: string };

// The files that a patch changes, and its added lines with their line number in the new file. The hunk counts tell
// an added line `++i` (`+++i` in the patch) from a file header. A deleted file (`+++ /dev/null`) changes no path.
export function parsePatch(patch: string): { files: string[]; added: AddedLine[] } {
	const sections: Section[] = [];
	const added: AddedLine[] = [];
	let current: Section | undefined;
	let oldLeft = 0;
	let newLeft = 0;
	let line = 0;
	const unquote = (path: string) => (path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path);
	for (const text of patch.split('\n')) {
		if (oldLeft > 0 || newLeft > 0) {
			if (text.startsWith('\\')) continue;
			if (text.startsWith('+')) {
				if (current?.path) added.push({ file: current.path, line, text: text.slice(1) });
				line += 1;
				newLeft -= 1;
			} else if (text.startsWith('-')) oldLeft -= 1;
			else {
				line += 1;
				oldLeft -= 1;
				newLeft -= 1;
			}
			continue;
		}
		const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
		if (hunk) {
			oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
			line = Number(hunk[2]);
			newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
			continue;
		}
		const header = /^diff --git (?:"?a\/.*"?) "?b\/(.*?)"?$/.exec(text);
		if (header) {
			current = { path: header[1], deleted: false, header: false };
			sections.push(current);
		} else if (text.startsWith('deleted file mode') && current) current.deleted = true;
		else if (text.startsWith('+++ ')) {
			// A plain unified diff has no `diff --git` line: its `+++` line starts the file.
			if (!current || current.header) {
				current = { deleted: false, header: false };
				sections.push(current);
			}
			current.header = true;
			const path = unquote(text.slice(4).replace(/\t.*$/, ''));
			if (path === '/dev/null') current.deleted = true;
			else current.path = path.replace(/^b\//, '');
		}
	}
	return { files: sections.flatMap((section) => (section.deleted || !section.path ? [] : [section.path])), added };
}

// One finding per rule and added line. A require rule gives one finding when no changed file matches its paths.
export function patternFindings(grader: PatternGrader, patch: string): Finding[] {
	const { files, added } = parsePatch(patch);
	const rules = grader.rules.map((rule) => ({ rule, pattern: new RegExp(rule.pattern), paths: rule.paths === undefined ? undefined : new RegExp(rule.paths) }));
	const findings: Finding[] = [];
	for (const { file, line, text } of added) {
		for (const { rule, pattern, paths } of rules) {
			if (paths && !paths.test(file)) continue;
			if (pattern.test(text)) findings.push({ severity: rule.severity, rule: rule.name, file, line, summary: text.trim().slice(0, SUMMARY_MAX) });
		}
	}
	for (const required of grader.require) {
		const paths = new RegExp(required.paths);
		if (!files.some((file) => paths.test(file))) findings.push({ severity: required.severity, rule: required.name, summary: `no changed file matches ${required.paths}` });
	}
	return findings;
}

// The stdout of a command grader: { findings: [{ severity, summary, file?, line?, rule? }], costUsd? }. Other fields
// are dropped. A string is the reason the output is refused.
export function graderOutput(stdout: string): { findings: Finding[]; costUsd?: number } | string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return 'stdout is not valid JSON';
	}
	if (!isObject(parsed) || !Array.isArray(parsed.findings)) return 'stdout has no findings array';
	const findings: Finding[] = [];
	for (const [index, raw] of parsed.findings.entries()) {
		const problem = `findings[${index}]`;
		if (!isObject(raw) || typeof raw.severity !== 'string' || raw.severity === '' || typeof raw.summary !== 'string') return `${problem} needs a severity and a summary`;
		if (raw.file !== undefined && typeof raw.file !== 'string') return `${problem}.file must be a string`;
		if (raw.line !== undefined && !(Number.isInteger(raw.line) && (raw.line as number) >= 0)) return `${problem}.line must be a line number`;
		if (raw.rule !== undefined && typeof raw.rule !== 'string') return `${problem}.rule must be a string`;
		findings.push({ severity: raw.severity, summary: raw.summary, ...(raw.file === undefined ? {} : { file: raw.file as string }), ...(raw.line === undefined ? {} : { line: raw.line as number }), ...(raw.rule === undefined ? {} : { rule: raw.rule as string }) });
	}
	const cost = parsed.costUsd;
	if (cost !== undefined && !(typeof cost === 'number' && Number.isFinite(cost) && cost >= 0)) return 'costUsd must be a number of 0 or more';
	return { findings, ...(cost === undefined ? {} : { costUsd: cost }) };
}

// What a grade pass needs. `runs` are the records it changes: each gets `grades[<grader>]`.
export type GradeTarget = { evalId: string; evalDir: string; baseSha: string; spec: { dir: string; task: Spec['task']; configs: Config[]; budget?: Partial<Spec['budget']>; graders?: Grader[] }; runs: RunRecord[] };
export type GradeOptions = { exec?: Exec; graders?: string[]; runs?: string[]; force?: boolean };

// The diff of the run, or of the run it reuses from the run cache.
function patchOf(evalDir: string, run: RunRecord): string | undefined {
	const own = join(evalDir, 'runs', run.id, 'diff.patch');
	if (existsSync(own)) return own;
	const reused = run.cached && join(dirname(evalDir), run.cached.evalId, 'runs', run.cached.id, 'diff.patch');
	return reused && existsSync(reused) ? reused : undefined;
}

// The same seed gives the same order, so a second pass meets the runs in the order of the first.
function shuffle<T>(items: T[], seedText: string): T[] {
	let seed = Number.parseInt(sha(seedText).slice(0, 8), 16);
	const random = () => {
		// mulberry32
		seed = (seed + 0x6d2b79f5) | 0;
		let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
	const result = [...items];
	for (let index = result.length - 1; index > 0; index--) {
		const other = Math.floor(random() * (index + 1));
		[result[index], result[other]] = [result[other], result[index]];
	}
	return result;
}

// A grade is reused when the grader would get the same thing again. A blind grader never sees the config. An open one
// does, so the config counts in its key.
function gradeKey(target: GradeTarget, grader: CommandGrader, diff: string, config: Config | undefined) {
	return sha(JSON.stringify({ schema: SCHEMA, baseSha: target.baseSha, diff: sha(diff), grader, specDir: target.spec.dir, ...(grader.blind ? {} : { config: config ?? null }) }));
}

async function runCommand(exec: Exec, target: GradeTarget, grader: CommandGrader, run: RunRecord, patch: string, id: string): Promise<Grade> {
	const config = target.spec.configs.find((entry) => entry.name === run.config) ?? { name: run.config };
	// Every path the grader gets is random or named by the grade id, never by the run.
	const clone = mkdtempSync(join(tmpdir(), 'eval-grade-'));
	const gitDir = mkdtempSync(join(tmpdir(), 'eval-grade-git-'));
	const copies = mkdtempSync(join(tmpdir(), 'eval-grade-diff-'));
	try {
		const diff = join(copies, `${id}.patch`);
		copyFileSync(patch, diff);
		// Blind: the clone holds the base and the task setup only, never the harness files of the config. Every diff is then
		// judged against the same instruction files, and the clone does not reveal the config.
		await rebuildRun(exec, { task: target.spec.task, baseSha: target.baseSha, specDir: target.spec.dir, setup: setupFiles(grader.blind ? { name: 'base' } : config), patch: diff, dir: clone, gitDir });
		const env = { EVAL_GRADE_ID: id, EVAL_BASE: target.baseSha, EVAL_DIFF: diff, EVAL_SPEC_DIR: target.spec.dir, ...(grader.blind ? {} : { EVAL_CONFIG: run.config, EVAL_RUN_ID: run.id }) };
		const started = Date.now();
		const result = await exec('sh', ['-c', grader.command], { cwd: clone, env, timeoutMs: grader.timeoutSec * 1000 });
		const durationMs = Date.now() - started;
		const runDir = join(target.evalDir, 'runs', run.id);
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, `grade-${grader.name}.log`), result.stdout + (result.stderr ? `\n[stderr]\n${result.stderr}` : ''));
		if (result.timedOut) return { status: 'timeout', id, findings: [], durationMs, note: `no result after ${grader.timeoutSec} s` };
		if (result.code !== 0) return { status: 'error', id, findings: [], durationMs, note: `exit code ${result.code}: ${result.stderr.trim().slice(-200)}` };
		const output = graderOutput(result.stdout);
		if (typeof output === 'string') return { status: 'error', id, findings: [], durationMs, note: output };
		return { status: 'ok', id, findings: output.findings, ...(output.costUsd === undefined ? {} : { costUsd: output.costUsd }), durationMs };
	} catch (error) {
		return { status: 'error', id, findings: [], note: (error as Error).message.slice(0, 300) };
	} finally {
		await removeWorkspace(clone);
		await removeWorkspace(gitDir);
		await removeWorkspace(copies);
	}
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

function describe(grade: Grade) {
	if (grade.status !== 'ok') return `${grade.status}: ${grade.note ?? ''}`;
	const cost = grade.cached ? ', cached' : grade.costUsd === undefined ? '' : `, ${dollars(grade.costUsd)} $`;
	return `ok, ${plural(grade.findings.length, 'finding')}${cost}`;
}

// Grades the runs in place, in a shuffled order, so a grader meets the configs interleaved. A progress line names the
// grade id and the grader, never the config: the summary at the end names the configs.
export async function gradeRuns(target: GradeTarget, { exec = realExec, graders: only, runs: onlyRuns, force = false }: GradeOptions = {}): Promise<{ errors: number; spentUsd: number }> {
	const graders = (target.spec.graders ?? []).filter((grader) => !only || only.includes(grader.name));
	const cacheDir = join(dirname(target.evalDir), 'cache', 'grades');
	const budget = target.spec.budget?.gradersUsd;
	const todo: { run: RunRecord; patch: string; diff: string }[] = [];
	for (const run of target.runs.filter((entry) => !onlyRuns || onlyRuns.includes(entry.id))) {
		const patch = patchOf(target.evalDir, run);
		const diff = patch ? readFileSync(patch, 'utf8') : '';
		const why = !GRADED.has(run.status) ? `run status ${run.status}` : !patch ? 'no diff.patch' : !diff.trim() ? 'empty diff' : undefined;
		if (why) for (const grader of graders) (run.grades ??= {})[grader.name] = { status: 'skipped', findings: [], note: why };
		else todo.push({ run, patch: patch!, diff });
	}
	const pairs = shuffle(todo, target.evalId).flatMap((item) => graders.map((grader) => ({ ...item, grader })));
	let spent = 0;
	let errors = 0;
	for (const [position, { run, patch, diff, grader }] of pairs.entries()) {
		const id = randomBytes(4).toString('hex');
		let grade: Grade;
		if (grader.kind === 'pattern') grade = { status: 'ok', id, findings: patternFindings(grader, diff) };
		else {
			const config = target.spec.configs.find((entry) => entry.name === run.config);
			const file = join(cacheDir, `${gradeKey(target, grader, diff, config)}.json`);
			if (!force && existsSync(file)) grade = { ...(JSON.parse(readFileSync(file, 'utf8')) as { grade: Grade }).grade, cached: true };
			else if (budget !== undefined && spent >= budget) grade = { status: 'budget', id, findings: [], note: 'the graders budget is spent' };
			else {
				grade = await runCommand(exec, target, grader, run, patch, id);
				// A grader that prints no cost costs nothing toward the budget.
				spent += grade.costUsd ?? 0;
				if (grade.status === 'ok') {
					mkdirSync(cacheDir, { recursive: true });
					writeFileSync(file, JSON.stringify({ evalId: target.evalId, grade }));
				}
			}
		}
		if (grade.status === 'error') errors += 1;
		(run.grades ??= {})[grader.name] = grade;
		console.log(`[${position + 1}/${pairs.length}] ${grade.id ?? id} ${grader.name} ${describe(grade)}`);
	}

	const configs = [...new Set(target.runs.map((run) => run.config))];
	const lines = configs.flatMap((config) => {
		const stats = gradeStats(target.runs.filter((run) => run.config === config && run.status !== 'skipped'));
		return graders.flatMap((grader) => {
			const own = stats?.[grader.name];
			if (!own) return [];
			const severities = Object.entries(own.bySeverity).map(([severity, count]) => `${severity} ${count}`).join(', ');
			return [`${config} ${grader.name}: ${own.withFindings}/${own.graded} runs with findings, ${plural(own.findings, 'finding')}${severities ? ` (${severities})` : ''}`];
		});
	});
	if (lines.length) console.log(`Findings per config:\n${lines.join('\n')}`);
	if (graders.some((grader) => grader.kind === 'command')) console.log(`Graders spent ${dollars(spent)} $.`);
	return { errors, spentUsd: spent };
}

type SavedEval = { id: string; baseSha: string; spec: GradeTarget['spec']; configs?: { name: string; grades?: unknown }[]; runs: RunRecord[] };

export async function main(argv: string[], exec: Exec = realExec): Promise<number> {
	let evalDir: string | undefined;
	let only: string[] | undefined;
	let onlyRuns: string[] | undefined;
	let specPath: string | undefined;
	let force = false;
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		if (flag === '--graders') only = argv[++index]?.split(',');
		else if (flag === '--runs') onlyRuns = argv[++index]?.split(',');
		else if (flag === '--spec') specPath = argv[++index];
		else if (flag === '--force') force = true;
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
	let specDir = ev.spec.dir;
	let budget = ev.spec.budget;
	if (specPath) {
		let spec: Spec;
		try {
			spec = loadSpec(resolve(specPath));
		} catch (error) {
			console.error(`${specPath}: ${(error as Error).message}`);
			return 2;
		}
		const task = ev.spec.task;
		if (spec.task.repo !== task.repo || spec.task.prompt !== task.prompt || spec.task.base !== task.base) {
			console.error(`${specPath} names another task than the eval: same repo, base and prompt are required.`);
			return 2;
		}
		// eval.json keeps the graders of the spec, by name, so it says what gave each grade.
		const added = spec.graders ?? [];
		ev.spec.graders = [...(ev.spec.graders ?? []).filter((grader) => !added.some((entry) => entry.name === grader.name)), ...added];
		specDir = spec.dir;
		if (spec.budget.gradersUsd !== undefined) budget = { ...budget, gradersUsd: spec.budget.gradersUsd };
	}
	const names = (ev.spec.graders ?? []).map((grader) => grader.name);
	if (names.length === 0) {
		console.error(`The spec of ${evalDir} has no graders. Pass --spec with a spec that has some.\n\n${USAGE}`);
		return 2;
	}
	const unknown = (only ?? []).filter((name) => !names.includes(name));
	if (unknown.length) {
		console.error(`--graders: unknown grader ${unknown.join(', ')}. The spec has ${names.join(', ')}.`);
		return 2;
	}
	const { errors } = await gradeRuns({ evalId: ev.id, evalDir, baseSha: ev.baseSha, spec: { ...ev.spec, dir: specDir, budget }, runs: ev.runs }, { exec, graders: only, runs: onlyRuns, force });
	for (const config of ev.configs ?? []) {
		const stats = gradeStats(ev.runs.filter((run) => run.config === config.name && run.status !== 'skipped'));
		if (stats) config.grades = stats;
		else delete config.grades;
	}
	// A new file, then a rename: a reader never sees half an eval.json.
	const temporary = join(evalDir, `eval.json.${process.pid}.tmp`);
	writeFileSync(temporary, JSON.stringify(ev));
	renameSync(temporary, join(evalDir, 'eval.json'));
	return errors ? 1 : 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
