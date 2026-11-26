import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { after, before, test } from 'node:test';

import { planCampaign, runCampaign, validateCampaign } from './campaign.ts';
import { realExec } from './exec.ts';
import type { Exec, ExecOptions } from './exec.ts';
import { SpecError } from './spec.ts';
import type { Spec } from './spec.ts';

const FAKE = join(import.meta.dirname, 'fixtures', 'fake-claude.mjs');
let root: string;
let repo: string;
let tmp: string;
let projects: string;
const saved = { tmpdir: process.env.TMPDIR, projects: process.env.EVAL_RUNNER_PROJECTS_DIR, mode: process.env.FAKE_CLAUDE_MODE };

const git = async (cwd: string, ...args: string[]) => {
	const result = await realExec('git', args, { cwd });
	assert.equal(result.code, 0, result.stderr);
};
before(async () => {
	root = mkdtempSync(join(tmpdir(), 'eval-campaign-'));
	repo = join(root, 'repo');
	tmp = join(root, 'tmp');
	projects = join(root, 'projects');
	mkdirSync(repo);
	mkdirSync(tmp);
	mkdirSync(projects);
	process.env.TMPDIR = tmp;
	process.env.EVAL_RUNNER_PROJECTS_DIR = projects;
	await git(repo, 'init', '-q', '-b', 'main');
	await git(repo, 'config', 'user.email', 'test@localhost');
	await git(repo, 'config', 'user.name', 'test');
	writeFileSync(join(repo, 'a.txt'), 'one\n');
	await git(repo, 'add', '-A');
	await git(repo, 'commit', '-q', '-m', 'init');
});
after(() => {
	for (const [key, value] of [['TMPDIR', saved.tmpdir], ['EVAL_RUNNER_PROJECTS_DIR', saved.projects], ['FAKE_CLAUDE_MODE', saved.mode]] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
});

const specFile = (name: string, configs = ['base', 'tested'], extra: Record<string, unknown> = {}) => {
	const path = join(root, 'specs', `${name}.json`);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		JSON.stringify({
			name,
			task: { repo, prompt: 'Make the change.', timeoutSec: 60, acceptance: { command: 'grep -q "agent was here" agent-output.txt' } },
			budget: { perRunUsd: 1, perEvalUsd: 6 },
			runs: 3,
			configs: configs.map((config) => ({ name: config, model: 'sonnet' })),
			...extra
		})
	);
	return path;
};
const campaignFile = (name: string, extra: Record<string, unknown> = {}) => {
	const path = join(root, `${name}.json`);
	writeFileSync(path, JSON.stringify({ name, specs: [specFile('alpha'), specFile('beta')], reference: 'base', runs: 2, budget: { usd: 50 }, ...extra }));
	return path;
};

// A silent console, so the tests do not print the progress lines of the campaigns.
async function quiet<T>(work: () => Promise<T>): Promise<{ result: T; out: string }> {
	const lines: string[] = [];
	const log = console.log;
	const error = console.error;
	console.log = (...args: unknown[]) => void lines.push(args.join(' '));
	console.error = (...args: unknown[]) => void lines.push(args.join(' '));
	try {
		return { result: await work(), out: lines.join('\n') };
	} finally {
		console.log = log;
		console.error = error;
	}
}

