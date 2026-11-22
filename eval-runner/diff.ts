// eval diff: measures what a change to a CLAUDE.md, an AGENTS.md or a skill does. It runs the task of a spec with the
// version of the file at HEAD (before) and with the working tree (after). The cache keeps the "before" runs, and a
// borderline result gets more runs, up to --max-runs.
// Usage: node eval-runner/diff.ts <spec.json> --file <path> [--before <path>] [--config <name>] [--runs 3] [--max-runs 10] [--claude <path>] [--out <dir>]
// --before names a saved copy of the file (or of the skill directory, under the same directory name) that replaces the
// version at HEAD: for a file outside git, such as ~/.claude/CLAUDE.md. eval:watch keeps these copies.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

import { realExec } from './exec.ts';
import type { Exec } from './exec.ts';
import { runEval } from './run.ts';
import { SpecError, loadSpec } from './spec.ts';
import type { Config } from './spec.ts';
import type { ConfigStats, RunRecord } from './stats.ts';

const USAGE = `Usage: node eval-runner/diff.ts <spec.json> --file <path> [--before <path>] [--config <name>] [--runs 3] [--max-runs 10] [--claude <path>] [--out <dir>]

  <spec.json>    the task to measure the change on
  --file P       a CLAUDE.md or AGENTS.md file (it becomes the CLAUDE.md of the clone), or a skill directory
  --before P     a saved copy of the file or skill directory, to use as the version before the change instead of HEAD
  --config N     the config of the spec to start from (default: the first one)
  --runs N       runs per side in the first round (default 3)
  --max-runs N   runs per side at most, when the result stays borderline (default 10)
`;

export type Target = { kind: 'claudeMd' | 'skill'; path: string; head: string | undefined };
export type Verdict = 'same' | 'better' | 'worse' | 'borderline';
// A run is rounded to the cent and the share to the hundredth. A gap under 10 % of the median, or under this floor, is
// noise even when it leaves the range: three identical runs give a range of one value.
const FLOOR: Record<string, number> = { cost: 0.01, subagentCost: 0.01, cacheReadShare: 0.02, wallSec: 1 };
const RELATIVE = 0.1;

export type MetricRow = { key: string; before: number; after: number; min: number; max: number; outside: boolean };

// The pass rate decides the verdict. A gap of half the runs or more is clear; a smaller gap needs more runs.
// A metric is flagged when the median after the change is outside the range of the runs before it.
export function compare(before: ConfigStats, after: ConfigStats): { verdict: Verdict; metrics: MetricRow[] } {
	const rate = (stats: ConfigStats) => (stats.pass.n === 0 ? 0 : stats.pass.passed / stats.pass.n);
	const gap = rate(after) - rate(before);
	const verdict: Verdict = gap === 0 ? 'same' : Math.abs(gap) >= 0.5 ? (gap > 0 ? 'better' : 'worse') : 'borderline';
	const metrics = Object.keys(before.metrics)
		.filter((key) => after.metrics[key])
		.map((key) => {
			const { median, min, max } = before.metrics[key];
			const changed = after.metrics[key].median;
			const tolerance = Math.max(RELATIVE * Math.abs(median), FLOOR[key] ?? 0);
			const outside = (changed < min || changed > max) && Math.abs(changed - median) > tolerance + 1e-9;
			return { key, before: median, after: changed, min, max, outside };
		});
	return { verdict, metrics };
}

// The two configs of a diff. A skill replaces the skill of the template that has the same directory name.
export function diffConfigs(template: Config, target: Target): [Config, Config] {
	if (target.kind === 'claudeMd') {
		const { claudeMd: _claudeMd, ...rest } = template;
		return [
			{ ...rest, name: 'before', ...(target.head === undefined ? {} : { claudeMd: { text: target.head } }) },
			{ ...rest, name: 'after', claudeMd: { file: target.path } }
		];
	}
	const others = (template.skills ?? []).filter((path) => basename(path) !== basename(target.path));
	return [
		{ ...template, name: 'before', skills: target.head === undefined ? others : [...others, target.head] },
		{ ...template, name: 'after', skills: [...others, target.path] }
	];
}

