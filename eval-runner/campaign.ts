// Campaign: several specs (tasks) under several configs, with one budget, one reference config and a report.
// Usage: node eval-runner/campaign.ts <campaign.json> [--dry-run] [--no-grade] [--resume <campaignDir>] [--keep] [--claude <path>] [--codex <path>] [--opencode <path>] [--docker <path>] [--out <dir>]
// Exit codes: 0 done (or --help, or a dry run), 1 a run failed to start or an I/O error, 2 invalid file or arguments, 130 stopped by Ctrl-C.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { buildReport, renderReport } from './campaign-report.ts';
import type { Report } from './campaign-report.ts';
import { killLiveGroups, realExec } from './exec.ts';
import type { Exec } from './exec.ts';
import { gradeRuns } from './grade.ts';
import { prepareEval, runOne, saveEval, spentBy, startEval } from './run.ts';
import type { Options, Prepared } from './run.ts';
import { schedule } from './schedule.ts';
import type { Job } from './schedule.ts';
import { SpecError, loadSpec } from './spec.ts';
import type { Spec } from './spec.ts';
import { median } from './stats.ts';
import type { RunRecord } from './stats.ts';
import { changeNote, sourceStatus, treeWarning } from './workspace.ts';

const USAGE = `Usage: node eval-runner/campaign.ts <campaign.json> [--dry-run] [--no-grade] [--resume <campaignDir>] [--keep] [--claude <path>] [--codex <path>] [--opencode <path>] [--docker <path>] [--out <dir>]

  <campaign.json>  the campaign: the specs, the configs, the reference, the runs, the order and the budget
  --dry-run        validate the file and print the planned runs. Starts no agent and writes nothing.
  --no-grade       do not run the graders of the specs after the runs. eval-runner/grade.ts runs them later.
  --resume DIR     run again the runs of the campaign directory DIR that are missing or interrupted. The file is optional.
  --keep           keep the clone of every run
  --claude P       the claude executable (default: claude)
  --codex P        the codex executable (default: codex)
  --opencode P     the opencode executable (default: opencode)
  --docker P       the docker executable, for a config with container: true (default: docker)
  --out DIR        where the results go (default: eval-runner/out). The campaign goes in DIR/campaigns/<id>.

  Ctrl-C stops the campaign: queued runs never start, running runs are killed, and campaign.json is written.
  A second Ctrl-C exits at once. --resume then runs what is left.
`;

export type Campaign = {
	name: string;
	specs: { path: string; spec: Spec }[];
	// The configs of the campaign, in this order. Each spec keeps these configs only.
	configs: string[];
	reference: string;
	runs: number;
	order: 'interleaved' | 'grouped';
	concurrency: number;
	budget: { usd: number; gradersUsd?: number };
	retries: number;
	// The file as given, with the spec paths made absolute. campaign.json keeps it, so --resume needs no file.
	file: Record<string, unknown>;
};

const KNOWN = ['name', 'specs', 'configs', 'reference', 'runs', 'order', 'concurrency', 'budget', 'retries'];
const fail = (field: string, problem: string): never => {
	throw new SpecError(`${field}: ${problem}`);
};
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function integer(value: unknown, field: string, min: number, max: number): number {
	return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fail(field, `required integer from ${min} to ${max}`);
}
function text(value: unknown, field: string): string {
	return typeof value === 'string' && value !== '' ? value : fail(field, 'required string');
}