type Call = { command: string; args: string[]; cwd?: string };
// An exec that records each call, and lets a test act on the calls of the agent.
function spy(onAgent?: (number: number, options: ExecOptions) => Promise<ExecOptions | { result: Awaited<ReturnType<Exec>> }> | ExecOptions | { result: Awaited<ReturnType<Exec>> }) {
	const calls: Call[] = [];
	let agentCalls = 0;
	let running = 0;
	let peak = 0;
	const exec: Exec = async (command, args, options = {}) => {
		calls.push({ command, args, cwd: options.cwd });
		if (command !== FAKE || args.includes('--version')) return realExec(command, args, options);
		agentCalls += 1;
		running += 1;
		peak = Math.max(peak, running);
		try {
			const change = onAgent ? await onAgent(agentCalls, options) : options;
			if ('result' in change) return change.result;
			return await realExec(command, args, change);
		} finally {
			running -= 1;
		}
	};
	return { exec, calls, agents: () => calls.filter((call) => call.command === FAKE && !call.args.includes('--version')), peak: () => peak };
}
const wait = (ms: number) => new Promise((wake) => setTimeout(wake, ms));
// The order in which the agents started: "<spec>/<run id>", read from the clone of each call.
const startOrder = (calls: Call[]) => calls.filter((call) => call.command === FAKE && !call.args.includes('--version')).map((call) => `${basename(dirname(call.cwd!)).replace(/^.*-(alpha|beta)$/, '$1')}/${basename(call.cwd!)}`);
const campaignDirOf = (out: string) => join(out, 'campaigns', readdirSync(join(out, 'campaigns')).find((name) => name !== 'index.json')!);
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const argv = (file: string, out: string, ...more: string[]) => [file, '--claude', FAKE, '--out', out, ...more];

const fakeSpec = (name: string, configs: string[]) => ({ name, dir: root, runs: 3, configs: configs.map((entry) => ({ name: entry })), budget: { perRunUsd: 1, perEvalUsd: 5 }, task: {} }) as unknown as Spec;
const load = (specs: Record<string, string[]>) => (path: string) => {
	const name = basename(path, '.json');
	if (!specs[name]) throw new SpecError(`${path}: cannot read the file (ENOENT)`);
	return fakeSpec(name, specs[name]);
};
const valid = { name: 'cmp', specs: ['a.json', 'b.json'], reference: 'base', runs: 3, budget: { usd: 10 } };
const both = load({ a: ['base', 'tested', 'extra'], b: ['base', 'tested', 'other'], c: ['base', 'tested'] });

test('a campaign file is validated like a spec: each error names the field', () => {
	const bad = (patch: Record<string, unknown>, pattern: RegExp) => assert.throws(() => validateCampaign({ ...valid, specs: ['c.json'], ...patch }, root, both), (error: Error) => error instanceof SpecError && pattern.test(error.message), JSON.stringify(patch));
	bad({ name: 'Bad Name' }, /campaign\.name/);
	bad({ name: undefined }, /campaign\.name/);
	bad({ specs: [] }, /campaign\.specs/);
	bad({ specs: ['ghost.json'] }, /ghost\.json/);
	bad({ reference: undefined }, /campaign\.reference/);
	bad({ reference: 'ghost' }, /campaign\.reference.*ghost/);
	bad({ runs: 0 }, /campaign\.runs/);
	bad({ runs: undefined }, /campaign\.runs/);
	bad({ order: 'random' }, /campaign\.order/);
	bad({ concurrency: 0 }, /campaign\.concurrency/);
	bad({ retries: -1 }, /campaign\.retries/);
	bad({ budget: undefined }, /campaign\.budget/);
	bad({ budget: { usd: 0 } }, /campaign\.budget\.usd/);
	bad({ budget: { usd: 5, gradersUsd: -1 } }, /campaign\.budget\.gradersUsd/);
	bad({ budget: { usd: 5, extra: 1 } }, /campaign\.budget\.extra: unknown field/);
	bad({ surprise: 1 }, /campaign\.surprise: unknown field/);
	bad({ specs: ['c.json', 'c.json'] }, /duplicate/);
	bad({ configs: ['base'] }, /campaign\.configs/);
});

test('the defaults: interleaved, one run at a time, no retry, every config of the specs', () => {
	const campaign = validateCampaign({ ...valid, specs: ['c.json'] }, root, both);
	assert.deepEqual([campaign.order, campaign.concurrency, campaign.retries, campaign.configs], ['interleaved', 1, 0, ['base', 'tested']]);
	assert.equal(campaign.specs[0].spec.runs, 3);
	assert.equal(campaign.budget.gradersUsd, undefined);
});

