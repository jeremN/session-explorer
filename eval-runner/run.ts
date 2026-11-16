// Eval runner: runs one task under several Claude Code configurations, N times each, and scores every run.
// Usage: node eval-runner/run.ts <spec.json> [--dry-run] [--runs N] [--only <config>[,<config>]] [--keep] [--no-cache] [--claude <path>] [--out <dir>]
// Exit codes: 0 done (or --help, or a dry run), 1 a run failed to start or an I/O error, 2 invalid spec or arguments.
import { randomUUID } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { cacheKey, readCache, writeCache } from './cache.ts';
import { buildCommand, setupFiles } from './command.ts';
import { realExec } from './exec.ts';
import type { Exec } from './exec.ts';
import { scoreFiles } from './score.ts';
import { SpecError, loadSpec } from './spec.ts';
import type { Config, Spec } from './spec.ts';
import { aggregate } from './stats.ts';
import type { RunRecord, Status } from './stats.ts';
import { collectDiff, createWorkspace, placeHiddenTests, removeWorkspace, resolveBase, sourceStatus } from './workspace.ts';

const USAGE = `Usage: node eval-runner/run.ts <spec.json> [--dry-run] [--runs N] [--only <config>[,<config>]] [--keep] [--no-cache] [--claude <path>] [--out <dir>]

  <spec.json>   the eval spec: one task, the configurations, the run count
  --dry-run     validate the spec and print the planned runs. Starts no agent and writes nothing.
  --runs N      run each configuration N times (1 to 20). Overrides the spec.
  --only a,b    run only these configurations
  --keep        keep the clone of every run
  --no-cache    run every run, even when a finished run with the same task, config and CLI version exists
  --claude P    the claude executable (default: claude)
  --out DIR     where the results go (default: eval-runner/out)
`;

type Options = { specPath: string; dryRun: boolean; runs?: number; only?: string[]; keep: boolean; noCache: boolean; claude: string; out: string };

function parseArgs(argv: string[]): Options | 'help' {
	const options: Options = { specPath: '', dryRun: false, keep: false, noCache: false, claude: 'claude', out: join(import.meta.dirname, 'out') };
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		const value = () => {
			const next = argv[++index];
			if (next === undefined) throw new SpecError(`${flag}: value required`);
			return next;
		};
		if (flag === '--help' || flag === '-h') return 'help';
		else if (flag === '--dry-run') options.dryRun = true;
		else if (flag === '--keep') options.keep = true;
		else if (flag === '--no-cache') options.noCache = true;
		else if (flag === '--runs') {
			options.runs = Number(value());
			if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 20) throw new SpecError('--runs: required integer from 1 to 20');
		} else if (flag === '--only') options.only = value().split(',');
		else if (flag === '--claude') options.claude = value();
		else if (flag === '--out') options.out = resolve(value());
		else if (flag.startsWith('-')) throw new SpecError(`${flag}: unknown option`);
		else if (options.specPath) throw new SpecError(`${flag}: only one spec file is allowed`);
		else options.specPath = flag;
	}
	if (!options.specPath) throw new SpecError('<spec.json>: required');
	return options;
}

type Planned = { id: string; config: Config; index: number };

// Round-robin: a stop on budget leaves balanced samples, and a drift over time spreads over every configuration.
// `have` counts the cached runs of a config: its new runs start after them.
export function planRuns(configs: Config[], runs: number, have: Record<string, number> = {}): Planned[] {
	return Array.from({ length: runs }, (_, index) => configs.filter((config) => index >= (have[config.name] ?? 0)).map((config) => ({ id: `${config.name}-${index + 1}`, config, index: index + 1 }))).flat();
}

const evalIdOf = (name: string, now = new Date()) => `${now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}-${name}`;
const dollars = (value: number) => Math.round(value * 100) / 100;
const projectsDir = () => process.env.EVAL_RUNNER_PROJECTS_DIR ?? join(homedir(), '.claude', 'projects');

