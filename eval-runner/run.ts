// Eval runner: runs one task under several Claude Code configurations, N times each, and scores every run.
// Usage: node eval-runner/run.ts <spec.json> [--dry-run] [--runs N] [--only <config>[,<config>]] [--keep] [--no-cache] [--no-grade] [--claude <path>] [--codex <path>] [--opencode <path>] [--docker <path>] [--out <dir>]
// Exit codes: 0 done (or --help, or a dry run), 1 a run failed to start or an I/O error, 2 invalid spec or arguments.
import { randomUUID } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { cacheKey, readCache, writeCache } from './cache.ts';
import { claudeInvocation, claudeOutcome, codexHome, codexInvocation, codexOutcome, opencodeConfigHome, opencodeInvocation, opencodeOutcome } from './agents.ts';
import type { Invocation, Outcome } from './agents.ts';
import { runCheck } from './check.ts';
import { startServices, stopServices } from './services.ts';
import type { Services } from './services.ts';
import { setupFiles } from './command.ts';
import { editsPatch, previewEdits } from './edits.ts';
import type { EditedFile } from './edits.ts';
import { HOME, OPENCODE_KEY_ENVS, WORK, allowedHosts, blockedTargets, containerHome, containerName, containerize, imageArgs, imageProblem, imageTag, networkOf, removeContainer, startNetwork, stopNetwork } from './container.ts';
import type { Network } from './container.ts';
import { realExec } from './exec.ts';
import type { Exec } from './exec.ts';
import { behaviorFiles, scoreFiles, scoreRun } from './score.ts';
import { SpecError, loadSpec } from './spec.ts';
import type { AgentName, Config, Spec } from './spec.ts';
import { gradeRuns } from './grade.ts';
import { prepareMirror } from './mirror.ts';
import { aggregate } from './stats.ts';
import type { RunRecord, Status } from './stats.ts';
import { changeNote, collectDiff, createWorkspace, removeWorkspace, resolveBase, sourceStatus, treeWarning } from './workspace.ts';

const USAGE = `Usage: node eval-runner/run.ts <spec.json> [--dry-run] [--runs N] [--only <config>[,<config>]] [--keep] [--no-cache] [--no-grade] [--claude <path>] [--codex <path>] [--opencode <path>] [--docker <path>] [--out <dir>]

  <spec.json>   the eval spec: one task, the configurations, the run count
  --dry-run     validate the spec and print the planned runs. Starts no agent and writes nothing.
  --runs N      run each configuration N times (1 to 20). Overrides the spec.
  --only a,b    run only these configurations
  --keep        keep the clone of every run
  --no-cache    run every run, even when a finished run with the same task, config and CLI version exists
  --no-grade    do not run the graders of the spec after the runs. eval-runner/grade.ts runs them later.
  --claude P    the claude executable (default: claude)
  --codex P     the codex executable (default: codex)
  --opencode P  the opencode executable (default: opencode)
  --docker P    the docker executable, for a config with container: true (default: docker)
  --out DIR     where the results go (default: eval-runner/out)
  --spec-dir D  the value of EVAL_SPEC_DIR (default: the folder of the spec file). eval diff sets it.
`;

export type Options = { specPath: string; dryRun: boolean; runs?: number; only?: string[]; keep: boolean; noCache: boolean; noGrade: boolean; bin: Record<AgentName, string>; docker: string; out: string; specDir?: string };

function parseArgs(argv: string[]): Options | 'help' {
	const options: Options = { specPath: '', dryRun: false, keep: false, noCache: false, noGrade: false, bin: { claude: 'claude', codex: 'codex', opencode: 'opencode' }, docker: 'docker', out: join(import.meta.dirname, 'out') };
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
		else if (flag === '--no-grade') options.noGrade = true;
		else if (flag === '--runs') {
			options.runs = Number(value());
			if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 20) throw new SpecError('--runs: required integer from 1 to 20');
		} else if (flag === '--only') options.only = value().split(',');
		else if (flag === '--claude') options.bin.claude = value();
		else if (flag === '--codex') options.bin.codex = value();
		else if (flag === '--opencode') options.bin.opencode = value();
		else if (flag === '--docker') options.docker = value();
		else if (flag === '--out') options.out = resolve(value());
		else if (flag === '--spec-dir') options.specDir = resolve(value());
		else if (flag.startsWith('-')) throw new SpecError(`${flag}: unknown option`);
		else if (options.specPath) throw new SpecError(`${flag}: only one spec file is allowed`);
		else options.specPath = flag;
	}
	if (!options.specPath) throw new SpecError('<spec.json>: required');
	return options;
}