test('specs with different configs are an error, unless configs names the common ones', () => {
	assert.throws(() => validateCampaign(valid, root, both), /extra|other/);
	const campaign = validateCampaign({ ...valid, runs: 5, configs: ['tested', 'base'] }, root, both);
	assert.deepEqual(campaign.configs, ['tested', 'base']);
	for (const { spec } of campaign.specs) {
		assert.deepEqual(spec.configs.map((config) => config.name), ['tested', 'base']);
		assert.equal(spec.runs, 5);
	}
	// A config that one spec lacks cannot be in `configs`.
	assert.throws(() => validateCampaign({ ...valid, configs: ['base', 'extra'] }, root, both), /campaign\.configs.*extra/);
});

test('the reference must be one of the configs, and there must be another config to compare', () => {
	assert.throws(() => validateCampaign({ ...valid, specs: ['c.json'], configs: ['tested'] }, root, both), /campaign\.reference/);
	assert.throws(() => validateCampaign({ ...valid, specs: ['c.json'], configs: ['base'] }, root, both), /campaign\.configs/);
});

test('the specs resolve against the folder of the campaign file', () => {
	const seen: string[] = [];
	validateCampaign({ ...valid, specs: ['specs/a.json', '/abs/b.json'] }, '/where/it/is', (path) => (seen.push(path), fakeSpec(basename(path, '.json'), ['base', 'tested'])));
	assert.deepEqual(seen, ['/where/it/is/specs/a.json', '/abs/b.json']);
});

const specs = [{ name: 'alpha' }, { name: 'beta' }];
test('interleaved order: run by run, spec by spec, config by config', () => {
	const keys = planCampaign(specs, ['base', 'tested'], 2, 'interleaved').map((job) => job.key);
	assert.deepEqual(keys, ['alpha/base-1', 'alpha/tested-1', 'beta/base-1', 'beta/tested-1', 'alpha/base-2', 'alpha/tested-2', 'beta/base-2', 'beta/tested-2']);
});

test('grouped order: spec, then config, then run', () => {
	const keys = planCampaign(specs, ['base', 'tested'], 2, 'grouped').map((job) => job.key);
	assert.deepEqual(keys, ['alpha/base-1', 'alpha/base-2', 'alpha/tested-1', 'alpha/tested-2', 'beta/base-1', 'beta/base-2', 'beta/tested-1', 'beta/tested-2']);
});

test('a plan leaves out the runs that already have a record', () => {
	const keys = planCampaign(specs, ['base', 'tested'], 2, 'interleaved', new Set(['alpha/base-1', 'beta/tested-2'])).map((job) => job.key);
	assert.equal(keys.length, 6);
	assert.ok(!keys.includes('alpha/base-1') && !keys.includes('beta/tested-2'));
});

test('--dry-run prints the plan in order, and writes and runs nothing', async () => {
	const out = join(root, 'dry-out');
	const probe = spy();
	const { result, out: text } = await quiet(() => runCampaign(argv(campaignFile('dry'), out, '--dry-run'), probe.exec));
	assert.equal(result, 0);
	assert.equal(existsSync(out), false);
	assert.deepEqual(probe.agents(), []);
	const lines = text.split('\n').filter((line) => /^\[\d+\] /.test(line));
	assert.deepEqual(lines.map((line) => line.split(' ').slice(1, 3).join('/')), ['alpha/base-1', 'alpha/tested-1', 'beta/base-1', 'beta/tested-1', 'alpha/base-2', 'alpha/tested-2', 'beta/base-2', 'beta/tested-2']);
	assert.match(text, /8 runs/);
	assert.match(text, /Maximum spend: 8 \$ \(budget 50 \$, per run 1 \$\)/);
	assert.deepEqual(readdirSync(join(tmp)), []);
});