// `load` reads one spec. The tests give a fake one.
export function validateCampaign(raw: unknown, dir: string, load: (path: string) => Spec = loadSpec): Campaign {
	if (!isObject(raw)) return fail('campaign', 'required object');
	for (const key of Object.keys(raw)) if (!KNOWN.includes(key)) fail(`campaign.${key}`, 'unknown field');
	const name = text(raw.name, 'campaign.name');
	if (!/^[a-z0-9-]+$/.test(name)) fail('campaign.name', 'must match [a-z0-9-]+');
	if (!Array.isArray(raw.specs) || raw.specs.length === 0) fail('campaign.specs', 'required non-empty array of spec paths');
	const paths = (raw.specs as unknown[]).map((entry, index) => resolve(dir, text(entry, `campaign.specs[${index}]`)));
	if (new Set(paths).size !== paths.length) fail('campaign.specs', 'duplicate spec path');
	const reference = text(raw.reference, 'campaign.reference');
	const runs = integer(raw.runs, 'campaign.runs', 1, 20);
	const order = raw.order === undefined ? 'interleaved' : raw.order === 'interleaved' || raw.order === 'grouped' ? raw.order : fail('campaign.order', 'interleaved or grouped');
	const concurrency = raw.concurrency === undefined ? 1 : integer(raw.concurrency, 'campaign.concurrency', 1, 16);
	const retries = raw.retries === undefined ? 0 : integer(raw.retries, 'campaign.retries', 0, 5);
	if (!isObject(raw.budget)) return fail('campaign.budget', 'required object { usd, gradersUsd? }');
	for (const key of Object.keys(raw.budget)) if (!['usd', 'gradersUsd'].includes(key)) fail(`campaign.budget.${key}`, 'unknown field');
	const positive = (value: unknown, field: string) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fail(field, 'required number above 0'));
	const budget = { usd: positive(raw.budget.usd, 'campaign.budget.usd'), ...(raw.budget.gradersUsd === undefined ? {} : { gradersUsd: positive(raw.budget.gradersUsd, 'campaign.budget.gradersUsd') }) };

	const specs = paths.map((path) => ({ path, spec: load(path) }));
	const names = specs.map(({ spec }) => spec.name);
	if (new Set(names).size !== names.length) fail('campaign.specs', 'two specs have the same name: each name is the folder of its results');
	const namesOf = ({ spec }: { spec: Spec }) => spec.configs.map((config) => config.name);
	const common = namesOf(specs[0]).filter((config) => specs.every((entry) => namesOf(entry).includes(config)));
	let configs: string[];
	if (raw.configs === undefined) {
		// Without `configs`, a config that one spec has and another lacks is an error: it names the common ones to keep.
		for (const entry of specs) {
			const odd = namesOf(entry).filter((config) => !common.includes(config));
			if (odd.length > 0) fail('campaign.configs', `${entry.spec.name} has the config ${odd.join(', ')} that another spec lacks. List the common configs in campaign.configs: ${common.join(', ') || 'none'}`);
		}
		configs = common;
	} else {
		if (!Array.isArray(raw.configs)) return fail('campaign.configs', 'required array of config names');
		configs = (raw.configs as unknown[]).map((entry, index) => text(entry, `campaign.configs[${index}]`));
		if (new Set(configs).size !== configs.length) fail('campaign.configs', 'duplicate config name');
		for (const config of configs) {
			const lacking = specs.filter((entry) => !namesOf(entry).includes(config));
			if (lacking.length > 0) fail('campaign.configs', `the config ${config} is not in the spec ${lacking.map(({ spec }) => spec.name).join(', ')}`);
		}
	}
	if (!configs.includes(reference)) fail('campaign.reference', `${reference} is not one of the configs: ${configs.join(', ')}`);
	if (configs.length < 2) fail('campaign.configs', 'a campaign compares at least two configs');
	// Each spec keeps the campaign configs, in the order of the campaign, and the campaign sets its runs.
	for (const { spec } of specs) {
		spec.configs = configs.map((config) => spec.configs.find((entry) => entry.name === config)!);
		spec.runs = runs;
	}
	return { name, specs, configs, reference, runs, order, concurrency, budget, retries, file: { ...raw, specs: paths } };
}

export type PlannedJob = { key: string; spec: string; config: string; index: number; id: string };

