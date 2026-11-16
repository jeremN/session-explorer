// Aggregates over the runs of one configuration. Pure functions, no file access.
export type Status = 'ok' | 'timeout' | 'budget' | 'error' | 'skipped';
export type RunMetrics = {
	cost: number;
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
	acceptance?: { exitCode: number | null; passed: boolean; timedOut: boolean; durationMs: number };
	wallSec?: number;
	cliCostUsd?: number | null;
	diff?: { files: number; added: number; deleted: number };
	metrics?: RunMetrics;
	mrs?: string[];
	note?: string;
};
export type Spread = { n: number; median: number; min: number; max: number; values: number[] };
export type ConfigStats = { pass: { passed: number; n: number }; metrics: Record<string, Spread> };

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
		result[name] = { pass: passRate(own), metrics };
	}
	return result;
}
