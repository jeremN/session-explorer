// The report of a campaign: each config against the reference, per spec and pooled over the specs. A pure function of
// the runs of the evals. The statistics are in inference.ts, and README.md names each method.
// Usage: node eval-runner/campaign-report.ts <evalDir>... --reference <config> [--resamples N] [--seed N] [--json]
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { bootstrapCI, fisherExact, permutationTest, powerRuns } from './inference.ts';
import type { Stat, Stratum } from './inference.ts';
import { median } from './stats.ts';
import type { RunRecord } from './stats.ts';

export type ReportEval = { name: string; runs: RunRecord[] };
export type ReportOptions = { reference: string; resamples?: number; seed?: number };

type Pair = { config: number; reference: number };
export type PassStat = { config: { passed: number; n: number }; reference: { passed: number; n: number }; diff: number; p: number; ci: [number, number]; power?: number };
// `config` and `reference`: the median of the values. `diff`: the stratified difference of the medians.
export type MetricStat = { config: number; reference: number; n: Pair; diff: number; p: number; ci: [number, number] };
export type FlagStat = { config: { flagged: number; n: number }; reference: { flagged: number; n: number }; diff: number; p: number; ci: [number, number]; power?: number };
export type Cell = { n: Pair; pass: PassStat; metrics: Record<string, MetricStat>; graders: Record<string, FlagStat> };
export type ConfigReport = { name: string; perSpec: Record<string, Cell>; pooled: Cell };
export type Report = { reference: string; resamples: number; seed: number; specs: string[]; configs: ConfigReport[] };

// The metrics of the table. A metric that no run has stays out of the cell: `turns` has no source yet.
const METRICS: { key: string; pick: (run: RunRecord) => number | undefined }[] = [
	{ key: 'cost', pick: (run) => run.metrics?.cost },
	{ key: 'turns', pick: (run) => (run.metrics as { turns?: number } | undefined)?.turns },
	{ key: 'toolCalls', pick: (run) => run.metrics?.toolCalls }
];

const RESAMPLES = 10_000;
const SEED = 20260101;

// A skipped or interrupted run is no sample.
const counted = (runs: RunRecord[]) => runs.filter((run) => run.status !== 'skipped' && run.status !== 'interrupted');
const flagged = (run: RunRecord, grader: string) => {
	const grade = run.grades?.[grader];
	return grade?.status === 'ok' ? (grade.flagged ?? grade.findings.length > 0) : undefined;
};

// FNV-1a: the seed of a statistic follows its label, not the order of the computation.
function seedOf(base: number, label: string) {
	let hash = 2166136261;
	for (const char of label) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
	return (base + hash) >>> 0;
}

// One spec: the counted runs of the config and of the reference.
type Pairing = { spec: string; config: RunRecord[]; reference: RunRecord[] };

const total = (values: number[]) => values.reduce((sum, value) => sum + value, 0);
const strataOf = (pairs: Pairing[], pick: (run: RunRecord) => number | undefined): Stratum[] =>
	pairs.map((pair) => ({ a: pair.config.map(pick).filter((value): value is number => value !== undefined), b: pair.reference.map(pick).filter((value): value is number => value !== undefined) }));
const nOf = (strata: Stratum[]): Pair => ({ config: total(strata.map((stratum) => stratum.a.length)), reference: total(strata.map((stratum) => stratum.b.length)) });
const all = (strata: Stratum[], side: 'a' | 'b') => strata.flatMap((stratum) => stratum[side]);
const rate = (counts: { n: number }, hits: number) => (counts.n === 0 ? 0 : hits / counts.n);