// The runs of the campaign in the order in which they start. Interleaved: run by run, and inside a run spec by spec,
// then config by config, so a drift of the API or of the cache spreads over every config. Grouped: spec, config, run.
// `skip`: keys that already have a record (a resume).
export function planCampaign(specs: { name: string }[], configs: string[], runs: number, order: 'interleaved' | 'grouped', skip: Set<string> = new Set()): PlannedJob[] {
	const job = (spec: string, config: string, index: number): PlannedJob => ({ key: `${spec}/${config}-${index}`, spec, config, index, id: `${config}-${index}` });
	const all: PlannedJob[] = [];
	if (order === 'interleaved') {
		for (let index = 1; index <= runs; index++) for (const { name } of specs) for (const config of configs) all.push(job(name, config, index));
	} else {
		for (const { name } of specs) for (const config of configs) for (let index = 1; index <= runs; index++) all.push(job(name, config, index));
	}
	return all.filter((entry) => !skip.has(entry.key));
}

type CliOptions = { file?: string; resume?: string; dryRun: boolean; noGrade: boolean; keep: boolean; bin: Options['bin']; docker: string; out: string };

function parseArgs(argv: string[]): CliOptions | 'help' {
	const options: CliOptions = { dryRun: false, noGrade: false, keep: false, bin: { claude: 'claude', codex: 'codex', opencode: 'opencode' }, docker: 'docker', out: join(import.meta.dirname, 'out') };
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		const value = () => {
			const next = argv[++index];
			if (next === undefined) throw new SpecError(`${flag}: value required`);
			return next;
		};
		if (flag === '--help' || flag === '-h') return 'help';
		else if (flag === '--dry-run') options.dryRun = true;
		else if (flag === '--no-grade') options.noGrade = true;
		else if (flag === '--keep') options.keep = true;
		else if (flag === '--resume') options.resume = resolve(value());
		else if (flag === '--claude') options.bin.claude = value();
		else if (flag === '--codex') options.bin.codex = value();
		else if (flag === '--opencode') options.bin.opencode = value();
		else if (flag === '--docker') options.docker = value();
		else if (flag === '--out') options.out = resolve(value());
		else if (flag.startsWith('-')) throw new SpecError(`${flag}: unknown option`);
		else if (options.file) throw new SpecError(`${flag}: only one campaign file is allowed`);
		else options.file = flag;
	}
	if (!options.file && !options.resume) throw new SpecError('<campaign.json>: required');
	return options;
}

type Result = { spec: string; id: string; config: string; status: string; attempts: number; costUsd: number };
// What campaign.json holds.
type Saved = {
	schema: 'eval-runner/campaign/v1';
	id: string;
	name: string;
	generatedAt: string;
	status: 'running' | 'done' | 'interrupted';
	file: Record<string, unknown>;
	reference: string;
	configs: string[];
	order: Campaign['order'];
	runs: number;
	concurrency: number;
	retries: number;
	budget: Campaign['budget'];
	spent: number;
	gradersSpent: number;
	specs: { name: string; path: string; evalId: string; baseSha: string }[];
	results: Result[];
	report?: Report;
};

const dollars = (value: number) => Math.round(value * 100) / 100;
const stamp = (now = new Date()) => now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
const BUDGET_NOTE = 'the campaign budget would pass';

function readSaved(dir: string): Saved {
	const file = join(dir, 'campaign.json');
	let saved: Saved;
	try {
		saved = JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		throw new SpecError(`--resume: cannot read ${file}`);
	}
	if (saved.schema !== 'eval-runner/campaign/v1') throw new SpecError(`--resume: ${file} is no campaign`);
	return saved;
}