test('an invalid campaign file or option exits 2 and names the problem', async () => {
	const probe = spy();
	const bad = join(root, 'bad-campaign.json');
	writeFileSync(bad, JSON.stringify({ name: 'bad' }));
	for (const args of [[bad], ['--nope'], [], [campaignFile('args'), '--resume']]) {
		const { result, out } = await quiet(() => runCampaign(args, probe.exec));
		assert.equal(result, 2, out);
	}
	assert.deepEqual(probe.agents(), []);
});

test('a campaign writes one eval dir per spec, campaign.json with the report, and an index', async () => {
	const out = join(root, 'out-normal');
	const { result } = await quiet(() => runCampaign(argv(campaignFile('normal'), out), spy().exec));
	assert.equal(result, 0);
	const dir = campaignDirOf(out);
	const campaign = readJson(join(dir, 'campaign.json'));
	assert.equal(campaign.schema, 'eval-runner/campaign/v1');
	assert.equal(campaign.status, 'done');
	assert.equal(campaign.reference, 'base');
	assert.equal(campaign.results.length, 8);
	assert.ok(campaign.results.every((entry: { status: string; attempts: number }) => entry.status === 'ok' && entry.attempts === 1));
	assert.equal(campaign.spent, 4.8);
	for (const name of ['alpha', 'beta']) {
		const saved = readJson(join(dir, name, 'eval.json'));
		assert.equal(saved.schema, 'eval-runner/v1');
		assert.equal(saved.name, name);
		assert.equal(saved.runs.length, 4);
		assert.deepEqual(saved.configs.map((config: { name: string; pass: { n: number } }) => [config.name, config.pass.n]), [['base', 2], ['tested', 2]]);
		for (const run of saved.runs) assert.ok(existsSync(join(dir, name, 'runs', run.id, 'diff.patch')));
	}
	assert.deepEqual(campaign.specs.map((entry: { name: string }) => entry.name), ['alpha', 'beta']);
	assert.equal(campaign.report.configs[0].name, 'tested');
	assert.equal(campaign.report.configs[0].pooled.pass.config.n, 4);
	const index = readJson(join(out, 'campaigns', 'index.json'));
	assert.deepEqual([index.campaigns[0].id, index.campaigns[0].name, index.campaigns[0].runs], [campaign.id, 'normal', 8]);
	// The campaign dir is not an eval of the plain index.
	assert.equal(existsSync(join(out, 'index.json')), false);
	assert.deepEqual(readdirSync(join(tmp, 'eval-runner')), []);
});

test('interleaved runs start in plan order, and grouped runs in spec order', async () => {
	const interleaved = spy();
	await quiet(() => runCampaign(argv(campaignFile('order-i'), join(root, 'out-order-i'), '--no-grade'), interleaved.exec));
	assert.deepEqual(startOrder(interleaved.calls).slice(0, 5), ['alpha/base-1', 'alpha/tested-1', 'beta/base-1', 'beta/tested-1', 'alpha/base-2']);
	const grouped = spy();
	await quiet(() => runCampaign(argv(campaignFile('order-g', { order: 'grouped' }), join(root, 'out-order-g')), grouped.exec));
	assert.deepEqual(startOrder(grouped.calls).slice(0, 5), ['alpha/base-1', 'alpha/base-2', 'alpha/tested-1', 'alpha/tested-2', 'beta/base-1']);
});

test('never more runs at once than the concurrency', async () => {
	const probe = spy(async (_number, options) => {
		await wait(150);
		return options;
	});
	const { result } = await quiet(() => runCampaign(argv(campaignFile('conc', { concurrency: 3 }), join(root, 'out-conc')), probe.exec));
	assert.equal(result, 0);
	assert.equal(probe.peak(), 3);
	assert.equal(probe.agents().length, 8);
});