export type Planned = { id: string; config: Config; index: number };

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

type Started = Invocation & { command: string };
type Where = { home: string; clone: string; image: string; name: string };

// The container runs as the user of the runner, so the files it writes in the clone stay yours.
const USER = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
const networkFor = (config: Config, name: string): Network => networkOf(name, allowedHosts(config.agent as 'codex' | 'opencode', config.containerAllow));

// How to start the agent of a config. `home` is the private config folder of codex or opencode (on the host, or the
// home mounted in the container). PWD names the clone too: a CLI that reads PWD instead of its cwd (opencode does)
// must never see the folder of the runner.
function invocationOf(config: Config, context: { sessionId: string; perRunUsd: number; runDir: string; opencodeVersion?: string; serviceEnv?: Record<string, string>; serviceNames?: string[] }, prompt: string, where: Where, options: Options): Started {
	const serviceEnv = context.serviceEnv ?? {};
	if (config.container) {
		const bare = config.agent === 'codex' ? codexInvocation(config, `${HOME}/.codex`, prompt, 'danger-full-access') : opencodeInvocation(config, undefined, prompt, WORK, imageArgs().OPENCODE_VERSION);
		const inner = { ...bare, env: { ...bare.env, ...serviceEnv } };
		return containerize(inner, config.agent!, { noProxy: context.serviceNames, image: where.image, name: where.name, clone: where.clone, home: where.home, user: USER, network: networkFor(config, where.name), passEnv: [...(config.containerEnv ?? []), ...(config.agent === 'opencode' ? OPENCODE_KEY_ENVS : [])] }, options.docker);
	}
	const agent = config.agent ?? 'claude';
	const invocation = agent === 'codex' ? codexInvocation(config, where.home, prompt) : agent === 'opencode' ? opencodeInvocation(config, where.home, prompt, where.clone, context.opencodeVersion) : claudeInvocation(config, context, prompt);
	return { ...invocation, command: options.bin[agent], env: { ...invocation.env, ...serviceEnv, PWD: where.clone } };
}

function outcomeOf(config: Config, stdout: string, prompt: string, start: number): Outcome {
	if (config.agent === 'codex') return codexOutcome(stdout, { model: config.model, prompt, start, price: config.price });
	if (config.agent === 'opencode') return opencodeOutcome(stdout, { model: config.model, prompt, start });
	return claudeOutcome(stdout);
}

// `signal`: a campaign aborts the run with it. Only the setup and the agent carry it: the cleanup always runs.
export type RunContext = { exec: Exec; spec: Spec; options: Options; baseSha: string; evalId: string; evalDir: string; image: string; opencodeVersion?: string; mirror?: string; signal?: AbortSignal };
// `transient`: the run failed for a reason that a new run can fix (an overloaded API, an agent killed by a signal).
export type RunOutcome = { record: RunRecord; failed: boolean; transient: boolean };

class Interrupted extends Error {}
// What the agent CLIs print when the API is busy or the network drops.
const TRANSIENT = /overloaded|\b529\b|rate.?limit|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|temporarily unavailable|\b50[234]\b/i;
// A process that never started (a missing executable) is not transient: a new run fails the same way.
const NOT_STARTED = /\bspawn\b|ENOENT|EACCES/;