// The runner sets the session id itself, so it finds the transcript by that name in any project folder.
function findTranscript(sessionId: string) {
	for (const folder of readdirSync(projectsDir(), { withFileTypes: true })) {
		const file = join(projectsDir(), folder.name, `${sessionId}.jsonl`);
		if (folder.isDirectory() && existsSync(file)) return file;
	}
	return undefined;
}

type RunContext = { exec: Exec; spec: Spec; options: Options; baseSha: string; evalId: string; evalDir: string };
type RunOutcome = { record: RunRecord; failed: boolean };

async function runOne({ exec, spec, options, baseSha, evalId, evalDir }: RunContext, planned: Planned): Promise<RunOutcome> {
	const sessionId = randomUUID();
	const runDir = join(evalDir, 'runs', planned.id);
	const clone = join(tmpdir(), 'eval-runner', evalId, planned.id);
	// The runner copy of the git dir. Its path is random and the agent never gets it: not in the argv, the env, the cwd
	// or a generated file.
	let gitDir: string | undefined;
	mkdirSync(runDir, { recursive: true });
	const record: RunRecord = { id: planned.id, config: planned.config.name, status: 'error', sessionId };
	let failed = false;
	try {
		gitDir = mkdtempSync(join(tmpdir(), 'eval-runner-git-'));
		chmodSync(gitDir, 0o700);
		const { setupSha, fileMode } = await createWorkspace(exec, { repo: spec.task.repo, baseSha, dir: clone, gitDir, setup: setupFiles(planned.config) });
		const { args, files, env } = buildCommand(planned.config, { sessionId, perRunUsd: spec.budget.perRunUsd, runDir });
		for (const file of files) writeFileSync(file.path, file.content);

		const started = Date.now();
		const agent = await exec(options.claude, args, { cwd: clone, input: spec.task.prompt, env, timeoutMs: spec.task.timeoutSec * 1000 });
		record.wallSec = Math.round((Date.now() - started) / 100) / 10;
		writeFileSync(join(runDir, 'claude.json'), agent.stdout);
		let result: { is_error?: boolean; subtype?: string; total_cost_usd?: number } | undefined;
		try {
			result = JSON.parse(agent.stdout);
		} catch {
			// A killed process prints no result.
		}
		record.cliCostUsd = typeof result?.total_cost_usd === 'number' ? result.total_cost_usd : null;
		const status: Status = agent.timedOut ? 'timeout' : result?.is_error && /budget/.test(result.subtype ?? '') ? 'budget' : agent.code !== 0 || result?.is_error ? 'error' : 'ok';
		record.status = status;
		if (status === 'error') record.note = (agent.stderr.trim() || `exit code ${agent.code}`).slice(0, 300);

		const transcript = findTranscript(sessionId);
		const scored = transcript && scoreFiles(transcript, sessionId);
		if (transcript) {
			cpSync(transcript, join(runDir, 'transcript.jsonl'));
			const subagents = join(transcript.slice(0, -'.jsonl'.length), 'subagents');
			if (existsSync(subagents)) cpSync(subagents, join(runDir, 'subagents'), { recursive: true });
		}
		if (scored) {
			writeFileSync(join(runDir, 'session.json'), JSON.stringify(scored.session));
			record.metrics = scored.metrics;
			record.mrs = scored.mrs;
			if (scored.mrs.length > 0) console.error(`${planned.id}: the agent created ${scored.mrs.length} merge request(s). The clone has no remote, so check the run.`);
		} else {
			record.note = `${record.note ? `${record.note}; ` : ''}no transcript found for session ${sessionId}`;
			record.status = 'error';
			failed = true;
		}

		// The diff is taken before the acceptance command, which can write files too.
		const { patch, ...diff } = await collectDiff(exec, clone, setupSha, gitDir, fileMode);
		await removeWorkspace(gitDir);
		writeFileSync(join(runDir, 'diff.patch'), patch);
		record.diff = diff;

		// The hidden tests enter after the diff, so they never count as agent work.
		const hidden = spec.task.hiddenTests;
		if (hidden) await placeHiddenTests(exec, { repo: spec.task.repo, commit: hidden.commit, paths: hidden.paths, dir: clone });

		const checkStarted = Date.now();
		const check = await exec('sh', ['-c', spec.task.acceptance.command], { cwd: clone, env: { EVAL_SPEC_DIR: spec.dir }, timeoutMs: spec.task.acceptance.timeoutSec * 1000 });
		writeFileSync(join(runDir, 'acceptance.log'), (check.stdout + check.stderr).slice(-64 * 1024));
		record.acceptance = { exitCode: check.code, passed: check.code === 0 && !check.timedOut, timedOut: check.timedOut, durationMs: Date.now() - checkStarted };
	} catch (error) {
		record.status = 'error';
		record.note = (error as Error).message.slice(0, 300);
		console.error(`${planned.id}: ${record.note}`);
		failed = true;
	} finally {
		if (gitDir) await removeWorkspace(gitDir);
		if (!options.keep) await removeWorkspace(clone);
	}
	return { record, failed };
}

