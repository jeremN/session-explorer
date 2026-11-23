// Routing table: for each task category, the pass rate and the cost of each route (agent and model), over every eval
// in the output folder. It proposes a route per category and flags the tasks that tell no route from another.
// It never edits ~/.claude/model-matrix.md: it prints what the numbers say next to what the matrix says.
// Usage: node eval-runner/matrix.ts [--out <dir>] [--exclude <evalId or evalId/runId>[,...]] [--model-matrix <path>]
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import type { Config } from './spec.ts';
import { median } from './stats.ts';
import type { RunRecord } from './stats.ts';

export type SavedEval = { id: string; baseSha: string; spec: { name: string; task: { prompt?: string; category?: string; acceptance: { command: string } }; configs: Config[] }; runs: RunRecord[] };
// testShare: the share of tests passed, over the runs whose check counted its tests: the mean per task, then the mean
// of the tasks, so a task with 54 tests weighs as much as a task with 21. It tells a near miss (19 tests of 21) from a
// run that missed the task (10 of 21), where the pass rate sees two failures.
export type RouteStats = { route: string; passed: number; n: number; cost?: number; wallSec?: number; testShare?: number; tasks: number };
export type TaskRow = { key: string; name: string; category: string; routes: Record<string, { passed: number; n: number }>; discriminating: boolean };
export type Proposal = { route: string; reason: string } | { route: null; reason: string };
export type CategoryRow = { category: string; routes: RouteStats[]; tasks: number; discriminating: number; proposal: Proposal; matrix?: string };

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const meanOfTasks = (shares: Map<string, number[]>) => Math.round(mean([...shares.values()].map(mean)) * 10_000) / 10_000;

// A route needs this many runs in a category before it can be proposed.
export const MIN_RUNS = 3;
// These fields change what the agent is told. Such a config is an experiment on the instructions, not a route.
const EXPERIMENT_FIELDS = ['claudeMd', 'appendSystemPrompt', 'skills', 'plugins'] as const;

// The effort is part of the route: sonnet at high effort is another route than sonnet at the default effort.
export const routeOf = (config: Config) => `${config.agent ?? 'claude'}/${config.model ?? 'default'}${config.effort ? `@${config.effort}` : ''}`;
const taskKey = (ev: SavedEval) => createHash('sha256').update(`${ev.baseSha}\0${ev.spec.task.prompt ?? ''}\0${ev.spec.task.acceptance.command}`).digest('hex').slice(0, 12);

// What a run says about its route. An error with no billed token is a failure of the runner or of the CLI start: the
// agent never worked, so the run is left out. An error after the agent worked (it stopped partway) is a failure of the
// agent. A timeout is a failure even when the check passes on what the agent left.
export function verdictOf(run: RunRecord): 'out' | 'pass' | 'fail' {
	if (run.status === 'skipped') return 'out';
	if (run.status === 'error') return (run.metrics?.billedTokens ?? 0) > 0 ? 'fail' : 'out';
	if (run.status === 'timeout') return 'fail';
	// The check failed before it judged the agent: the run says nothing about it.
	if (run.acceptance?.infra) return 'out';
	return run.acceptance?.passed ? 'pass' : 'fail';
}