export async function runOne({ exec, spec, options, baseSha, evalId, evalDir, image, opencodeVersion, mirror, signal }: RunContext, planned: Planned): Promise<RunOutcome> {
	const sessionId = randomUUID();
	const name = containerName(evalId, planned.id);
	const runDir = join(evalDir, 'runs', planned.id);
	const clone = join(tmpdir(), 'eval-runner', evalId, planned.id);
	// The runner copy of the git dir. Its path is random and the agent never gets it: not in the argv, the env, the cwd
	// or a generated file.
	let gitDir: string | undefined;
	let home: string | undefined;
	let network: Network | undefined;
	let proxyDied = false;
	const services: Services = { env: {}, containers: [] };
	mkdirSync(runDir, { recursive: true });
	const record: RunRecord = { id: planned.id, config: planned.config.name, status: 'error', sessionId };
	let failed = false;
	let transient = false;
	try {
		gitDir = mkdtempSync(join(tmpdir(), 'eval-runner-git-'));
		chmodSync(gitDir, 0o700);
		const { setupSha, fileMode } = await createWorkspace(exec, { repo: mirror ?? spec.task.repo, baseSha, dir: clone, gitDir, setup: setupFiles(planned.config) });
		// The setup command (an install) runs after the setup commit: its untracked output (node_modules) stays out of
		// the diff, as long as .gitignore lists it.
		if (spec.task.setup) {
			const prepared = await exec('sh', ['-c', spec.task.setup.command], { cwd: clone, env: { EVAL_SPEC_DIR: spec.dir }, timeoutMs: spec.task.setup.timeoutSec * 1000, signal });
			if (prepared.aborted) throw new Interrupted();
			writeFileSync(join(runDir, 'setup.log'), (prepared.stdout + prepared.stderr).slice(-64 * 1024));
			if (prepared.code !== 0 || prepared.timedOut) throw new Error(`setup failed (${prepared.timedOut ? 'timeout' : `exit code ${prepared.code}`}): see setup.log`);
		}
		const agentName = planned.config.agent ?? 'claude';
		const prompt = spec.task.prompt ?? '';
		if (planned.config.container) home = containerHome(planned.config.agent!);
		else home = agentName === 'codex' ? codexHome() : agentName === 'opencode' ? opencodeConfigHome() : undefined;
		if (planned.config.container) {
			network = networkFor(planned.config, name);
			await startNetwork(exec, network, image, USER, options.docker);
		}
		// The services start after the setup and the network, and before the agent.
		if (spec.task.services) await startServices(exec, spec.task.services, { name, network: network?.network, docker: options.docker }, services);
		const invocation = invocationOf(planned.config, { sessionId, perRunUsd: spec.budget.perRunUsd, runDir, opencodeVersion, serviceEnv: services.env, serviceNames: spec.task.services?.map((service) => service.name) }, prompt, { home: home ?? '', clone, image, name }, options);
		for (const file of invocation.files) writeFileSync(file.path, file.content);

		const started = Date.now();
		const agent = await exec(invocation.command, invocation.args, { cwd: clone, input: invocation.input, env: invocation.env, timeoutMs: spec.task.timeoutSec * 1000, signal });
		record.wallSec = Math.round((Date.now() - started) / 100) / 10;
		// After a timeout the container still runs: it must be gone before the diff and the acceptance command.
		if (planned.config.container) await removeContainer(exec, name, options.docker);
		// The services go before the diff and the check, and before the network: a network with a container stays.
		await stopServices(exec, services, options.docker);
		if (network) {
			const { log, proxyStopped } = await stopNetwork(exec, network, options.docker);
			writeFileSync(join(runDir, 'network.log'), log);
			const blocked = blockedTargets(log);
			if (blocked.length) record.blockedHosts = blocked;
			proxyDied = proxyStopped;
			network = undefined;
		}
		writeFileSync(join(runDir, agentName === 'claude' ? 'claude.json' : 'events.jsonl'), agent.stdout);
		if (agent.aborted) throw new Interrupted();
		const outcome = outcomeOf(planned.config, agent.stdout, prompt, started);
		record.cliCostUsd = outcome.costUsd === null ? null : Math.round(outcome.costUsd * 10_000) / 10_000;
		const status: Status = agent.timedOut ? 'timeout' : outcome.budget ? 'budget' : agent.code !== 0 || outcome.isError ? 'error' : 'ok';
		record.status = status;
		transient = status === 'error' && ((agent.code === null && !NOT_STARTED.test(agent.stderr)) || TRANSIENT.test(`${agent.stderr} ${outcome.note ?? ''}`));
		if (status === 'error') record.note = (agent.stderr.trim() || outcome.note || `exit code ${agent.code}`).slice(0, 300);
		else if (outcome.note) record.note = outcome.note.slice(0, 300);
		// A stopped proxy cuts the agent off its API: the failure is the runner's, and the note says so first.
		if (proxyDied) record.note = `the network proxy stopped during the run (see network.log)${record.note ? `; ${record.note}` : ''}`;

		// Claude Code writes its transcript. For the other agents, the adapter built it from the printed events.
		let scored: ReturnType<typeof scoreRun>;
		if (outcome.entries) {
			writeFileSync(join(runDir, 'transcript.jsonl'), outcome.entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''));
			scored = scoreRun(outcome.entries, {}, sessionId, spec.commands);
			// The agent prices its own requests (opencode), or the config gives the price (codex). A run with no price has no cost.
			if (scored && record.cliCostUsd !== null) scored.metrics.cost = record.cliCostUsd;
			else if (scored) delete (scored.metrics as Partial<typeof scored.metrics>).cost;
		} else {
			const transcript = findTranscript(sessionId);
			scored = transcript && scoreFiles(transcript, sessionId, spec.commands);
			if (transcript) {
				cpSync(transcript, join(runDir, 'transcript.jsonl'));
				const subagents = join(transcript.slice(0, -'.jsonl'.length), 'subagents');
				if (existsSync(subagents)) cpSync(subagents, join(runDir, 'subagents'), { recursive: true });
			}
		}
		if (scored) {
			writeFileSync(join(runDir, 'session.json'), JSON.stringify(scored.session));
			record.metrics = scored.metrics;
			record.steps = scored.steps;
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

		record.acceptance = await runCheck(exec, spec.task, spec.dir, clone, runDir);
	} catch (error) {
		if (error instanceof Interrupted) {
			// The agent never finished: the run is no sample, and its files are partial.
			record.status = 'interrupted';
			record.note = 'interrupted';
		} else {
			record.status = 'error';
			record.note = (error as Error).message.slice(0, 300);
			console.error(`${planned.id}: ${record.note}`);
			failed = true;
		}
	} finally {
		if (gitDir) await removeWorkspace(gitDir);
		// Backstop: an error between the start and the first removal.
		if (planned.config.container) await removeContainer(exec, name, options.docker);
		await stopServices(exec, services, options.docker);
		if (network) await stopNetwork(exec, network, options.docker);
		if (home) await removeWorkspace(home);
		if (!options.keep) await removeWorkspace(clone);
	}
	return { record, failed, transient };
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
	return (await runEval(argv, exec)).code;
}