function writeIndex(out: string) {
	const evals = [];
	for (const entry of readdirSync(out, { withFileTypes: true })) {
		const file = join(out, entry.name, 'eval.json');
		if (!entry.isDirectory() || !existsSync(file)) continue;
		const saved = JSON.parse(readFileSync(file, 'utf8'));
		evals.push({ id: saved.id, name: saved.name, generatedAt: saved.generatedAt, configs: saved.configs.map((config: { name: string }) => config.name), runs: saved.runs.length, cost: saved.spent });
	}
	evals.sort((a, b) => b.id.localeCompare(a.id));
	writeFileSync(join(out, 'index.json'), JSON.stringify({ schema: 'eval-runner/v1', evals }));
}

export async function main(argv: string[], exec: Exec = realExec): Promise<number> {
	let options: Options | 'help';
	let spec: Spec;
	try {
		options = parseArgs(argv);
		if (options === 'help') {
			console.log(USAGE);
			return 0;
		}
		spec = loadSpec(options.specPath);
		if (options.runs) spec.runs = options.runs;
		if (options.only) {
			const unknown = options.only.filter((name) => !spec.configs.some((config) => config.name === name));
			if (unknown.length > 0) throw new SpecError(`--only: unknown config ${unknown.join(', ')}`);
			spec.configs = spec.configs.filter((config) => options.only!.includes(config.name));
		}
	} catch (error) {
		if (!(error instanceof SpecError)) throw error;
		console.error(`${error.message}\n\n${USAGE}`);
		return error.exitCode;
	}

	let baseSha: string;
	try {
		baseSha = await resolveBase(exec, spec.task.repo, spec.task.base);
	} catch (error) {
		console.error((error as Error).message);
		return 2;
	}
	const evalId = evalIdOf(spec.name);
	const evalDir = join(options.out, evalId);
	const version = await exec(options.claude, ['--version']);
	const cliVersion = version.code === 0 ? version.stdout.trim() : 'unknown';
	const cacheDir = join(options.out, 'cache');
	const keys = Object.fromEntries(spec.configs.map((config) => [config.name, cacheKey({ task: spec.task, baseSha, config, cliVersion })]));
	// The newest cached runs of each config, at most `spec.runs`. An unknown CLI version never reuses a run.
	const cached = Object.fromEntries(spec.configs.map((config) => [config.name, options.noCache || cliVersion === 'unknown' ? [] : readCache(cacheDir, keys[config.name]).slice(-spec.runs)]));
	const reused: RunRecord[] = spec.configs.flatMap((config) => cached[config.name].map(({ evalId: from, record }, index) => ({ ...record, id: `${config.name}-${index + 1}`, config: config.name, cached: { evalId: from, id: record.cached?.id ?? record.id } })));
	const planned = planRuns(spec.configs, spec.runs, Object.fromEntries(spec.configs.map((config) => [config.name, cached[config.name].length])));
	const maxSpend = Math.min(planned.length * spec.budget.perRunUsd, spec.budget.perEvalUsd);

	console.log(`Eval ${evalId}: ${planned.length} runs (${spec.configs.length} configs x ${spec.runs}, ${reused.length} from the cache) on ${spec.task.repo} at ${baseSha.slice(0, 7)}`);
	for (const run of planned) {
		const { args } = buildCommand(run.config, { sessionId: '<session-id>', perRunUsd: spec.budget.perRunUsd, runDir: join(evalDir, 'runs', run.id) });
		console.log(`${run.id} config=${run.config.name} model=${run.config.model ?? 'default'} clone=${join(tmpdir(), 'eval-runner', evalId, run.id)} argv: ${options.claude} ${args.join(' ')}`);
	}
	console.log(`Maximum spend: ${dollars(maxSpend)} $ (per run ${spec.budget.perRunUsd} $, per eval ${spec.budget.perEvalUsd} $)`);
	if (options.dryRun) return 0;

	const statusBefore = await sourceStatus(exec, spec.task.repo);
	mkdirSync(join(evalDir, 'runs'), { recursive: true });
	const context: RunContext = { exec, spec, options, baseSha, evalId, evalDir };
	const runs: RunRecord[] = [...reused];
	let spent = 0;
	let anyFailed = false;
	for (const [position, run] of planned.entries()) {
		// Each run is capped, so this rule bounds the total before it is spent, not after.
		if (spent + spec.budget.perRunUsd > spec.budget.perEvalUsd) {
			runs.push({ id: run.id, config: run.config.name, status: 'skipped', note: 'the eval budget would pass' });
			console.log(`[${position + 1}/${planned.length}] ${run.id} skipped: the eval budget would pass`);
			continue;
		}
		const { record, failed } = await runOne(context, run);
		anyFailed ||= failed;
		// A run with no CLI cost (timeout, crash) reserves its full cap. The priced transcript cost is a separate metric.
		spent += typeof record.cliCostUsd === 'number' && Number.isFinite(record.cliCostUsd) && record.cliCostUsd >= 0 ? record.cliCostUsd : spec.budget.perRunUsd;
		runs.push(record);
		console.log(`[${position + 1}/${planned.length}] ${run.id} ${record.status}, check ${record.acceptance?.passed ? 'passed' : 'failed'}, ${record.metrics?.cost ?? '?'} $, ${record.wallSec ?? '?'} s`);
	}

	for (const config of spec.configs) writeCache(cacheDir, keys[config.name], evalId, runs.filter((run) => run.config === config.name && !run.cached));
	const stats = aggregate(runs, spec.configs.map((config) => config.name));
	const saved = {
		schema: 'eval-runner/v1',
		id: evalId,
		name: spec.name,
		generatedAt: new Date().toISOString(),
		cliVersion,
		baseSha,
		spec,
		spent: dollars(spent),
		configs: spec.configs.map((config) => ({ name: config.name, model: config.model ?? null, ...stats[config.name] })),
		runs
	};
	writeFileSync(join(evalDir, 'eval.json'), JSON.stringify(saved));
	writeIndex(options.out);
	try {
		rmdirSync(join(tmpdir(), 'eval-runner', evalId));
	} catch {
		// Kept clones, or already gone.
	}
	if ((await sourceStatus(exec, spec.task.repo)) !== statusBefore) console.error(`Warning: the working tree of ${spec.task.repo} changed during the eval.`);
	console.log(`Spent ${dollars(spent)} $. Results in ${evalDir}`);
	return anyFailed ? 1 : 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
