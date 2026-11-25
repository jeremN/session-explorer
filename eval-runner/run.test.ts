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

test('hidden tests come from the solution commit after the agent stops, and stay out of the diff', async () => {
	const source = join(root, 'repo-hidden');
	mkdirSync(source);
	await git(source, 'init', '-q', '-b', 'main');
	await git(source, 'config', 'user.email', 'test@localhost');
	await git(source, 'config', 'user.name', 'test');
	writeFileSync(join(source, 'a.txt'), 'one\n');
	await git(source, 'add', '-A');
	await git(source, 'commit', '-q', '-m', 'init');
	const baseSha = (await realExec('git', ['rev-parse', 'HEAD'], { cwd: source })).stdout.trim();
	writeFileSync(join(source, 'hidden.test.sh'), 'grep -q "agent was here" agent-output.txt\n');
	await git(source, 'add', '-A');
	await git(source, 'commit', '-q', '-m', 'solution');
	const solution = (await realExec('git', ['rev-parse', 'HEAD'], { cwd: source })).stdout.trim();
	const out = join(root, 'out-hidden');
	const spec = writeSpec('hidden', { runs: 1, task: { repo: source, base: baseSha, prompt: 'x', timeoutSec: 60, hiddenTests: { commit: solution, paths: ['hidden.test.sh'] }, acceptance: { command: 'sh hidden.test.sh' } } });
	const result = await cli([spec, '--claude', FAKE, '--out', out, '--only', 'baseline']);
	assert.equal(result.code, 0, result.stderr);
	const [run] = JSON.parse(readFileSync(join(evalDir(out), 'eval.json'), 'utf8')).runs;
	assert.equal(run.acceptance.passed, true);
	assert.deepEqual(run.diff, { files: 1, added: 1, deleted: 0 });
	assert.doesNotMatch(readFileSync(join(evalDir(out), 'runs', run.id, 'diff.patch'), 'utf8'), /hidden\.test\.sh/);
});