function cellOf(pairs: Pairing[], label: string, { resamples, seed }: { resamples: number; seed: number }): Cell | undefined {
	const draws = (what: string, stat: Stat) => ({ stat, resamples, seed: seedOf(seed, `${label}|${what}`) });
	const passes = strataOf(pairs, (run) => (run.acceptance?.passed ? 1 : 0));
	const n = nOf(passes);
	if (n.config === 0 || n.reference === 0) return undefined;
	const passed = { config: total(all(passes, 'a')), reference: total(all(passes, 'b')) };
	const ci = bootstrapCI(passes, draws('pass', 'mean'));
	const rates = { config: passed.config / n.config, reference: passed.reference / n.reference };
	const pass: PassStat = {
		config: { passed: passed.config, n: n.config },
		reference: { passed: passed.reference, n: n.reference },
		diff: ci.diff,
		p: fisherExact(passed.config, n.config - passed.config, passed.reference, n.reference - passed.reference),
		ci: [ci.low, ci.high],
		power: powerRuns(rates.config, rates.reference, { seed: seedOf(seed, `${label}|pass|power`), simulations: 1000 })
	};

	const metrics: Record<string, MetricStat> = {};
	for (const { key, pick } of METRICS) {
		const strata = strataOf(pairs, pick);
		const counts = nOf(strata);
		if (counts.config === 0 || counts.reference === 0) continue;
		const test = permutationTest(strata, draws(key, 'median'));
		const interval = bootstrapCI(strata, draws(key, 'median'));
		metrics[key] = { config: median(all(strata, 'a')), reference: median(all(strata, 'b')), n: counts, diff: test.diff, p: test.p, ci: [interval.low, interval.high] };
	}

	const graders: Record<string, FlagStat> = {};
	const names = [...new Set(pairs.flatMap((pair) => [...pair.config, ...pair.reference]).flatMap((run) => Object.keys(run.grades ?? {})))];
	for (const name of names) {
		const flags = strataOf(pairs, (run) => {
			const value = flagged(run, name);
			return value === undefined ? undefined : value ? 1 : 0;
		});
		const counts = nOf(flags);
		if (counts.config === 0 || counts.reference === 0) continue;
		const hits = { config: total(all(flags, 'a')), reference: total(all(flags, 'b')) };
		const interval = bootstrapCI(flags, draws(`grader ${name}`, 'mean'));
		graders[name] = {
			config: { flagged: hits.config, n: counts.config },
			reference: { flagged: hits.reference, n: counts.reference },
			diff: interval.diff,
			p: fisherExact(hits.config, counts.config - hits.config, hits.reference, counts.reference - hits.reference),
			ci: [interval.low, interval.high],
			power: powerRuns(hits.config / counts.config, hits.reference / counts.reference, { seed: seedOf(seed, `${label}|grader ${name}|power`), simulations: 1000 })
		};
	}
	return { n, pass, metrics, graders };
}

export function buildReport(evals: ReportEval[], { reference, resamples = RESAMPLES, seed = SEED }: ReportOptions): Report {
	const named = new Set(evals.flatMap((entry) => entry.runs.map((run) => run.config)));
	if (!named.has(reference)) throw new Error(`reference: no run of the config "${reference}"`);
	const configs: ConfigReport[] = [];
	for (const name of [...named].filter((entry) => entry !== reference)) {
		const pairs: Pairing[] = evals.map((entry) => ({ spec: entry.name, config: counted(entry.runs.filter((run) => run.config === name)), reference: counted(entry.runs.filter((run) => run.config === reference)) })).filter((pair) => pair.config.length > 0 && pair.reference.length > 0);
		const perSpec: Record<string, Cell> = {};
		for (const pair of pairs) {
			const cell = cellOf([pair], `${name}|${pair.spec}`, { resamples, seed });
			if (cell) perSpec[pair.spec] = cell;
		}
		const pooled = cellOf(pairs, `${name}|pooled`, { resamples, seed });
		if (pooled) configs.push({ name, perSpec, pooled });
	}
	return { reference, resamples, seed, specs: evals.map((entry) => entry.name), configs };
}

const signed = (value: number, digits = 2) => `${value >= 0 ? '+' : '-'}${Math.abs(value).toFixed(digits)}`;
const percent = (value: number) => `${Math.round(value * 100)} %`;
const points = (value: number) => `${value >= 0 ? '+' : '-'}${Math.round(Math.abs(value) * 100)} pts`;
const pText = (p: number) => (p < 0.001 ? 'p <0.001' : `p ${p.toFixed(3)}`);
// No power without an observed difference: the rates are equal, so no sample size is the answer.
const powerText = (power: number | undefined, diff: number) => (diff === 0 ? 'power: no observed difference' : power === undefined ? 'power: over 200 runs' : `80 % power: ${power} runs`);

