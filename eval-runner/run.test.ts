import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { realExec } from './exec.ts';

const RUN = join(import.meta.dirname, 'run.ts');
const FAKE = join(import.meta.dirname, 'fixtures', 'fake-claude.mjs');
let root: string;
let repo: string;
let tmp: string;
let projects: string;

const git = async (cwd: string, ...args: string[]) => {
	const result = await realExec('git', args, { cwd });
	assert.equal(result.code, 0, result.stderr);
};
before(async () => {
	root = mkdtempSync(join(tmpdir(), 'eval-run-'));
	repo = join(root, 'repo');
	tmp = join(root, 'tmp');
	projects = join(root, 'projects');
	mkdirSync(repo);
	mkdirSync(tmp);
	mkdirSync(projects);
	await git(repo, 'init', '-q', '-b', 'main');
	await git(repo, 'config', 'user.email', 'test@localhost');
	await git(repo, 'config', 'user.name', 'test');
	writeFileSync(join(repo, 'a.txt'), 'one\n');
	await git(repo, 'add', '-A');
	await git(repo, 'commit', '-q', '-m', 'init');
});
after(() => rmSync(root, { recursive: true, force: true }));

const writeSpec = (name: string, extra: Record<string, unknown> = {}) => {
	const path = join(root, `${name}.json`);
	writeFileSync(
		path,
		JSON.stringify({
			name,
			task: { repo, prompt: 'Make the change.', timeoutSec: 60, acceptance: { command: 'grep -q "agent was here" agent-output.txt' } },
			budget: { perRunUsd: 1, perEvalUsd: 6 },
			runs: 2,
			configs: [{ name: 'baseline', model: 'sonnet' }, { name: 'terse', claudeMd: { text: 'Be terse.\n' } }],
			...extra
		})
	);
	return path;
};
const cli = (args: string[], env: Record<string, string> = {}, cwd?: string) =>
	realExec(process.execPath, [RUN, ...args], { cwd, env: { EVAL_RUNNER_PROJECTS_DIR: projects, TMPDIR: tmp, ...env }, timeoutMs: 60_000 });
const evalDir = (out: string) => join(out, readdirSync(out).find((name) => name !== 'index.json')!);
const clones = () => (existsSync(join(tmp, 'eval-runner')) ? readdirSync(join(tmp, 'eval-runner')).flatMap((id) => readdirSync(join(tmp, 'eval-runner', id))) : []);

test('--help prints the usage and exits 0', async () => {
	const result = await cli(['--help']);
	assert.equal(result.code, 0);
	for (const word of ['<spec.json>', '--dry-run', '--runs', '--only', '--keep', '--claude', '--out']) assert.match(result.stdout, new RegExp(word.replace(/[<>.]/g, '\\$&')));
});

test('an invalid spec or argument exits 2 and names the problem', async () => {
	const bad = join(root, 'bad.json');
	writeFileSync(bad, JSON.stringify({ name: 'bad' }));
	const spec = await cli([bad]);
	assert.equal(spec.code, 2);
	assert.match(spec.stderr, /spec\.task/);
	assert.equal((await cli([writeSpec('args'), '--nope'])).code, 2);
	assert.equal((await cli([writeSpec('args'), '--only', 'ghost'])).code, 2);
	assert.equal((await cli([])).code, 2);
});

test('--dry-run plans every run in round-robin order and writes nothing', async () => {
	const out = join(root, 'dry-out');
	const result = await cli([writeSpec('dry'), '--dry-run', '--out', out]);
	assert.equal(result.code, 0, result.stderr);
	const lines = result.stdout.split('\n').filter((line) => /^(baseline|terse)-\d /.test(line));
	assert.deepEqual(lines.map((line) => line.split(' ')[0]), ['baseline-1', 'terse-1', 'baseline-2', 'terse-2']);
	for (const flag of ['--max-budget-usd 1', '--permission-prompts none', '--setting-sources project,local', '--strict-mcp-config', '--disallowedTools Bash(git push:*)']) assert.ok(lines[0].includes(flag), flag);
	assert.match(lines[0], /--model sonnet/);
	assert.match(result.stdout.trimEnd().split('\n').at(-1)!, /^Maximum spend: 4 \$/);
	assert.equal(existsSync(out), false);
	assert.deepEqual(clones(), []);
});