test('a second eval reuses the finished runs, a changed config runs again, and --no-cache runs everything', async () => {
	const out = join(root, 'out-cache');
	const first = await cli([writeSpec('cache', { runs: 1 }), '--claude', FAKE, '--out', out]);
	assert.equal(first.code, 0, first.stderr);
	const second = await cli([writeSpec('cache', { runs: 1 }), '--claude', FAKE, '--out', out]);
	assert.equal(second.code, 0, second.stderr);
	const latest = () => JSON.parse(readFileSync(join(out, readdirSync(out).filter((name) => name !== 'index.json' && name !== 'cache').sort().at(-1)!, 'eval.json'), 'utf8'));
	const reused = latest();
	assert.deepEqual(reused.runs.map((run: { id: string; cached?: unknown }) => [run.id, Boolean(run.cached)]), [['baseline-1', true], ['terse-1', true]]);
	assert.equal(reused.spent, 0);
	assert.equal(reused.configs[0].pass.passed, 1);

	await new Promise((wake) => setTimeout(wake, 1100));
	const changed = await cli([writeSpec('cache', { runs: 1, configs: [{ name: 'baseline', model: 'sonnet' }, { name: 'terse', claudeMd: { text: 'Be brief.\n' } }] }), '--claude', FAKE, '--out', out]);
	assert.equal(changed.code, 0, changed.stderr);
	assert.deepEqual(latest().runs.map((run: { id: string; cached?: unknown }) => [run.id, Boolean(run.cached)]), [['baseline-1', true], ['terse-1', false]]);

	await new Promise((wake) => setTimeout(wake, 1100));
	const forced = await cli([writeSpec('cache', { runs: 1 }), '--claude', FAKE, '--out', out, '--no-cache']);
	assert.equal(forced.code, 0, forced.stderr);
	assert.deepEqual(latest().runs.map((run: { cached?: unknown }) => Boolean(run.cached)), [false, false]);
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

test('a codex config and an opencode config: AGENTS.md, private config homes, events turned into a scored transcript', async () => {
	const out = join(root, 'out-agents');
	const record = join(root, 'agent-record.json');
	const codexAuth = join(root, 'codex-auth');
	mkdirSync(codexAuth);
	writeFileSync(join(codexAuth, 'auth.json'), '{}');
	writeFileSync(join(codexAuth, 'AGENTS.md'), 'user rules');
	const spec = writeSpec('agents', {
		runs: 1,
		configs: [
			{ name: 'codex', agent: 'codex', model: 'gpt-x', claudeMd: { text: 'Be terse.\n' }, price: { input: 1, output: 10, cacheRead: 0.1 } },
			{ name: 'opencode', agent: 'opencode', model: 'go/flash', sandbox: false }
		]
	});
	const fixtures = join(import.meta.dirname, 'fixtures');
	const codex = await cli([spec, '--only', 'codex', '--out', out, '--codex', join(fixtures, 'fake-codex.mjs')], { FAKE_AGENT_RECORD: record, CODEX_HOME: codexAuth });
	assert.equal(codex.code, 0, codex.stderr);
	const seen = JSON.parse(readFileSync(record, 'utf8'));
	assert.equal(seen.prompt, 'Make the change.');
	assert.equal(seen.agentsMd, 'Be terse.\n');
	// The agent gets a new CODEX_HOME with the login only, and it is gone after the run.
	assert.deepEqual(seen.homeFiles, ['auth.json']);
	assert.notEqual(seen.home, codexAuth);
	assert.equal(existsSync(seen.home), false);
	const first = JSON.parse(readFileSync(join(evalDir(out), 'eval.json'), 'utf8'));
	const run = first.runs[0];
	assert.equal(run.status, 'ok');
	assert.equal(run.acceptance.passed, true);
	assert.equal(run.cliCostUsd, 0.38);
	assert.deepEqual([run.metrics.cost, run.metrics.verified, run.metrics.errors], [0.38, 1, 0]);
	assert.equal(first.cliVersion, 'codex codex-cli 0.0.0');
	assert.equal(first.configs[0].agent, 'codex');
	for (const file of ['events.jsonl', 'transcript.jsonl', 'session.json', 'diff.patch']) assert.ok(existsSync(join(evalDir(out), 'runs', 'codex-1', file)), file);

	rmSync(out, { recursive: true, force: true });
	const opencode = await cli([spec, '--only', 'opencode', '--out', out, '--opencode', join(fixtures, 'fake-opencode.mjs')], { FAKE_AGENT_RECORD: record });
	assert.equal(opencode.code, 0, opencode.stderr);
	const used = JSON.parse(readFileSync(record, 'utf8'));
	assert.equal(used.agentsMd, null);
	// macOS: /var is a symlink to /private/var, and process.cwd() gives the real path. The clone is gone by now.
	const plain = (path: string) => path.replace(/^\/private(?=\/)/, '');
	assert.equal(plain(used.pwd), plain(used.cwd));
	assert.equal(plain(used.args[used.args.indexOf('--dir') + 1]), plain(used.cwd));
	assert.equal(used.noClaude, '1');
	assert.equal(existsSync(used.xdg), false);
	const second = JSON.parse(readFileSync(join(evalDir(out), 'eval.json'), 'utf8')).runs[0];
	assert.equal(second.status, 'ok');
	assert.deepEqual([second.metrics.cost, second.metrics.errors, second.metrics.verified], [0.0025, 1, 1]);
});

test('an agent that writes in the source repository stops the eval, and its run is an error', async () => {
	const out = join(root, 'out-escape');
	const spec = writeSpec('escape', { runs: 2, configs: [{ name: 'opencode', agent: 'opencode', model: 'go/flash', sandbox: false }] });
	const result = await cli([spec, '--out', out, '--opencode', join(import.meta.dirname, 'fixtures', 'fake-opencode.mjs')], { FAKE_AGENT_ESCAPE: join(repo, 'escaped.txt') });
	rmSync(join(repo, 'escaped.txt'), { force: true });
	assert.equal(result.code, 1);
	assert.match(result.stderr, /changed the working tree/);
	const saved = JSON.parse(readFileSync(join(evalDir(out), 'eval.json'), 'utf8'));
	assert.deepEqual(saved.runs.map((run: { id: string; status: string }) => [run.id, run.status]), [['opencode-1', 'error']]);
});

test('a container config runs the agent through docker: the clone and a private home only, no PWD, and the container is removed', async () => {
	const out = join(root, 'out-container');
	const record = join(root, 'container-record.json');
	const log = join(root, 'docker.log');
	const codexAuth = join(root, 'codex-auth-container');
	mkdirSync(codexAuth);
	writeFileSync(join(codexAuth, 'auth.json'), '{}');
	const spec = writeSpec('container', { runs: 1, configs: [{ name: 'codex', agent: 'codex', model: 'gpt-x', container: true, containerEnv: ['FAKE_AGENT_RECORD'], price: { input: 1, output: 10, cacheRead: 0.1 } }] });
	const docker = join(import.meta.dirname, 'fixtures', 'fake-docker.mjs');
	const missing = await cli([spec, '--out', out, '--docker', docker], { FAKE_DOCKER_NO_IMAGE: '1' });
	assert.equal(missing.code, 2);
	assert.match(missing.stderr, /pnpm eval:image/);
	const down = await cli([spec, '--out', out, '--docker', docker], { FAKE_DOCKER_DOWN: '1' });
	assert.equal(down.code, 2);
	assert.match(down.stderr, /Docker does not answer \(context fake-context\): failed to connect to the docker API/);
	assert.doesNotMatch(down.stderr, /is missing/);

	const result = await cli([spec, '--out', out, '--docker', docker], { FAKE_AGENT_RECORD: record, FAKE_DOCKER_LOG: log, CODEX_HOME: codexAuth, FAKE_DOCKER_DENY: 'github.com:443' });
	assert.equal(result.code, 0, result.stderr);
	const calls = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
	const run = calls.find((call) => call.args[0] === 'run' && call.args[1] !== '-d');
	const args: string[] = run.args;
	const after = (flag: string) => args.flatMap((value, index) => (args[index - 1] === flag ? [value] : []));
	assert.deepEqual(after('-v').map((mount) => mount.slice(mount.lastIndexOf(':') + 1)), ['/work', '/home/agent']);
	// Codex runs without its bwrap sandbox: the container is the boundary.
	assert.equal(args[args.indexOf('--sandbox') + 1], 'danger-full-access');
	assert.ok(after('-e').includes('FAKE_AGENT_RECORD'));
	assert.equal(after('-e').includes('PWD'), false);
	assert.equal(run.passed.CODEX_HOME, '/home/agent/.codex');
	// No value goes in the argv.
	assert.equal(args.some((value) => value.includes(record)), false);
	assert.ok(args.includes('--cap-drop') && args.includes('no-new-privileges'));
	const name = after('--name')[0];
	// The container goes right after the agent, before the diff and the check: the first call after `run` is `rm`.
	assert.deepEqual(calls[calls.indexOf(run) + 1].args, ['rm', '--force', name]);
	// The network: an internal network and a proxy that lets the hosts of codex through, ready before the agent starts.
	const verbs = calls.map((call) => call.args.slice(0, 2).join(' '));
	assert.deepEqual(verbs.slice(verbs.indexOf('network create'), verbs.indexOf('network create') + 4), ['network create', 'run -d', 'network connect', `logs ${name}-proxy`]);
	assert.deepEqual(calls.find((call) => call.args[1] === 'create').args, ['network', 'create', '--internal', `${name}-net`]);
	const proxy = calls.find((call) => call.args[1] === '-d').args;
	assert.ok(proxy.includes('EVAL_PROXY_ALLOW=chatgpt.com,api.openai.com,auth.openai.com'));
	assert.equal(after('--network')[0], `${name}-net`);
	assert.ok(after('-e').includes('HTTPS_PROXY'));
	assert.equal(run.passed.HTTPS_PROXY, 'http://eval-proxy:3128');
	// After the agent: the proxy goes, then the network.
	assert.ok(verbs.indexOf(`rm --force`) < verbs.lastIndexOf('network rm'));
	assert.ok(calls.some((call) => call.args.join(' ') === `rm --force ${name}-proxy`));
	const seen = JSON.parse(readFileSync(record, 'utf8'));
	assert.deepEqual(seen.homeFiles, ['auth.json']);
	const saved = JSON.parse(readFileSync(join(evalDir(out), 'eval.json'), 'utf8'));
	assert.equal(saved.runs[0].status, 'ok');
	assert.equal(saved.runs[0].acceptance.passed, true);
	assert.deepEqual(saved.runs[0].blockedHosts, ['github.com:443']);
	assert.match(readFileSync(join(evalDir(out), 'runs', 'codex-1', 'network.log'), 'utf8'), /"verdict":"deny"/);
	assert.match(saved.cliVersion, /^eval-runner-agents:[0-9a-f]{12}$/);
});

test('task.services: a database for the agent, on 127.0.0.1 for a host agent and on the run network for a container agent', async () => {
	const docker = join(import.meta.dirname, 'fixtures', 'fake-docker.mjs');
	const services = [{ name: 'db', image: 'postgres:17', port: 5432, ready: ['pg_isready'], agentEnv: { TEST_DATABASE_URL: 'postgres://u:p@${host}:${port}/t' } }];
	const task = { repo, prompt: 'Make the change.', timeoutSec: 60, acceptance: { command: 'grep -q "agent was here" agent-output.txt' }, services };
	const verbsOf = (log: string) => readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { args: string[]; passed?: Record<string, string> });

	// Host: Docker publishes the port on 127.0.0.1, and the agent gets the port it picked.
	const hostLog = join(root, 'docker-services-host.log');
	const argvFile = join(root, 'argv-services.json');
	const host = await cli([writeSpec('services-host', { runs: 1, task }), '--claude', FAKE, '--docker', docker, '--out', join(root, 'out-services-host'), '--only', 'baseline'], { FAKE_CLAUDE_ARGV: argvFile, FAKE_DOCKER_LOG: hostLog });
	assert.equal(host.code, 0, host.stderr);
	assert.equal(JSON.parse(readFileSync(argvFile, 'utf8')).fullEnv.TEST_DATABASE_URL, 'postgres://u:p@127.0.0.1:55012/t');
	const hostCalls = verbsOf(hostLog);
	const started = hostCalls.find((call) => call.args[0] === 'run' && call.args[1] === '-d')!.args;
	assert.equal(started[started.indexOf('-p') + 1], '127.0.0.1::5432');
	assert.ok(hostCalls.some((call) => call.args[0] === 'rm' && call.args[2]?.endsWith('-svc-db')));

	// Container: the service joins the run network under its name; the agent reaches it without the proxy.
	const log = join(root, 'docker-services.log');
	const codexAuth = join(root, 'codex-auth-services');
	mkdirSync(codexAuth);
	writeFileSync(join(codexAuth, 'auth.json'), '{}');
	const spec = writeSpec('services-container', { runs: 1, task, configs: [{ name: 'codex', agent: 'codex', model: 'gpt-x', container: true, containerEnv: ['FAKE_AGENT_RECORD'], price: { input: 1, output: 10, cacheRead: 0.1 } }] });
	const result = await cli([spec, '--out', join(root, 'out-services'), '--docker', docker], { FAKE_AGENT_RECORD: join(root, 'services-record.json'), FAKE_DOCKER_LOG: log, CODEX_HOME: codexAuth });
	assert.equal(result.code, 0, result.stderr);
	const calls = verbsOf(log);
	const agent = calls.find((call) => call.args[0] === 'run' && call.args[1] !== '-d')!;
	const network = agent.args[agent.args.indexOf('--network') + 1];
	assert.equal(agent.passed!.TEST_DATABASE_URL, 'postgres://u:p@db:5432/t');
	assert.equal(agent.passed!.NO_PROXY, 'localhost,127.0.0.1,db');
	const service = calls.find((call) => call.args[0] === 'run' && call.args.includes('postgres:17'))!.args;
	assert.deepEqual(service.slice(service.indexOf('--network'), service.indexOf('--network') + 6), ['--network', network, '--network-alias', 'db', '--dns', '127.0.0.1']);
	assert.ok(!service.includes('-p'));
	// The service starts after the network and before the agent, and goes before the network.
	const index = (match: (args: string[]) => boolean) => calls.findIndex((call) => match(call.args));
	const removed = index((args) => args[0] === 'rm' && args[2]?.endsWith('-svc-db'));
	assert.ok(index((args) => args[1] === 'create') < index((args) => args.includes('postgres:17')));
	assert.ok(index((args) => args.includes('postgres:17')) < calls.indexOf(agent));
	assert.ok(calls.indexOf(agent) < removed && removed < index((args) => args.join(' ') === `network rm ${network}`));
});

test('task.setup runs in the clone before the agent, stays out of the diff when ignored, and a failed setup is an error', async () => {
	const out = join(root, 'out-setup');
	// The runner diffs with its own copy of the git dir, without info/exclude: only a committed .gitignore hides a file.
	const ignoring = join(root, 'repo-ignore');
	mkdirSync(ignoring);
	await git(ignoring, 'init', '-q', '-b', 'main');
	writeFileSync(join(ignoring, '.gitignore'), 'deps/\n');
	await git(ignoring, 'add', '-A');
	await git(ignoring, '-c', 'user.email=test@localhost', '-c', 'user.name=test', 'commit', '-q', '-m', 'init');
	const spec = writeSpec('setup', {
		runs: 1,
		task: { repo: ignoring, prompt: 'Make the change.', timeoutSec: 60, setup: { command: 'mkdir -p deps && echo ready > deps/marker' }, acceptance: { command: 'test -f deps/marker && grep -q "agent was here" agent-output.txt' } },
		configs: [{ name: 'baseline' }]
	});
	const result = await cli([spec, '--out', out, '--claude', FAKE]);
	assert.equal(result.code, 0, result.stderr);
	const dir = join(evalDir(out), 'runs', 'baseline-1');
	assert.equal(JSON.parse(readFileSync(join(evalDir(out), 'eval.json'), 'utf8')).runs[0].acceptance.passed, true);
	assert.doesNotMatch(readFileSync(join(dir, 'diff.patch'), 'utf8'), /deps\/marker/);
	assert.ok(existsSync(join(dir, 'setup.log')));

	const broken = writeSpec('setup-broken', { runs: 1, task: { repo, prompt: 'x', timeoutSec: 60, setup: { command: 'exit 3' }, acceptance: { command: 'true' } }, configs: [{ name: 'baseline' }] });
	const failed = await cli([broken, '--out', join(root, 'out-setup-broken'), '--claude', FAKE]);
	assert.equal(failed.code, 1);
	const run = JSON.parse(readFileSync(join(evalDir(join(root, 'out-setup-broken')), 'eval.json'), 'utf8')).runs[0];
	assert.equal(run.status, 'error');
	assert.match(run.note, /setup failed \(exit code 3\)/);
});

test('the graders of the spec grade every run after the eval, the run cache holds no grade, and --no-grade skips them', async () => {
	const graders = [{ name: 'rules', kind: 'pattern', rules: [{ name: 'marker', pattern: 'agent was here', severity: 'minor' }] }];
	const out = join(root, 'out-graders');
	const result = await cli([writeSpec('graders', { runs: 1, graders }), '--claude', FAKE, '--out', out]);
	assert.equal(result.code, 0, result.stderr);
	const saved = JSON.parse(readFileSync(join(evalDir(out), 'eval.json'), 'utf8'));
	for (const run of saved.runs) assert.deepEqual(run.grades.rules.findings, [{ severity: 'minor', rule: 'marker', file: 'agent-output.txt', line: 1, summary: 'agent was here: Make the change.' }]);
	assert.deepEqual(saved.configs[0].grades, { rules: { graded: 1, withFindings: 1, findings: 1, bySeverity: { minor: 1 } } });
	assert.deepEqual(saved.spec.graders, [{ ...graders[0], require: [] }]);
	assert.match(result.stdout, /\[1\/2\] [0-9a-f]{8} rules ok, 1 finding/);
	assert.match(result.stdout.trimEnd().split('\n').at(-1)!, /^Spent /);
	for (const file of readdirSync(join(out, 'cache')).filter((name) => name.endsWith('.jsonl'))) assert.doesNotMatch(readFileSync(join(out, 'cache', file), 'utf8'), /"grades"/);

	const skipped = join(root, 'out-no-grade');
	const plain = await cli([writeSpec('no-grade', { runs: 1, graders }), '--claude', FAKE, '--out', skipped, '--no-grade']);
	assert.equal(plain.code, 0, plain.stderr);
	const none = JSON.parse(readFileSync(join(evalDir(skipped), 'eval.json'), 'utf8'));
	assert.equal(none.runs[0].grades, undefined);
	assert.equal(none.configs[0].grades, undefined);
	assert.doesNotMatch(plain.stdout, /rules ok/);
});