// The text table: for each config, one line per spec and one pooled line, for the pass rate, each metric and each grader.
export function renderReport(report: Report): string {
	const lines: string[] = [`Report: each config against ${report.reference}. ${report.resamples} resamples, seed ${report.seed}. Intervals are 95 %.`];
	for (const config of report.configs) {
		const rows: [string, Cell][] = [...Object.entries(config.perSpec), ['pooled', config.pooled]];
		const width = Math.max(...rows.map(([label]) => label.length)) + 2;
		lines.push('', `${config.name} vs ${report.reference} (${config.pooled.n.config} runs against ${config.pooled.n.reference}, ${Object.keys(config.perSpec).length} specs)`);
		lines.push('  pass rate');
		for (const [label, cell] of rows) {
			const { pass } = cell;
			lines.push(`    ${label.padEnd(width)}${`${pass.config.passed}/${pass.config.n}`.padStart(6)} ${percent(rate(pass.config, pass.config.passed)).padStart(6)} vs ${`${pass.reference.passed}/${pass.reference.n}`.padStart(5)} ${percent(rate(pass.reference, pass.reference.passed)).padStart(6)}   ${points(pass.diff)} [${points(pass.ci[0])}, ${points(pass.ci[1])}]  Fisher ${pText(pass.p)}  ${powerText(pass.power, pass.diff)}`);
		}
		const keys = [...new Set(rows.flatMap(([, cell]) => Object.keys(cell.metrics)))];
		for (const key of keys) {
			lines.push(`  ${key} (median)`);
			for (const [label, cell] of rows) {
				const metric = cell.metrics[key];
				if (!metric) continue;
				const digits = key === 'cost' ? 2 : 1;
				lines.push(`    ${label.padEnd(width)}${metric.config.toFixed(digits).padStart(7)} vs ${metric.reference.toFixed(digits).padStart(7)}   ${signed(metric.diff, digits)} [${signed(metric.ci[0], digits)}, ${signed(metric.ci[1], digits)}]  permutation ${pText(metric.p)}  n ${metric.n.config} vs ${metric.n.reference}`);
			}
		}
		const graders = [...new Set(rows.flatMap(([, cell]) => Object.keys(cell.graders)))];
		for (const name of graders) {
			lines.push(`  grader ${name}: runs with findings`);
			for (const [label, cell] of rows) {
				const grader = cell.graders[name];
				if (!grader) continue;
				lines.push(`    ${label.padEnd(width)}${`${grader.config.flagged}/${grader.config.n}`.padStart(6)} vs ${`${grader.reference.flagged}/${grader.reference.n}`.padStart(5)}   ${points(grader.diff)} [${points(grader.ci[0])}, ${points(grader.ci[1])}]  Fisher ${pText(grader.p)}  ${powerText(grader.power, grader.diff)}`);
			}
		}
	}
	return lines.join('\n');
}

function main(argv: string[]): number {
	const dirs: string[] = [];
	let reference: string | undefined;
	let resamples: number | undefined;
	let seed: number | undefined;
	let json = false;
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		if (flag === '--reference') reference = argv[++index];
		else if (flag === '--resamples') resamples = Number(argv[++index]);
		else if (flag === '--seed') seed = Number(argv[++index]);
		else if (flag === '--json') json = true;
		else if (flag.startsWith('-')) return usage(`${flag}: unknown option`);
		else dirs.push(resolve(flag));
	}
	if (!dirs.length || !reference) return usage('<evalDir>... and --reference <config>: required');
	if ((resamples !== undefined && !(resamples >= 100)) || (seed !== undefined && !Number.isInteger(seed))) return usage('--resamples: integer from 100. --seed: integer');
	const evals: ReportEval[] = [];
	for (const dir of dirs) {
		try {
			const saved = JSON.parse(readFileSync(join(dir, 'eval.json'), 'utf8')) as { name: string; runs: RunRecord[] };
			evals.push({ name: saved.name, runs: saved.runs });
		} catch {
			console.error(`${dir}: cannot read eval.json`);
			return 1;
		}
	}
	try {
		const report = buildReport(evals, { reference, resamples, seed });
		console.log(json ? JSON.stringify(report, null, 2) : renderReport(report));
		return 0;
	} catch (error) {
		console.error((error as Error).message);
		return 2;
	}
}

function usage(problem: string) {
	console.error(`${problem}\n\nUsage: node eval-runner/campaign-report.ts <evalDir>... --reference <config> [--resamples N] [--seed N] [--json]\n  Compares each config with the reference over the evals: per eval and pooled. It runs no agent.`);
	return 2;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