test('a normal eval writes eval.json, the run files and the index, and leaves no clone', async () => {
	const out = join(root, 'out-normal');
	const result = await cli([writeSpec('normal'), '--claude', FAKE, '--out', out]);
	assert.equal(result.code, 0, result.stderr);
	const dir = evalDir(out);
	const result1 = JSON.parse(readFileSync(join(dir, 'eval.json'), 'utf8'));
	assert.equal(result1.schema, 'eval-runner/v1');
	assert.equal(result1.cliVersion, 'fake-claude 0.0.0');
	assert.match(result1.baseSha, /^[0-9a-f]{40}$/);
	assert.deepEqual(result1.runs.map((run: { id: string }) => run.id), ['baseline-1', 'terse-1', 'baseline-2', 'terse-2']);
	for (const run of result1.runs) {
		assert.equal(run.status, 'ok');
		assert.equal(run.acceptance.passed, true);
		assert.deepEqual(run.diff, { files: 1, added: 1, deleted: 0 });
		assert.equal(run.metrics.cost, 0.11);
		assert.deepEqual(run.mrs, []);
		for (const file of ['claude.json', 'transcript.jsonl', 'session.json', 'diff.patch', 'acceptance.log', 'mcp.json']) assert.ok(existsSync(join(dir, 'runs', run.id, file)), `${run.id}/${file}`);
	}
	assert.equal(result1.configs[0].pass.n, 2);
	assert.equal(result1.configs[0].pass.passed, 2);
	assert.equal(result1.configs[1].metrics.cost.median, 0.11);
	assert.equal(JSON.parse(readFileSync(join(dir, 'runs', 'baseline-1', 'session.json'), 'utf8')).id, result1.runs[0].sessionId);
	const index = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'));
	assert.equal(index.evals.length, 1);
	assert.deepEqual([index.evals[0].id, index.evals[0].name, index.evals[0].runs, index.evals[0].configs], [result1.id, 'normal', 4, ['baseline', 'terse']]);
	assert.deepEqual(clones(), []);
});

test('--keep leaves the clones, and the source repository stays clean', async () => {
	const out = join(root, 'out-keep');
	const result = await cli([writeSpec('keep', { runs: 1 }), '--claude', FAKE, '--out', out, '--keep', '--only', 'terse']);
	assert.equal(result.code, 0, result.stderr);
	assert.deepEqual(clones(), ['terse-1']);
	assert.equal(readFileSync(join(tmp, 'eval-runner', readdirSync(join(tmp, 'eval-runner'))[0], 'terse-1', 'CLAUDE.md'), 'utf8'), 'Be terse.\n');
	assert.equal((await realExec('git', ['status', '--porcelain'], { cwd: repo })).stdout, '');
	rmSync(join(tmp, 'eval-runner'), { recursive: true, force: true });
	assert.equal(JSON.parse(readFileSync(join(evalDir(out), 'eval.json'), 'utf8')).runs.length, 1);
});

test('a run over its timeout has status timeout, and the acceptance command still runs', async () => {
	const out = join(root, 'out-timeout');
	const result = await cli([writeSpec('slow', { runs: 1, task: { repo, prompt: 'x', timeoutSec: 1, acceptance: { command: 'grep -q "agent was here" agent-output.txt' } } }), '--claude', FAKE, '--out', out, '--only', 'baseline'], { FAKE_CLAUDE_MODE: 'sleep' });
	assert.equal(result.code, 0, result.stderr);
	const [run] = JSON.parse(readFileSync(join(evalDir(out), 'eval.json'), 'utf8')).runs;
	assert.equal(run.status, 'timeout');
	assert.equal(run.acceptance.passed, true);
	assert.ok(run.wallSec < 20);
	assert.ok(run.metrics.cost > 0);
});

test('a budget stop of the CLI has status budget', async () => {
	const out = join(root, 'out-budget');
	const result = await cli([writeSpec('capped', { runs: 1 }), '--claude', FAKE, '--out', out, '--only', 'baseline'], { FAKE_CLAUDE_MODE: 'budget' });
	assert.equal(result.code, 0, result.stderr);
	const [run] = JSON.parse(readFileSync(join(evalDir(out), 'eval.json'), 'utf8')).runs;
	assert.equal(run.status, 'budget');
	assert.equal(run.cliCostUsd, 0.6);
});