// What an eval needs before its first run: the base commit, the CLI versions, the edits of each config, the cache keys
// and the runs that the cache gives. `runEval` and a campaign both start here.
export type Prepared = {
	spec: Spec;
	options: Options;
	baseSha: string;
	evalId: string;
	evalDir: string;
	image: string;
	versions: Partial<Record<AgentName, string>>;
	cliVersion: string;
	edited: Record<string, EditedFile[]>;
	editErrors: Record<string, string>;
	keys: Record<string, string>;
	cacheDir: string;
	// The bare mirror that the runs and the blind graders clone from. Not set with `task.mirror: false` or `--dry-run`.
	mirror?: string;
	// The runs reused from the cache, and how many each config has.
	reused: RunRecord[];
	have: Record<string, number>;
	// The patch file of each config with edits, by config name. `startEval` fills it.
	editsPatches: Record<string, string>;
};

// `baseSha`: a campaign that resumes names the commit of its first start, so the runs stay comparable.
// `cache: false`: the eval reads no cached run, and a campaign never does.
export async function prepareEval(exec: Exec, spec: Spec, options: Options, { evalId, evalDir, baseSha: known, cache = true }: { evalId: string; evalDir: string; baseSha?: string; cache?: boolean }): Promise<Prepared | { code: number }> {
	let baseSha: string;
	try {
		baseSha = known ?? (await resolveBase(exec, spec.task.repo, spec.task.base));
	} catch (error) {
		console.error((error as Error).message);
		return { code: 2 };
	}
	// The version of each agent CLI of the spec. A Claude-only eval keeps the plain version string. A container config
	// takes the image tag: the tag names the Dockerfile, which pins the CLI versions.
	const image = imageTag();
	const agents = [...new Set(spec.configs.filter((config) => !config.container).map((config) => config.agent ?? 'claude'))];
	const versions: Partial<Record<AgentName, string>> = {};
	for (const agent of agents) {
		const version = await exec(options.bin[agent], ['--version']);
		versions[agent] = version.code === 0 && version.stdout.trim() ? version.stdout.trim() : 'unknown';
	}
	const containers = spec.configs.some((config) => config.container);
	const versionOf = (config: Config) => (config.container ? image : versions[config.agent ?? 'claude']!);
	const parts = [...agents.map((agent) => `${agent} ${versions[agent]}`), ...(containers ? [image] : [])];
	const cliVersion = agents.length === 1 && agents[0] === 'claude' && !containers ? versions.claude! : parts.join(', ');
	const problem = containers && !options.dryRun ? await imageProblem(exec, image, options.docker) : undefined;
	if (problem) {
		console.error(problem);
		return { code: 2 };
	}
	// The files that the edits of each config give at the base. The cache key and edits.patch read them. An edit that
	// fails ends the runs of its config before the agent starts, so it costs nothing.
	const edited: Record<string, EditedFile[]> = {};
	const editErrors: Record<string, string> = {};
	for (const config of spec.configs) {
		if (!config.edits) continue;
		try {
			edited[config.name] = await previewEdits(exec, { repo: spec.task.repo, baseSha, config });
		} catch (error) {
			editErrors[config.name] = (error as Error).message.slice(0, 300);
		}
	}
	const cacheDir = join(options.out, 'cache');
	// The runs clone from the mirror, not from the working checkout, which changes while the eval runs.
	let mirror: string | undefined;
	if (spec.task.mirror !== false && !options.dryRun) {
		try {
			mirror = await prepareMirror(exec, { repo: spec.task.repo, baseSha, cacheDir });
		} catch (error) {
			console.error((error as Error).message);
			return { code: 2 };
		}
		console.log(`Mirror of ${spec.task.repo}: ${mirror}`);
	}
	const keys = Object.fromEntries(spec.configs.map((config) => [config.name, cacheKey({ task: spec.task, baseSha, config, cliVersion: versionOf(config), specDir: spec.dir, edited: edited[config.name] })]));
	// The newest cached runs of each config, at most `spec.runs`. An unknown CLI version never reuses a run.
	const cached = Object.fromEntries(spec.configs.map((config) => [config.name, !cache || options.noCache || versionOf(config) === 'unknown' || editErrors[config.name] ? [] : readCache(cacheDir, keys[config.name]).slice(-spec.runs)]));
	// A reused run carries no grade: recheck.ts copies a graded record into the cache, and the graders of this spec grade it again.
	const reused: RunRecord[] = spec.configs.flatMap((config) => cached[config.name].map(({ evalId: from, record: { grades: _grades, ...record } }, index) => ({ ...record, id: `${config.name}-${index + 1}`, config: config.name, cached: { evalId: from, id: record.cached?.id ?? record.id } })));
	// The behavior counts of a reused run come from its saved transcript, with the command patterns of this spec.
	for (const record of reused) {
		const transcript = join(options.out, record.cached!.evalId, 'runs', record.cached!.id, 'transcript.jsonl');
		if (!record.metrics || !existsSync(transcript)) continue;
		const behavior = behaviorFiles(transcript, spec.commands);
		Object.assign(record.metrics, behavior.metrics);
		record.steps = behavior.steps;
	}
	const have = Object.fromEntries(spec.configs.map((config) => [config.name, cached[config.name].length]));
	return { spec, options, baseSha, evalId, evalDir, image, versions, cliVersion, edited, editErrors, keys, cacheDir, mirror, reused, have, editsPatches: {} };
}