// The version of the file at HEAD. A skill directory is exported under `work`, with the same directory name, because
// the runner installs a skill by its directory name. A file or a skill that HEAD does not have gives undefined.
export async function headVersion(exec: Exec, path: string, work: string): Promise<Target> {
	const real = realpathSync(path);
	const isSkill = statSync(real).isDirectory();
	const top = (await exec('git', ['rev-parse', '--show-toplevel'], { cwd: isSkill ? real : dirname(real) })).stdout.trim();
	if (!top) throw new Error(`--file: ${path} is not in a git repository`);
	const rel = relative(realpathSync(top), real);
	const target: Target = { kind: isSkill ? 'skill' : 'claudeMd', path: real, head: undefined };
	if ((await exec('git', ['cat-file', '-e', `HEAD:${rel}`], { cwd: top })).code !== 0) return target;
	if (!isSkill) return { ...target, head: (await exec('git', ['show', `HEAD:${rel}`], { cwd: top })).stdout };
	mkdirSync(work, { recursive: true });
	const archive = join(work, 'head.tar');
	const exported = await exec('git', ['archive', '--output', archive, 'HEAD', rel], { cwd: top });
	if (exported.code !== 0) throw new Error(`git archive failed for ${rel}: ${exported.stderr.trim()}`);
	const unpacked = await exec('tar', ['-xf', archive, '-C', work]);
	if (unpacked.code !== 0) throw new Error(`tar failed: ${unpacked.stderr.trim()}`);
	return { ...target, head: join(work, rel) };
}

// A saved copy as the version before the change. A skill copy must have the directory name of the skill: the runner
// installs a skill by its directory name.
export function savedVersion(path: string, before: string): Target {
	const real = realpathSync(path);
	const isSkill = statSync(real).isDirectory();
	if (isSkill !== statSync(before).isDirectory()) throw new SpecError(`--before: ${before} must be a ${isSkill ? 'directory' : 'file'}, as ${path} is`);
	if (isSkill && basename(before) !== basename(real)) throw new SpecError(`--before: the directory must be named ${basename(real)}, as the skill`);
	return { kind: isSkill ? 'skill' : 'claudeMd', path: real, head: isSkill ? realpathSync(before) : readFileSync(before, 'utf8') };
}

// The Skill tool calls of a skill, per run. A plugin skill is named `plugin:name`.
function loadsOf(runs: RunRecord[], config: string, skill: string) {
	return runs
		.filter((run) => run.config === config && run.status !== 'skipped')
		.map((run) => Object.entries(run.metrics?.skills ?? {}).reduce((total, [name, count]) => (name === skill || name.endsWith(`:${skill}`) ? total + count : total), 0));
}

function parseArgs(argv: string[]) {
	const options = { spec: '', file: '', before: undefined as string | undefined, config: undefined as string | undefined, runs: 3, maxRuns: 10, claude: 'claude', out: join(import.meta.dirname, 'out') };
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		const value = () => {
			const next = argv[++index];
			if (next === undefined) throw new SpecError(`${flag}: value required`);
			return next;
		};
		const count = (name: string) => {
			const parsed = Number(value());
			if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) throw new SpecError(`${name}: required integer from 1 to 20`);
			return parsed;
		};
		if (flag === '--help' || flag === '-h') return 'help' as const;
		else if (flag === '--file') options.file = resolve(value());
		else if (flag === '--before') options.before = resolve(value());
		else if (flag === '--config') options.config = value();
		else if (flag === '--runs') options.runs = count('--runs');
		else if (flag === '--max-runs') options.maxRuns = count('--max-runs');
		else if (flag === '--claude') options.claude = value();
		else if (flag === '--out') options.out = resolve(value());
		else if (flag.startsWith('-')) throw new SpecError(`${flag}: unknown option`);
		else options.spec = flag;
	}
	if (!options.spec) throw new SpecError('<spec.json>: required');
	if (!options.file || !existsSync(options.file)) throw new SpecError('--file: required, and the path must exist');
	if (options.maxRuns < options.runs) throw new SpecError('--max-runs: must be at least --runs');
	if (options.before !== undefined && !existsSync(options.before)) throw new SpecError('--before: the path must exist');
	return options;
}