test('a budget that would pass stops the runs: they are skipped in the eval, budget in the campaign', async () => {
	const out = join(root, 'out-budget');
	// Each fake run costs 0.6 $. The first estimate is the cap of the run (1 $), then the median cost (0.6 $).
	const { result } = await quiet(() => runCampaign(argv(campaignFile('budget', { budget: { usd: 1.5 }, specs: [specFile('alpha')] }), out), spy().exec));
	assert.equal(result, 0);
	const campaign = readJson(join(campaignDirOf(out), 'campaign.json'));
	assert.deepEqual(campaign.results.map((entry: { status: string }) => entry.status), ['ok', 'ok', 'budget', 'budget']);
	assert.equal(campaign.spent, 1.2);
	const saved = readJson(join(campaignDirOf(out), 'alpha', 'eval.json'));
	assert.deepEqual(saved.runs.map((run: { status: string }) => run.status), ['ok', 'ok', 'skipped', 'skipped']);
	assert.equal(saved.configs[0].pass.n, 1);
});

test('parallel runs reserve their estimate: the spend never passes the budget', async () => {
	const out = join(root, 'out-reserve');
	const probe = spy(async (_number, options) => {
		await wait(100);
		return options;
	});
	// Estimate 1 $ per run: with 2.5 $ and 4 runs in parallel, 2 runs start.
	await quiet(() => runCampaign(argv(campaignFile('reserve', { budget: { usd: 2.5 }, concurrency: 4, specs: [specFile('alpha')] }), out), probe.exec));
	assert.equal(probe.agents().length, 2);
	const campaign = readJson(join(campaignDirOf(out), 'campaign.json'));
	assert.deepEqual(campaign.results.map((entry: { status: string }) => entry.status), ['ok', 'ok', 'budget', 'budget']);
});

test('a transient failure runs again, and the cost of every attempt counts', async () => {
	const out = join(root, 'out-retry');
	// The first agent is killed by a signal: no exit code, no cost.
	const probe = spy((number, options) => (number === 1 ? { result: { code: null, stdout: '', stderr: '', timedOut: false } } : options));
	await quiet(() => runCampaign(argv(campaignFile('retry', { retries: 1, specs: [specFile('alpha')], runs: 1 }), out), probe.exec, { backoffMs: 1 }));
	const campaign = readJson(join(campaignDirOf(out), 'campaign.json'));
	const [first, second] = campaign.results;
	assert.deepEqual([first.status, first.attempts], ['ok', 2]);
	// The killed attempt counts its cap (1 $), the second one its cost (0.6 $).
	assert.equal(first.costUsd, 1.6);
	assert.deepEqual([second.status, second.attempts, second.costUsd], ['ok', 1, 0.6]);
	assert.equal(probe.agents().length, 3);
});

test('an overloaded API is transient, and a failure of the agent is not', async () => {
	const out = join(root, 'out-retry-kinds');
	const probe = spy((number, options) =>
		number === 1 ? { result: { code: 1, stdout: '', stderr: 'API Error: 529 overloaded_error', timedOut: false } } : number === 2 ? { result: { code: 1, stdout: '', stderr: 'bad flag', timedOut: false } } : options
	);
	await quiet(() => runCampaign(argv(campaignFile('retry-kinds', { retries: 2, specs: [specFile('alpha')], runs: 1 }), out), probe.exec, { backoffMs: 1 }));
	const campaign = readJson(join(campaignDirOf(out), 'campaign.json'));
	// Run 1 failed on the overload and ran again (call 2 gets the bad flag, which stops it). Run 2 ran once.
	assert.deepEqual(campaign.results.map((entry: { status: string; attempts: number }) => [entry.status, entry.attempts]), [['error', 2], ['ok', 1]]);
});