test('the eval budget skips the runs that could pass it, and skipped runs are not samples', async () => {
	const out = join(root, 'out-skip');
	const result = await cli([writeSpec('thin', { runs: 3, budget: { perRunUsd: 1, perEvalUsd: 2 } }), '--claude', FAKE, '--out', out, '--only', 'baseline']);
	assert.equal(result.code, 0, result.stderr);
	const saved = JSON.parse(readFileSync(join(evalDir(out), 'eval.json'), 'utf8'));
	assert.deepEqual(saved.runs.map((run: { status: string }) => run.status), ['ok', 'ok', 'skipped']);
	assert.equal(saved.configs[0].pass.n, 2);
	assert.equal(saved.spent, 1.2);
	assert.equal(existsSync(join(evalDir(out), 'runs', 'baseline-3', 'claude.json')), false);
});

test('a missing transcript gives status error and exit code 1', async () => {
	const out = join(root, 'out-notranscript');
	const result = await cli([writeSpec('lost', { runs: 1 }), '--claude', FAKE, '--out', out, '--only', 'baseline'], { FAKE_CLAUDE_MODE: 'notranscript' });
	assert.equal(result.code, 1, result.stderr);
	const [run] = JSON.parse(readFileSync(join(evalDir(out), 'eval.json'), 'utf8')).runs;
	assert.equal(run.status, 'error');
	assert.match(run.note, /no transcript/);
});

test('the runner passes the argv and the prompt to the CLI, in the clone', async () => {
	const out = join(root, 'out-argv');
	const argvFile = join(root, 'argv.json');
	const result = await cli([writeSpec('argv', { runs: 1 }), '--claude', FAKE, '--out', out, '--only', 'baseline'], { FAKE_CLAUDE_ARGV: argvFile });
	assert.equal(result.code, 0, result.stderr);
	const { args, cwd } = JSON.parse(readFileSync(argvFile, 'utf8'));
	assert.ok(args.includes('--strict-mcp-config') && args.includes('--model'));
	assert.match(cwd, /eval-runner\/.+\/baseline-1$/);
});

test('R2: a run with no CLI cost reserves its full cap, so the eval cap holds', async () => {
	const out = join(root, 'out-r2');
	const spec = writeSpec('nocost', { runs: 3, budget: { perRunUsd: 1, perEvalUsd: 2 }, task: { repo, prompt: 'x', timeoutSec: 1, acceptance: { command: 'true' } } });
	const result = await cli([spec, '--claude', FAKE, '--out', out, '--only', 'baseline'], { FAKE_CLAUDE_MODE: 'sleep' });
	assert.equal(result.code, 0, result.stderr);
	const saved = JSON.parse(readFileSync(join(evalDir(out), 'eval.json'), 'utf8'));
	assert.deepEqual(saved.runs.map((run: { status: string }) => run.status), ['timeout', 'timeout', 'skipped']);
	assert.equal(saved.spent, 2);
});

test('R4/S3: a relative --out gives absolute paths in the argv, and the agent gets the git protocol env', async () => {
	const argvFile = join(root, 'argv-r4.json');
	const result = await cli([writeSpec('rel', { runs: 1 }), '--claude', FAKE, '--out', 'results', '--only', 'baseline'], { FAKE_CLAUDE_ARGV: argvFile }, root);
	assert.equal(result.code, 0, result.stderr);
	const { args, env } = JSON.parse(readFileSync(argvFile, 'utf8'));
	assert.ok(args[args.indexOf('--mcp-config') + 1].startsWith('/'));
	assert.deepEqual(env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.allow', GIT_CONFIG_VALUE_0: 'never' });
	assert.ok(existsSync(join(root, 'results', 'index.json')));
});

test('G1: the runner git dir is outside every path the agent gets, and it is gone after the run', async () => {
	const out = join(root, 'out-g1');
	const argvFile = join(root, 'argv-g1.json');
	const result = await cli([writeSpec('g1', { runs: 1 }), '--claude', FAKE, '--out', out, '--only', 'baseline'], { FAKE_CLAUDE_ARGV: argvFile });
	assert.equal(result.code, 0, result.stderr);
	const seen = JSON.parse(readFileSync(argvFile, 'utf8'));
	assert.deepEqual(seen.near, []);
	assert.equal(seen.runnerGitDirs.length, 1);
	const gitDir = seen.runnerGitDirs[0];
	assert.ok(!seen.cwd.startsWith(gitDir));
	for (const value of [...seen.args, ...Object.values(seen.fullEnv), ...seen.generated] as string[]) assert.ok(!value.includes(gitDir), value);
	assert.equal(existsSync(gitDir), false);
	assert.equal(existsSync(join(evalDir(out), 'runs', 'baseline-1', 'gitdir')), false);
});