function writeCampaignIndex(out: string) {
	const root = join(out, 'campaigns');
	const campaigns = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const file = join(root, entry.name, 'campaign.json');
		if (!entry.isDirectory() || !existsSync(file)) continue;
		const saved = JSON.parse(readFileSync(file, 'utf8')) as Saved;
		campaigns.push({ id: saved.id, name: saved.name, generatedAt: saved.generatedAt, status: saved.status, specs: saved.specs.map((spec) => spec.name), configs: saved.configs, reference: saved.reference, runs: saved.results.length, cost: saved.spent });
	}
	campaigns.sort((a, b) => b.id.localeCompare(a.id));
	writeFileSync(join(root, 'index.json'), JSON.stringify({ schema: 'eval-runner/campaigns/v1', campaigns }));
}

export type Hooks = { signal?: AbortSignal; backoffMs?: number };

// One spec of the campaign while it runs.
type SpecState = { prepared: Prepared; runs: RunRecord[]; spent: number; costs: number[]; statusBefore: string };

export async function runCampaign(argv: string[], exec: Exec = realExec, { signal: outer, backoffMs = 5000 }: Hooks = {}): Promise<number> {
	let cli: CliOptions | 'help';
	let campaign: Campaign;
	let previous: Saved | undefined;
	try {
		cli = parseArgs(argv);
		if (cli === 'help') {
			console.log(USAGE);
			return 0;
		}
		previous = cli.resume ? readSaved(cli.resume) : undefined;
		let raw: unknown;
		if (cli.file) {
			try {
				raw = JSON.parse(readFileSync(cli.file, 'utf8'));
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				throw new SpecError(`${cli.file}: ${code ? `cannot read the file (${code})` : 'not valid JSON'}`);
			}
		} else raw = previous!.file;
		campaign = validateCampaign(raw, cli.file ? dirname(resolve(cli.file)) : cli.resume!);
		if (previous) {
			if (previous.name !== campaign.name) throw new SpecError(`--resume: the campaign is ${previous.name}, the file is ${campaign.name}`);
			if (previous.specs.map((spec) => spec.name).join() !== campaign.specs.map(({ spec }) => spec.name).join()) throw new SpecError('--resume: the specs of the file are not the specs of the campaign');
		}
	} catch (error) {
		if (!(error instanceof SpecError)) throw error;
		console.error(`${error.message}\n\n${USAGE}`);
		return error.exitCode;
	}

	const campaignId = previous?.id ?? `${stamp()}-${campaign.name}`;
	const campaignsDir = join(cli.out, 'campaigns');
	const campaignDir = cli.resume ?? join(campaignsDir, campaignId);
	// A campaign never reads or writes the run cache: a reused run would break the order and the counts.
	const options: Options = { specPath: '', dryRun: cli.dryRun, keep: cli.keep, noCache: true, noGrade: cli.noGrade, bin: cli.bin, docker: cli.docker, out: cli.out };

	const states = new Map<string, SpecState>();
	for (const [position, { spec }] of campaign.specs.entries()) {
		const evalId = `${campaignId}-${spec.name}`;
		const prepared = await prepareEval(exec, spec, options, { evalId, evalDir: join(campaignDir, spec.name), baseSha: previous?.specs[position].baseSha, cache: false });
		if ('code' in prepared) return prepared.code;
		// Records of an earlier start stay, except the interrupted ones: those run again.
		let runs: RunRecord[] = [];
		if (previous) {
			try {
				runs = (JSON.parse(readFileSync(join(prepared.evalDir, 'eval.json'), 'utf8')).runs as RunRecord[]).filter((run) => run.status !== 'interrupted');
			} catch {
				runs = [];
			}
		}
		states.set(spec.name, { prepared, runs, spent: 0, costs: [], statusBefore: '' });
	}
	const specsOf = campaign.specs.map(({ spec }) => spec);
	const have = new Set([...states.entries()].flatMap(([name, state]) => state.runs.map((run) => `${name}/${run.id}`)));
	const planned = planCampaign(specsOf, campaign.configs, campaign.runs, campaign.order, have);
	const allKeys = planCampaign(specsOf, campaign.configs, campaign.runs, campaign.order);
	const perRun = (name: string) => states.get(name)!.prepared.spec.budget.perRunUsd;
	const spentBefore = previous?.spent ?? 0;
	const maxSpend = Math.min(planned.reduce((sum, job) => sum + perRun(job.spec), 0), campaign.budget.usd - spentBefore);

	console.log(`Campaign ${campaignId}: ${planned.length} runs (${specsOf.length} specs x ${campaign.configs.length} configs x ${campaign.runs}, order ${campaign.order}, concurrency ${campaign.concurrency}${previous ? `, ${have.size} already done` : ''})`);
	console.log(`Reference: ${campaign.reference}`);
	for (const [position, job] of planned.entries()) console.log(`[${position + 1}] ${job.spec} ${job.id}`);
	console.log(`Maximum spend: ${dollars(maxSpend)} $ (budget ${campaign.budget.usd} $${previous ? `, ${dollars(spentBefore)} $ spent` : ''}, per run ${[...new Set(specsOf.map((spec) => spec.budget.perRunUsd))].join(' or ')} $)`);
	if (cli.dryRun) return 0;

	// Ctrl-C reaches the scheduler through this signal. An error of the working tree aborts through it too.
	const controller = new AbortController();
	if (outer?.aborted) controller.abort();
	outer?.addEventListener('abort', () => controller.abort(), { once: true });
	let fatal = false;
	let anyFailed = false;

	for (const state of states.values()) {
		state.statusBefore = await sourceStatus(exec, state.prepared.spec.task.repo);
		await startEval(exec, state.prepared);
		state.spent = previous ? (readEvalSpent(state.prepared.evalDir) ?? 0) : 0;
		state.costs = state.runs.map((run) => run.cliCostUsd).filter((value): value is number => typeof value === 'number');
	}
	mkdirSync(campaignDir, { recursive: true });
	const attempts = new Map<string, { attempts: number; costUsd: number }>(previous?.results.map((result) => [`${result.spec}/${result.id}`, { attempts: result.attempts, costUsd: result.costUsd }]));
	let gradersSpent = previous?.gradersSpent ?? 0;
	const totalSpent = () => [...states.values()].reduce((sum, state) => sum + state.spent, 0);
	let report: Report | undefined;

	const resultOf = (key: string): Result => {
		const [spec, id] = key.split('/');
		const record = states.get(spec)!.runs.find((run) => run.id === id);
		const status = !record ? 'pending' : record.status === 'skipped' && record.note === BUDGET_NOTE ? 'budget' : record.status;
		const known = attempts.get(key);
		return { spec, id, config: id.replace(/-\d+$/, ''), status, attempts: known?.attempts ?? 0, costUsd: dollars(known?.costUsd ?? 0) };
	};
	const writeCampaign = (status: Saved['status']) => {
		const saved: Saved = {
			schema: 'eval-runner/campaign/v1',
			id: campaignId,
			name: campaign.name,
			generatedAt: new Date().toISOString(),
			status,
			file: campaign.file,
			reference: campaign.reference,
			configs: campaign.configs,
			order: campaign.order,
			runs: campaign.runs,
			concurrency: campaign.concurrency,
			retries: campaign.retries,
			budget: campaign.budget,
			spent: dollars(totalSpent()),
			gradersSpent: dollars(gradersSpent),
			specs: [...states.entries()].map(([name, state], position) => ({ name, path: campaign.specs[position].path, evalId: state.prepared.evalId, baseSha: state.prepared.baseSha })),
			results: allKeys.map((job) => resultOf(job.key)),
			...(report ? { report } : {})
		};
		writeFileSync(join(campaignDir, 'campaign.json'), JSON.stringify(saved));
		writeCampaignIndex(cli.out);
	};
	const upsert = (state: SpecState, record: RunRecord) => {
		const at = state.runs.findIndex((run) => run.id === record.id);
		if (at === -1) state.runs.push(record);
		else state.runs[at] = record;
	};
	const save = (name: string) => {
		const state = states.get(name)!;
		saveEval(state.prepared, state.runs, state.spent);
	};
	for (const name of states.keys()) save(name);
	writeCampaign('running');

	// The reservation of a run: the median cost of the runs of its spec that finished, or the cap of the run.
	const estimate = (name: string) => {
		const { costs } = states.get(name)!;
		return costs.length > 0 ? Math.max(median(costs), 0.01) : perRun(name);
	};
	let finished = 0;
	const jobs: Job[] = planned.map((job) => ({
		id: job.key,
		estimateUsd: () => estimate(job.spec),
		run: async (signal) => {
			const state = states.get(job.spec)!;
			const { prepared } = state;
			const config = prepared.spec.configs.find((entry) => entry.name === job.config)!;
			const known = attempts.get(job.key) ?? { attempts: 0, costUsd: 0 };
			attempts.set(job.key, known);
			if (prepared.editErrors[job.config]) {
				upsert(state, { id: job.id, config: job.config, status: 'error', note: prepared.editErrors[job.config] });
				anyFailed = true;
				known.attempts += 1;
				save(job.spec);
				console.log(`${job.spec} ${job.id} error: ${prepared.editErrors[job.config]}`);
				return { costUsd: 0 };
			}
			const context = { exec, spec: prepared.spec, options, baseSha: prepared.baseSha, evalId: prepared.evalId, evalDir: prepared.evalDir, image: prepared.image, opencodeVersion: prepared.versions.opencode, signal };
			const { record, failed, transient } = await runOne(context, { id: job.id, config, index: job.index });
			// An agent that writes outside its clone could write anywhere. The campaign stops at the first sign.
			const statusNow = record.status === 'interrupted' ? state.statusBefore : await sourceStatus(exec, prepared.spec.task.repo);
			if (statusNow !== state.statusBefore) {
				record.status = 'error';
				const change = changeNote(state.statusBefore, statusNow);
				record.note = `the agent changed the working tree of ${prepared.spec.task.repo} (${change})${record.note ? `; ${record.note}` : ''}`.slice(0, 300);
				console.error(`${job.spec} ${job.id}: the agent changed the working tree of ${prepared.spec.task.repo} (${change}). The campaign stops. Check \`git status\` there.`);
				fatal = true;
				controller.abort();
			}
			const costUsd = record.status === 'interrupted' ? 0 : spentBy(record, prepared.spec.budget.perRunUsd);
			known.attempts += 1;
			known.costUsd += costUsd;
			state.spent += costUsd;
			if (typeof record.cliCostUsd === 'number') state.costs.push(record.cliCostUsd);
			anyFailed ||= failed;
			upsert(state, record);
			save(job.spec);
			writeCampaign('running');
			finished += 1;
			console.log(`[${finished}/${planned.length}] ${job.spec} ${job.id} ${record.status}${transient ? ' (transient)' : ''}, check ${record.acceptance?.passed ? 'passed' : 'failed'}, ${record.metrics?.cost ?? '?'} $, ${record.wallSec ?? '?'} s`);
			return { costUsd, transient: transient && !fatal, interrupted: record.status === 'interrupted' };
		}
	}));

	const results = await schedule(jobs, { concurrency: campaign.concurrency, budgetUsd: campaign.budget.usd - spentBefore, retries: campaign.retries, backoffMs, signal: controller.signal });
	// A run that never started has no record yet. The eval keeps it, so a reader sees what the campaign planned.
	for (const [position, result] of results.entries()) {
		const job = planned[position];
		const state = states.get(job.spec)!;
		if (result.attempts > 0 || state.runs.some((run) => run.id === job.id)) continue;
		if (result.status === 'budget') upsert(state, { id: job.id, config: job.config, status: 'skipped', note: BUDGET_NOTE });
		else upsert(state, { id: job.id, config: job.config, status: 'interrupted', note: 'interrupted before the start' });
	}
	const budgetStopped = results.filter((result) => result.status === 'budget').length;
	if (budgetStopped > 0) console.log(`${budgetStopped} runs not started: ${BUDGET_NOTE}.`);
	for (const name of states.keys()) save(name);
	const interrupted = controller.signal.aborted;

	// One status per repo, taken after the runs: a change after it comes from the graders.
	const repos = [...new Set([...states.values()].map((state) => state.prepared.spec.task.repo))];
	const firstOf = (repo: string) => [...states.values()].find((state) => state.prepared.spec.task.repo === repo)!;
	const afterRuns = new Map<string, string>();
	for (const repo of repos) afterRuns.set(repo, await sourceStatus(exec, repo));
	// The graders come after the runs and share one budget. An interrupted campaign skips them: eval-runner/grade.ts runs them later.
	if (!interrupted && !cli.noGrade) {
		const guarded: Exec = (command, args, execOptions) => exec(command, args, { ...execOptions, signal: controller.signal });
		for (const state of states.values()) {
			const { prepared } = state;
			if (!prepared.spec.graders) continue;
			const left = campaign.budget.gradersUsd === undefined ? prepared.spec.budget.gradersUsd : Math.max(0, campaign.budget.gradersUsd - gradersSpent);
			const spec = { ...prepared.spec, budget: { ...prepared.spec.budget, ...(left === undefined ? {} : { gradersUsd: left }) } };
			const { spentUsd } = await gradeRuns({ evalId: prepared.evalId, evalDir: prepared.evalDir, baseSha: prepared.baseSha, spec, runs: state.runs }, { exec: guarded });
			gradersSpent += spentUsd;
			saveEval(prepared, state.runs, state.spent);
		}
	}

	try {
		report = buildReport([...states.values()].map((state) => ({ name: state.prepared.spec.name, runs: state.runs })), { reference: campaign.reference });
		console.log(`\n${renderReport(report)}`);
	} catch (error) {
		console.log(`No report: ${(error as Error).message}`);
	}
	writeCampaign(interrupted ? 'interrupted' : 'done');
	for (const state of states.values()) {
		try {
			rmdirSync(join(tmpdir(), 'eval-runner', state.prepared.evalId));
		} catch {
			// Kept clones, or already gone.
		}
	}
	// One warning per repo, not per spec.
	for (const repo of repos) {
		const warning = treeWarning(repo, { before: firstOf(repo).statusBefore, afterRuns: afterRuns.get(repo)!, final: await sourceStatus(exec, repo) });
		if (warning) console.error(warning);
	}
	console.log(`Spent ${dollars(totalSpent())} $${gradersSpent > 0 ? `, graders ${dollars(gradersSpent)} $` : ''}. Results in ${campaignDir}`);
	if (interrupted && !fatal) console.log(`Interrupted. Run again with: --resume ${campaignDir}`);
	return fatal ? 1 : interrupted ? 130 : anyFailed ? 1 : 0;
}

function readEvalSpent(evalDir: string): number | undefined {
	try {
		return JSON.parse(readFileSync(join(evalDir, 'eval.json'), 'utf8')).spent;
	} catch {
		return undefined;
	}
}

if (import.meta.main) {
	const controller = new AbortController();
	let presses = 0;
	const onSignal = () => {
		presses += 1;
		if (presses === 1) {
			console.error('\nStopping: queued runs do not start, running runs are killed. Press Ctrl-C again to exit at once.');
			controller.abort();
		} else {
			// The agents run detached, so they would outlive the runner.
			killLiveGroups();
			process.exit(130);
		}
	};
	process.on('SIGINT', onSignal);
	process.on('SIGTERM', onSignal);
	process.exitCode = await runCampaign(process.argv.slice(2), realExec, { signal: controller.signal });
}