// Creates the eval directory and writes what each config measured: the diff of its edited files against the base.
export async function startEval(exec: Exec, prepared: Prepared) {
	mkdirSync(join(prepared.evalDir, 'runs'), { recursive: true });
	for (const [name, files] of Object.entries(prepared.edited)) {
		const path = `configs/${name}/${prepared.baseSha.slice(0, 7)}/edits.patch`;
		mkdirSync(join(prepared.evalDir, dirname(path)), { recursive: true });
		writeFileSync(join(prepared.evalDir, path), await editsPatch(exec, files));
		prepared.editsPatches[name] = path;
	}
}

export function saveEval({ spec, evalId, evalDir, cliVersion, baseSha, editsPatches }: Prepared, runs: RunRecord[], spent: number) {
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
		configs: spec.configs.map((config) => ({ name: config.name, agent: config.agent ?? 'claude', model: config.model ?? null, ...stats[config.name], ...(editsPatches[config.name] ? { editsPatch: editsPatches[config.name] } : {}) })),
		runs
	};
	writeFileSync(join(evalDir, 'eval.json'), JSON.stringify(saved));
}

// The cost that a run adds to the spend. A run with no CLI cost (timeout, crash) reserves its full cap. The priced
// transcript cost is a separate metric.
export const spentBy = (record: RunRecord, perRunUsd: number) => (typeof record.cliCostUsd === 'number' && Number.isFinite(record.cliCostUsd) && record.cliCostUsd >= 0 ? record.cliCostUsd : perRunUsd);