// `excluded` holds run ids as evalId/runId: runs known to be wrong, for example from a bug of the runner.
export function buildMatrix(evals: SavedEval[], matrixRoutes: Record<string, string> = {}, excluded: ReadonlySet<string> = new Set()) {
	const seen = new Set<string>(excluded);
	const tasks = new Map<string, TaskRow>();
	// Runs per category and route, for the medians.
	const samples = new Map<string, { passed: number; n: number; costs: number[]; walls: number[]; shares: Map<string, number[]>; tasks: Set<string> }>();
	let errors = 0;
	let infra = 0;
	let experiments = 0;
	for (const ev of [...evals].sort((a, b) => a.id.localeCompare(b.id))) {
		const key = taskKey(ev);
		const task = tasks.get(key) ?? { key, name: ev.spec.name, category: 'uncategorized', routes: {}, discriminating: false };
		// The newest spec that names a category wins.
		if (ev.spec.task.category) task.category = ev.spec.task.category;
		tasks.set(key, task);
		for (const run of ev.runs) {
			// A cached run appears again in each eval that reuses it.
			const id = run.cached ? `${run.cached.evalId}/${run.cached.id}` : `${ev.id}/${run.id}`;
			if (seen.has(id) || run.status === 'skipped') continue;
			seen.add(id);
			const config = ev.spec.configs.find((entry) => entry.name === run.config);
			if (!config) continue;
			if (EXPERIMENT_FIELDS.some((field) => config[field] !== undefined)) {
				experiments++;
				continue;
			}
			const verdict = verdictOf(run);
			if (verdict === 'out') {
				if (run.acceptance?.infra) infra++;
				else errors++;
				continue;
			}
			const route = routeOf(config);
			const cell = (task.routes[route] ??= { passed: 0, n: 0 });
			cell.n++;
			if (verdict === 'pass') cell.passed++;
		}
	}
	// Second pass, once every task has its final category.
	seen.clear();
	for (const id of excluded) seen.add(id);
	for (const ev of evals) {
		const task = tasks.get(taskKey(ev))!;
		for (const run of ev.runs) {
			const id = run.cached ? `${run.cached.evalId}/${run.cached.id}` : `${ev.id}/${run.id}`;
			const config = ev.spec.configs.find((entry) => entry.name === run.config);
			const verdict = verdictOf(run);
			if (seen.has(id) || verdict === 'out' || !config || EXPERIMENT_FIELDS.some((field) => config[field] !== undefined)) continue;
			seen.add(id);
			const slot = `${task.category}\0${routeOf(config)}`;
			const sample = samples.get(slot) ?? { passed: 0, n: 0, costs: [], walls: [], shares: new Map(), tasks: new Set() };
			sample.n++;
			if (verdict === 'pass') sample.passed++;
			if (typeof run.metrics?.cost === 'number') sample.costs.push(run.metrics.cost);
			if (typeof run.wallSec === 'number') sample.walls.push(run.wallSec);
			const tests = run.acceptance?.tests;
			if (tests) sample.shares.set(task.key, [...(sample.shares.get(task.key) ?? []), tests.passed / tests.total]);
			sample.tasks.add(task.key);
			samples.set(slot, sample);
		}
	}
	// A task tells routes apart only when two routes ran it and they do not all pass or all fail.
	for (const task of tasks.values()) {
		const rates = Object.values(task.routes).map((cell) => cell.passed / cell.n);
		task.discriminating = rates.length >= 2 && !rates.every((rate) => rate === 1) && !rates.every((rate) => rate === 0);
	}

	const categories = [...new Set([...tasks.values()].map((task) => task.category))].sort();
	const rows: CategoryRow[] = categories.map((category) => {
		const routes = [...samples.entries()]
			.filter(([slot]) => slot.startsWith(`${category}\0`))
			.map(([slot, sample]) => ({
				route: slot.slice(category.length + 1),
				passed: sample.passed,
				n: sample.n,
				...(sample.costs.length ? { cost: median(sample.costs) } : {}),
				...(sample.walls.length ? { wallSec: median(sample.walls) } : {}),
				...(sample.shares.size ? { testShare: meanOfTasks(sample.shares) } : {}),
				tasks: sample.tasks.size
			}))
			.sort((a, b) => b.passed / b.n - a.passed / a.n || (a.cost ?? Infinity) - (b.cost ?? Infinity));
		const own = [...tasks.values()].filter((task) => task.category === category);
		const discriminating = own.filter((task) => task.discriminating).length;
		return { category, routes, tasks: own.length, discriminating, proposal: propose(routes, discriminating), ...(matrixRoutes[category] ? { matrix: matrixRoutes[category] } : {}) };
	});
	return { categories: rows, tasks: [...tasks.values()], excluded: { errors, infra, experiments } };
}

// The route of a category: the cheapest route whose pass rate is within one run of the best.
export function propose(routes: RouteStats[], discriminating: number): Proposal {
	const ready = routes.filter((route) => route.n >= MIN_RUNS);
	if (ready.length === 0) return { route: null, reason: `no route has ${MIN_RUNS} runs yet` };
	const best = Math.max(...ready.map((route) => route.passed / route.n));
	// Within one run of the best rate: a smaller gap is inside the noise of so few runs.
	// Compare in runs, not in rates: 2/3 is one run from 3/3, but 2 / 3 < 1 - 1 / 3 in floating point.
	const close = ready.filter((route) => route.passed + 1 >= best * route.n - 1e-9);
	const pick = [...close].sort((a, b) => (a.cost ?? Infinity) - (b.cost ?? Infinity))[0];
	const caveat = discriminating === 0 ? '; no task of this category tells the routes apart, so the cost decides alone' : '';
	return { route: pick.route, reason: `cheapest route within one run of the best pass rate (${Math.round(best * 100)} %)${caveat}` };
}