test('an abort: queued runs never start, running ones are killed, and campaign.json says so', async () => {
	const out = join(root, 'out-abort');
	const controller = new AbortController();
	process.env.FAKE_CLAUDE_MODE = 'sleep';
	let probe: ReturnType<typeof spy>;
	try {
		probe = spy((number, options) => {
			if (number === 2) setTimeout(() => controller.abort(), 150);
			return options;
		});
		const { result } = await quiet(() => runCampaign(argv(campaignFile('abort', { concurrency: 2 }), out), probe.exec, { signal: controller.signal }));
		assert.equal(result, 130);
	} finally {
		delete process.env.FAKE_CLAUDE_MODE;
	}
	// Two agents started. The six others never reached a clone or an exec call.
	assert.equal(probe.agents().length, 2);
	const started = new Set(probe.calls.map((call) => call.cwd).filter((cwd): cwd is string => cwd !== undefined && cwd.startsWith(join(tmp, 'eval-runner'))).map((cwd) => cwd.split('/').slice(-2).join('/')));
	assert.equal(started.size, 2, [...started].join(' '));
	const campaign = readJson(join(campaignDirOf(out), 'campaign.json'));
	assert.equal(campaign.status, 'interrupted');
	assert.ok(campaign.results.every((entry: { status: string }) => entry.status === 'interrupted'));
	assert.deepEqual(campaign.results.map((entry: { attempts: number }) => entry.attempts), [1, 1, 0, 0, 0, 0, 0, 0]);
	for (const name of ['alpha', 'beta']) {
		const saved = readJson(join(campaignDirOf(out), name, 'eval.json'));
		assert.ok(saved.runs.every((run: { status: string }) => run.status === 'interrupted'));
		// No sample: an interrupted run is not in the pass rate.
		assert.equal(saved.configs[0].pass.n, 0);
	}
	assert.deepEqual(readdirSync(join(tmp, 'eval-runner')), []);
});

test('a resume runs only the missing and interrupted runs, and counts the spend of the first start', async () => {
	const out = join(root, 'out-resume');
	const controller = new AbortController();
	const file = campaignFile('resume', { specs: [specFile('alpha')] });
	// Runs 1 and 2 finish. Run 3 sleeps and is killed by the abort. Run 4 never starts.
	const first = spy((number, options) => {
		if (number === 3) {
			setTimeout(() => controller.abort(), 150);
			return { ...options, env: { ...options.env, FAKE_CLAUDE_MODE: 'sleep' } };
		}
		return options;
	});
	const { result } = await quiet(() => runCampaign(argv(file, out), first.exec, { signal: controller.signal }));
	assert.equal(result, 130);
	const dir = campaignDirOf(out);
	assert.deepEqual(readJson(join(dir, 'campaign.json')).results.map((entry: { status: string }) => entry.status), ['ok', 'ok', 'interrupted', 'interrupted']);
	const before = readJson(join(dir, 'alpha', 'eval.json')).runs.filter((run: { status: string }) => run.status === 'ok').map((run: { id: string; sessionId: string }) => [run.id, run.sessionId]);

	const second = spy();
	const resumed = await quiet(() => runCampaign(['--resume', dir, '--claude', FAKE, '--out', out], second.exec));
	assert.equal(resumed.result, 0, resumed.out);
	assert.deepEqual(startOrder(second.calls).map((entry) => entry.replace(/^.*\//, '')), ['base-2', 'tested-2']);
	const campaign = readJson(join(dir, 'campaign.json'));
	assert.equal(campaign.status, 'done');
	assert.deepEqual(campaign.results.map((entry: { status: string }) => entry.status), ['ok', 'ok', 'ok', 'ok']);
	assert.equal(readdirSync(join(out, 'campaigns')).filter((name) => name !== 'index.json').length, 1);
	const after = readJson(join(dir, 'alpha', 'eval.json'));
	assert.deepEqual(after.runs.filter((run: { id: string }) => before.some(([id]: [string]) => id === run.id)).map((run: { id: string; sessionId: string }) => [run.id, run.sessionId]).sort(), [...before].sort());
	assert.equal(after.configs[0].pass.n, 2);
	// 2 finished runs + 2 reruns at 0.6 $. The killed run cost nothing.
	assert.equal(campaign.spent, 2.4);
});

test('a resume refuses a directory that is no campaign', async () => {
	const { result, out } = await quiet(() => runCampaign(['--resume', root, '--claude', FAKE], spy().exec));
	assert.equal(result, 2);
	assert.match(out, /campaign\.json/);
});