// Same as main, and it names the eval directory, so a caller (eval diff) can read the result.
export async function runEval(argv: string[], exec: Exec = realExec): Promise<{ code: number; evalDir?: string }> {
	let options: Options | 'help';
	let spec: Spec;
	try {
		options = parseArgs(argv);
		if (options === 'help') {
			console.log(USAGE);
			return { code: 0 };
		}
		spec = loadSpec(options.specPath);
		if (options.specDir) spec.dir = options.specDir;
		if (options.runs) spec.runs = options.runs;
		if (options.only) {
			const unknown = options.only.filter((name) => !spec.configs.some((config) => config.name === name));
			if (unknown.length > 0) throw new SpecError(`--only: unknown config ${unknown.join(', ')}`);
			spec.configs = spec.configs.filter((config) => options.only!.includes(config.name));
		}
	} catch (error) {
		if (!(error instanceof SpecError)) throw error;
		console.error(`${error.message}\n\n${USAGE}`);
		return { code: error.exitCode };
	}

	const evalId = evalIdOf(spec.name);
	const evalDir = join(options.out, evalId);
	const prepared = await prepareEval(exec, spec, options, { evalId, evalDir });
	if ('code' in prepared) return prepared;
	const { baseSha, image, versions, edited, editErrors, keys, cacheDir, mirror, reused, have } = prepared;
	const planned = planRuns(spec.configs, spec.runs, have);
	const maxSpend = Math.min(planned.length * spec.budget.perRunUsd, spec.budget.perEvalUsd);

	console.log(`Eval ${evalId}: ${planned.length} runs (${spec.configs.length} configs x ${spec.runs}, ${reused.length} from the cache) on ${spec.task.repo} at ${baseSha.slice(0, 7)}`);
	for (const run of planned) {
		const agent = run.config.agent ?? 'claude';
		const clone = join(tmpdir(), 'eval-runner', evalId, run.id);
		const { command, args } = invocationOf(run.config, { sessionId: '<session-id>', perRunUsd: spec.budget.perRunUsd, runDir: join(evalDir, 'runs', run.id), opencodeVersion: versions.opencode }, '<prompt>', { home: '<home>', clone, image, name: containerName(evalId, run.id) }, options);
		console.log(`${run.id} config=${run.config.name} agent=${agent}${run.config.container ? ` (container, allow ${networkFor(run.config, '').allow.join(',')})` : ''} model=${run.config.model ?? 'default'} clone=${clone} argv: ${command} ${args.join(' ')}`);
	}
	for (const config of spec.configs) if (config.edits) console.log(`${config.name} edits: ${editErrors[config.name] ?? edited[config.name].map((file) => file.path).join(', ')}`);
	console.log(`Maximum spend: ${dollars(maxSpend)} $ (per run ${spec.budget.perRunUsd} $, per eval ${spec.budget.perEvalUsd} $)`);
	if (options.dryRun) return { code: 0 };

	await startEval(exec, prepared);
	const context: RunContext = { exec, spec, options, baseSha, evalId, evalDir, image, opencodeVersion: versions.opencode, mirror };
	// The guard window of the last run: the status of the source right before it and right after it. An edit of the user
	// between two runs is in no window, so it never counts.
	let guard: { before: string; after: string } | undefined;
	const runs: RunRecord[] = [...reused];
	let spent = 0;
	let anyFailed = false;
	for (const [position, run] of planned.entries()) {
		if (editErrors[run.config.name]) {
			runs.push({ id: run.id, config: run.config.name, status: 'error', note: editErrors[run.config.name] });
			anyFailed = true;
			console.log(`[${position + 1}/${planned.length}] ${run.id} error: ${editErrors[run.config.name]}`);
			continue;
		}
		// Each run is capped, so this rule bounds the total before it is spent, not after.
		if (spent + spec.budget.perRunUsd > spec.budget.perEvalUsd) {
			runs.push({ id: run.id, config: run.config.name, status: 'skipped', note: 'the eval budget would pass' });
			console.log(`[${position + 1}/${planned.length}] ${run.id} skipped: the eval budget would pass`);
			continue;
		}
		const statusBefore = await sourceStatus(exec, spec.task.repo);
		const { record, failed } = await runOne(context, run);
		anyFailed ||= failed;
		// An agent that writes outside its clone could write anywhere. The eval stops at the first sign.
		const statusNow = await sourceStatus(exec, spec.task.repo);
		guard = { before: statusBefore, after: statusNow };
		if (statusNow !== statusBefore) {
			record.status = 'error';
			record.note = `the agent changed the working tree of ${spec.task.repo} (${changeNote(statusBefore, statusNow)})${record.note ? `; ${record.note}` : ''}`.slice(0, 300);
			runs.push(record);
			anyFailed = true;
			console.error(`${run.id}: the agent changed the working tree of ${spec.task.repo}. The eval stops. Check \`git status\` there.`);
			break;
		}
		spent += spentBy(record, spec.budget.perRunUsd);
		runs.push(record);
		console.log(`[${position + 1}/${planned.length}] ${run.id} ${record.status}, check ${record.acceptance?.passed ? 'passed' : 'failed'}, ${record.metrics?.cost ?? '?'} $, ${record.wallSec ?? '?'} s`);
	}

	// With no run, the grading window starts here.
	if (!guard) {
		const now = await sourceStatus(exec, spec.task.repo);
		guard = { before: now, after: now };
	}
	for (const config of spec.configs) writeCache(cacheDir, keys[config.name], evalId, runs.filter((run) => run.config === config.name && !run.cached));
	const save = () => saveEval(prepared, runs, spent);
	save();
	writeIndex(options.out);
	// The graders come after the run cache, so a cached run never carries a grade into a later eval. eval.json exists
	// before them: a grade pass that stops halfway loses only its grades, and grade.ts can run it again.
	if (spec.graders && !options.noGrade) {
		await gradeRuns({ evalId, evalDir, baseSha, spec, runs, mirror }, { exec });
		save();
	}
	try {
		rmdirSync(join(tmpdir(), 'eval-runner', evalId));
	} catch {
		// Kept clones, or already gone.
	}
	const warning = treeWarning(spec.task.repo, { before: guard.before, afterRuns: guard.after, final: await sourceStatus(exec, spec.task.repo) });
	if (warning) console.error(warning);
	console.log(`Spent ${dollars(spent)} $. Results in ${evalDir}`);
	return { code: anyFailed ? 1 : 0, evalDir };
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