// The Claude model of each class in ~/.claude/model-matrix.md: rows like "| fast | ... | `haiku` | ... |".
export function readMatrixRoutes(text: string): Record<string, string> {
	const routes: Record<string, string> = {};
	for (const line of text.split('\n')) {
		const cells = line.split('|').map((cell) => cell.trim());
		const model = /^`([^`]+)`$/.exec(cells[3] ?? '');
		if (/^[a-z]+$/.test(cells[1] ?? '') && model) routes[cells[1]] = `claude/${model[1]}`;
	}
	return routes;
}

export function renderMarkdown(matrix: ReturnType<typeof buildMatrix>) {
	const money = (value?: number) => (value === undefined ? '—' : value < 0.01 ? value.toFixed(4) : value.toFixed(2));
	const lines = ['# Routing table', ''];
	for (const row of matrix.categories) {
		lines.push(`## ${row.category}`, '', `${row.tasks} task(s), ${row.discriminating} that tell the routes apart.`, '');
		lines.push('| Route | Pass | Tests passed (mean per task) | Median cost ($) | Median time (s) | Tasks |', '|---|---|---|---|---|---|');
		for (const route of row.routes) lines.push(`| ${route.route} | ${route.passed}/${route.n} | ${route.testShare === undefined ? '—' : `${Math.round(route.testShare * 100)} %`} | ${money(route.cost)} | ${route.wallSec ?? '—'} | ${route.tasks} |`);
		lines.push('', `Proposal: ${row.proposal.route ?? 'none'}. ${row.proposal.reason}.`);
		if (row.matrix) lines.push(`The model matrix routes this class to ${row.matrix}.`);
		lines.push('');
	}
	const flat = matrix.tasks.filter((task) => !task.discriminating && Object.keys(task.routes).length >= 2);
	if (flat.length) lines.push('## Tasks that tell no route apart', '', ...flat.map((task) => `- ${task.name} (${task.category}): ${Object.entries(task.routes).map(([route, cell]) => `${route} ${cell.passed}/${cell.n}`).join(', ')}`), '');
	lines.push(`Left out: ${matrix.excluded.errors} run(s) where the agent never worked (status error, no billed token), ${matrix.excluded.infra} run(s) whose check failed before it judged the agent, ${matrix.excluded.experiments} run(s) of configs that change the instructions.`);
	return `${lines.join('\n')}\n`;
}

export function main(argv: string[]) {
	let out = join(import.meta.dirname, 'out');
	let exclude: string[] = [];
	let matrixPath = join(homedir(), '.claude', 'model-matrix.md');
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		if (flag === '--out') out = resolve(argv[++index]);
		else if (flag === '--exclude') exclude = argv[++index].split(',');
		else if (flag === '--model-matrix') matrixPath = resolve(argv[++index]);
		else {
			console.error(`${flag}: unknown option\n\nUsage: node eval-runner/matrix.ts [--out <dir>] [--exclude <evalId or evalId/runId>[,...]] [--model-matrix <path>]`);
			return 2;
		}
	}
	const evals = existsSync(out)
		? readdirSync(out)
				.filter((name) => !exclude.includes(name) && existsSync(join(out, name, 'eval.json')))
				.map((name) => JSON.parse(readFileSync(join(out, name, 'eval.json'), 'utf8')) as SavedEval)
		: [];
	const matrix = buildMatrix(evals, existsSync(matrixPath) ? readMatrixRoutes(readFileSync(matrixPath, 'utf8')) : {}, new Set(exclude.filter((id) => id.includes('/'))));
	const markdown = renderMarkdown(matrix);
	writeFileSync(join(out, 'matrix.json'), JSON.stringify(matrix, null, '\t'));
	writeFileSync(join(out, 'matrix.md'), markdown);
	console.log(markdown);
	return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
