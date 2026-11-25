// Aggregates over the runs of one configuration. Pure functions, no file access.
import type { TestCount } from './testcount.ts';

export type Status = 'ok' | 'timeout' | 'budget' | 'error' | 'skipped';
export type RunMetrics = {
	// Absent when the agent gives no cost and the config no price.
	cost?: number;
	billedTokens: number;
	cacheReadShare: number;
	errors: number;
	denials: number;
	outages: number;
	verified: number;
	failed: number;
	loops: number;
	retries: number;
	subagentCost: number;
	skillLoads: number;
	skills: Record<string, number>;
};
export type RunRecord = {
	id: string;
	config: string;
	status: Status;
	sessionId?: string;
	// `tests`: what the test runner of the check counted (see testcount.ts), when the check is a test run.
	// `infra`: the check exited with task.acceptance.infraExitCode, so it failed before it judged the agent.
	acceptance?: { exitCode: number | null; passed: boolean; timedOut: boolean; durationMs: number; tests?: TestCount; infra?: boolean };
	// recheck.ts ran the check again on the saved diff: when, and the acceptance it replaced.
	rechecked?: { at: string; previous?: RunRecord['acceptance'] };
	wallSec?: number;
	cliCostUsd?: number | null;
	diff?: { files: number; added: number; deleted: number };
	metrics?: RunMetrics;
	mrs?: string[];
	note?: string;
	// The targets (host:port) that the network filter of a container run refused.
	blockedHosts?: string[];
	// A run reused from the cache: the eval and the run where its files are.
	cached?: { evalId: string; id: string };
	// The grade of each grader of the spec, by grader name (grade.ts).
	grades?: Record<string, Grade>;
};
export type Finding = { severity: string; summary: string; file?: string; line?: number; rule?: string };
// `id`: the blind grade id. The command grader saw it in place of the run id, so it links a grader report to the run.
// `cached`: the grade comes from the grade cache, at no cost.
export type Grade = { status: 'ok' | 'error' | 'timeout' | 'budget' | 'skipped'; id?: string; findings: Finding[]; costUsd?: number; durationMs?: number; note?: string; cached?: boolean };
// Per grader: the runs with an ok grade, the runs with one finding or more among them, and their findings.
export type GradeStats = { graded: number; withFindings: number; findings: number; bySeverity: Record<string, number> };
export type Spread = { n: number; median: number; min: number; max: number; values: number[] };
export type ConfigStats = { pass: { passed: number; n: number }; metrics: Record<string, Spread>; grades?: Record<string, GradeStats> };

const round = (value: number) => Math.round(value * 10_000) / 10_000;

export function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = sorted.length >> 1;
	return round(sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2);
}

export function spread(values: number[]): Spread | undefined {
	if (values.length === 0) return undefined;
	return { n: values.length, median: median(values), min: Math.min(...values), max: Math.max(...values), values };
}

// A skipped run never started. It is not a sample of the configuration.
const counted = (runs: RunRecord[]) => runs.filter((run) => run.status !== 'skipped');

export function passRate(runs: RunRecord[]) {
	const started = counted(runs);
	return { passed: started.filter((run) => run.acceptance?.passed).length, n: started.length };
}

const PICK: Record<string, (run: RunRecord) => number | undefined> = {
	cost: (run) => run.metrics?.cost,
	billedTokens: (run) => run.metrics?.billedTokens,
	cacheReadShare: (run) => run.metrics?.cacheReadShare,
	wallSec: (run) => run.wallSec,
	errors: (run) => run.metrics?.errors,
	denials: (run) => run.metrics?.denials,
	outages: (run) => run.metrics?.outages,
	loops: (run) => run.metrics?.loops,
	retries: (run) => run.metrics?.retries,
	subagentCost: (run) => run.metrics?.subagentCost,
	skillLoads: (run) => run.metrics?.skillLoads,
	verified: (run) => run.metrics?.verified,
	failed: (run) => run.metrics?.failed,
	lines: (run) => (run.diff ? run.diff.added + run.diff.deleted : undefined)
};

export function aggregate(runs: RunRecord[], configs: string[]): Record<string, ConfigStats> {
	const result: Record<string, ConfigStats> = {};
	for (const name of configs) {
		const own = counted(runs.filter((run) => run.config === name));
		const metrics: Record<string, Spread> = {};
		for (const [key, pick] of Object.entries(PICK)) {
			const found = spread(own.map(pick).filter((value): value is number => value !== undefined));
			if (found) metrics[key] = found;
		}
		const grades = gradeStats(own);
		result[name] = { pass: passRate(own), metrics, ...(grades ? { grades } : {}) };
	}
	return result;
}

// Only an ok grade is a sample. Undefined when no run has a grade, so an eval without graders keeps its shape.
export function gradeStats(runs: RunRecord[]): Record<string, GradeStats> | undefined {
	const result: Record<string, GradeStats> = {};
	for (const run of runs) {
		for (const [name, grade] of Object.entries(run.grades ?? {})) {
			const stats = (result[name] ??= { graded: 0, withFindings: 0, findings: 0, bySeverity: {} });
			if (grade.status !== 'ok') continue;
			stats.graded += 1;
			if (grade.findings.length > 0) stats.withFindings += 1;
			stats.findings += grade.findings.length;
			for (const finding of grade.findings) stats.bySeverity[finding.severity] = (stats.bySeverity[finding.severity] ?? 0) + 1;
		}
	}
	return Object.keys(result).length ? result : undefined;
}
