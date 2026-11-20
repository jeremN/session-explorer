import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { realExec } from './exec.ts';
import { main } from './recheck.ts';

const root = mkdtempSync(join(tmpdir(), 'eval-recheck-test-'));
after(() => rmSync(root, { recursive: true, force: true }));
const quiet = { log: console.log, error: console.error };

async function git(cwd: string, ...args: string[]) {
	const result = await realExec('git', ['-c', 'user.email=test@localhost', '-c', 'user.name=test', ...args], { cwd });
	assert.equal(result.code, 0, result.stderr);
	return result.stdout.trim();
}

// A repo with a base commit, and a later commit that holds the hidden test. The test passes when answer.txt says 42.
async function fixture(name: string) {
	const repo = join(root, name, 'repo');
	mkdirSync(repo, { recursive: true });
	await git(repo, 'init', '-q', '-b', 'main');
	writeFileSync(join(repo, 'answer.txt'), '0\n');
	await git(repo, 'add', '-A');
	await git(repo, 'commit', '-q', '-m', 'base');
	const base = await git(repo, 'rev-parse', 'HEAD');
	writeFileSync(join(repo, 'check.sh'), 'grep -qx 42 answer.txt\n');
	await git(repo, 'add', '-A');
	await git(repo, 'commit', '-q', '-m', 'hidden test');
	const hidden = await git(repo, 'rev-parse', 'HEAD');
	// The diff of the run: answer.txt goes from 0 to 42.
	const patch = '--- a/answer.txt\n+++ b/answer.txt\n@@ -1 +1 @@\n-0\n+42\n';
	const patchFile = `diff --git a/answer.txt b/answer.txt\n${patch}`;
	const out = join(root, name, 'out');
	const evalDir = join(out, 'e1');
	mkdirSync(join(evalDir, 'runs', 'sonnet-1'), { recursive: true });
	writeFileSync(join(evalDir, 'runs', 'sonnet-1', 'diff.patch'), patchFile);
	writeFileSync(join(evalDir, 'runs', 'sonnet-1', 'acceptance.log'), 'port is already allocated\n');
	const failed = { exitCode: 3, passed: false, timedOut: false, durationMs: 5 };
	const record = { id: 'sonnet-1', config: 'sonnet', status: 'ok', acceptance: failed, diff: { files: 1, added: 1, deleted: 1 } };
	const task = { repo, base, prompt: 'Make it 42.', timeoutSec: 60, acceptance: { command: 'sh check.sh', timeoutSec: 30 }, hiddenTests: { commit: hidden, paths: ['check.sh'] } };
	writeFileSync(join(evalDir, 'eval.json'), JSON.stringify({ id: 'e1', baseSha: base, spec: { dir: join(root, name), task, configs: [{ name: 'sonnet', model: 'sonnet' }] }, runs: [record] }));
	mkdirSync(join(out, 'cache'));
	writeFileSync(join(out, 'cache', 'key.jsonl'), `${JSON.stringify({ evalId: 'other', record: { id: 'sonnet-1' } })}\n${JSON.stringify({ evalId: 'e1', record })}\n`);
	return { repo, base, hidden, evalDir, out, task };
}

test('recheck applies the saved diff at the base, runs the check again, and keeps what it replaced', async () => {
	const { evalDir, out } = await fixture('same');
	assert.equal(await main([evalDir], realExec, () => '2026-11-20T00:00:00Z'), 0);
	const [record] = JSON.parse(readFileSync(join(evalDir, 'eval.json'), 'utf8')).runs;
	assert.equal(record.acceptance.passed, true);
	assert.deepEqual(record.rechecked, { at: '2026-11-20T00:00:00Z', previous: { exitCode: 3, passed: false, timedOut: false, durationMs: 5 } });
	assert.equal(readFileSync(join(evalDir, 'runs', 'sonnet-1', 'acceptance.original.log'), 'utf8'), 'port is already allocated\n');
	assert.ok(existsSync(join(evalDir, 'runs', 'sonnet-1', 'acceptance.log')));
	// The cached copy gets the new acceptance; the entry of another eval stays as it was.
	const cache = readFileSync(join(out, 'cache', 'key.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
	assert.deepEqual(cache[0], { evalId: 'other', record: { id: 'sonnet-1' } });
	assert.equal(cache[1].record.acceptance.passed, true);
	// A second recheck keeps the first acceptance as the previous one, and the first log as the original.
	assert.equal(await main([evalDir], realExec, () => 'later'), 0);
	const again = JSON.parse(readFileSync(join(evalDir, 'eval.json'), 'utf8')).runs[0];
	assert.equal(again.rechecked.previous.exitCode, 3);
	assert.equal(readFileSync(join(evalDir, 'runs', 'sonnet-1', 'acceptance.original.log'), 'utf8'), 'port is already allocated\n');
});

test('recheck refuses a diff whose counts differ from the run, and a spec of another task', async () => {
	const { evalDir, task } = await fixture('mismatch');
	const saved = JSON.parse(readFileSync(join(evalDir, 'eval.json'), 'utf8'));
	saved.runs[0].diff = { files: 2, added: 9, deleted: 0 };
	writeFileSync(join(evalDir, 'eval.json'), JSON.stringify(saved));
	console.error = () => {};
	try {
		assert.equal(await main([evalDir]), 1);
		assert.equal(JSON.parse(readFileSync(join(evalDir, 'eval.json'), 'utf8')).runs[0].acceptance.exitCode, 3);
		const other = join(root, 'mismatch', 'other.json');
		writeFileSync(other, JSON.stringify({ name: 'x', task: { ...task, prompt: 'Something else.' }, budget: { perRunUsd: 1, perEvalUsd: 1 }, configs: [{ name: 'sonnet' }] }));
		assert.equal(await main([evalDir, '--spec', other]), 2);
	} finally {
		console.error = quiet.error;
	}
});

test('recheck with --spec takes its hidden tests and removes the cached copies of the old key', async () => {
	const { repo, evalDir, out, task } = await fixture('spec');
	// New hidden tests: the check wants a second file that the run never wrote, so the run now fails.
	writeFileSync(join(repo, 'check.sh'), 'grep -qx 42 answer.txt && test -f extra.txt\n');
	await git(repo, 'add', '-A');
	await git(repo, 'commit', '-q', '-m', 'stricter hidden test');
	const stricter = await git(repo, 'rev-parse', 'HEAD');
	const spec = join(root, 'spec', 'spec.json');
	writeFileSync(spec, JSON.stringify({ name: 'x', task: { ...task, hiddenTests: { commit: stricter, paths: ['check.sh'] } }, budget: { perRunUsd: 1, perEvalUsd: 1 }, configs: [{ name: 'sonnet' }] }));
	assert.equal(await main([evalDir, '--spec', spec]), 0);
	const saved = JSON.parse(readFileSync(join(evalDir, 'eval.json'), 'utf8'));
	assert.equal(saved.runs[0].acceptance.passed, false);
	assert.equal(saved.spec.task.hiddenTests.commit, stricter);
	const cache = readFileSync(join(out, 'cache', 'key.jsonl'), 'utf8').trim().split('\n');
	assert.deepEqual(cache.map((line) => JSON.parse(line).evalId), ['other']);
});