export async function main(argv: string[], exec: Exec = realExec): Promise<number> {
	let options: Exclude<ReturnType<typeof parseArgs>, 'help'>;
	let template: Config;
	let spec: ReturnType<typeof loadSpec>;
	try {
		const parsed = parseArgs(argv);
		if (parsed === 'help') {
			console.log(USAGE);
			return 0;
		}
		options = parsed;
		spec = loadSpec(options.spec);
		const found = options.config === undefined ? spec.configs[0] : spec.configs.find((config) => config.name === options.config);
		if (!found) throw new SpecError(`--config: unknown config ${options.config}`);
		template = found;
		if (options.before) savedVersion(options.file, options.before);
	} catch (error) {
		if (!(error instanceof SpecError)) throw error;
		console.error(`${error.message}\n\n${USAGE}`);
		return error.exitCode;
	}

	mkdirSync(options.out, { recursive: true });
	const work = mkdtempSync(join(options.out, '.diff-'));
	try {
		const target = options.before ? savedVersion(options.file, options.before) : await headVersion(exec, options.file, join(work, 'head'));
		if (target.kind === 'claudeMd' && target.head === readFileSync(target.path, 'utf8')) {
			console.log(`${options.file}: no change against ${options.before ? 'the version before' : 'HEAD'}.`);
			return 0;
		}
		const derived = join(work, 'spec.json');
		writeFileSync(derived, JSON.stringify({ name: `${spec.name}-diff`, task: spec.task, budget: spec.budget, runs: options.runs, configs: diffConfigs(template, target) }));

		// Each round asks for more runs per side. The cache reuses the runs of the earlier rounds.
		const rounds = [...new Set([options.runs, Math.min(options.runs * 2, options.maxRuns), options.maxRuns])];
		let last: { code: number; evalDir?: string } = { code: 0 };
		let result: ReturnType<typeof compare> | undefined;
		let saved: { configs: Array<{ name: string } & ConfigStats>; runs: RunRecord[] } | undefined;
		let runs = options.runs;
		for (runs of rounds) {
			// The derived spec lives in a temp folder; the check scripts sit next to the original spec.
			last = await runEval([derived, '--runs', String(runs), '--claude', options.claude, '--out', options.out, '--spec-dir', spec.dir], exec);
			if (!last.evalDir) return last.code || 1;
			saved = JSON.parse(readFileSync(join(last.evalDir, 'eval.json'), 'utf8'));
			const side = (name: string) => saved!.configs.find((config) => config.name === name)!;
			result = compare(side('before'), side('after'));
			if (result.verdict !== 'borderline') break;
			if (runs < options.maxRuns) console.log(`Borderline at ${runs} runs per side: more runs.`);
		}
		const side = (name: string) => saved!.configs.find((config) => config.name === name)!;
		const skill = target.kind === 'skill' ? basename(target.path) : undefined;
		const report = {
			file: target.path,
			kind: target.kind,
			verdict: result!.verdict,
			runs,
			pass: { before: side('before').pass, after: side('after').pass },
			metrics: result!.metrics,
			...(skill ? { skillLoads: { skill, before: loadsOf(saved!.runs, 'before', skill), after: loadsOf(saved!.runs, 'after', skill) } } : {})
		};
		writeFileSync(join(last.evalDir!, 'diff.json'), JSON.stringify(report, null, '\t'));

		const pass = (stats: ConfigStats) => `${stats.pass.passed}/${stats.pass.n}`;
		console.log(`\n${target.path}: ${report.verdict} (${runs} runs per side). Pass: before ${pass(side('before'))}, after ${pass(side('after'))}.`);
		if (side('before').pass.passed === 0) console.log('Warning: the before side never passed. Check the acceptance command before you read the verdict.');
		if (report.skillLoads) console.log(`Skill ${skill} loaded: before ${report.skillLoads.before.join(' ')}, after ${report.skillLoads.after.join(' ')} (per run).`);
		console.table(result!.metrics.map((row) => ({ metric: row.key, before: row.before, after: row.after, 'range before': `${row.min} to ${row.max}`, flag: row.outside ? 'outside the range' : '' })));
		return last.code;
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
