import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { fingerprint, loadWatch, main, nameOf } from './watch.ts';

const root = mkdtempSync(join(tmpdir(), 'eval-watch-test-'));
after(() => rmSync(root, { recursive: true, force: true }));

// Captures what main prints.
async function run(argv: string[], diff: (argv: string[]) => Promise<number> = async () => 0) {
	const lines: string[] = [];
	const errors: string[] = [];
	const saved = { log: console.log, error: console.error };
	console.log = (...parts: unknown[]) => lines.push(parts.join(' '));
	console.error = (...parts: unknown[]) => errors.push(parts.join(' '));
	try {
		const code = await main(argv, { diff, now: () => new Date() });
		return { code, out: lines.join('\n'), err: errors.join('\n') };
	} finally {
		Object.assign(console, saved);
	}
}

function fixture(name: string) {
	const dir = join(root, name);
	mkdirSync(join(dir, 'skills', 'tidy'), { recursive: true });
	writeFileSync(join(dir, 'skills', 'tidy', 'SKILL.md'), 'v1\n');
	writeFileSync(join(dir, 'CLAUDE.md'), 'rules v1\n');
	writeFileSync(join(dir, 'spec.json'), JSON.stringify({ name: 'tidy-task', task: { repo: dir, prompt: 'x', acceptance: { command: 'true' } }, budget: { perRunUsd: 0.5, perEvalUsd: 5 }, configs: [{ name: 'sonnet' }] }));
	const watch = join(dir, 'out', 'watch.json');
	mkdirSync(join(dir, 'out'));
	writeFileSync(watch, JSON.stringify({ watch: [{ file: '../skills/tidy', spec: '../spec.json', runs: 2, maxRuns: 4 }, { file: '../CLAUDE.md', spec: '../spec.json', config: 'sonnet' }] }));
	return { dir, watch, out: join(dir, 'out') };
}

test('fingerprint follows the content of a file or of a directory, and loadWatch resolves the paths', () => {
	const { dir, watch } = fixture('print');
	const before = fingerprint(join(dir, 'skills', 'tidy'));
	writeFileSync(join(dir, 'skills', 'tidy', 'extra.md'), 'x');
	assert.notEqual(fingerprint(join(dir, 'skills', 'tidy')), before);
	const entries = loadWatch(watch);
	assert.deepEqual(entries[0], { file: join(dir, 'skills', 'tidy'), spec: join(dir, 'spec.json'), runs: 2, maxRuns: 4 });
	assert.deepEqual([entries[1].runs, entries[1].maxRuns, entries[1].config], [3, 10, 'sonnet']);
	writeFileSync(watch, JSON.stringify({ watch: [{ file: 'a', spec: 'b', runs: 5, maxRuns: 2 }] }));
	assert.throws(() => loadWatch(watch), /maxRuns must be at least runs/);
});

test('a first --run keeps a copy without a measure; a change is listed with its cost, and only --run measures it', async () => {
	const { dir, watch, out } = fixture('flow');
	const [skill, claudeMd] = loadWatch(watch).map(nameOf);
	const calls: string[][] = [];
	const diff = async (argv: string[]) => {
		calls.push(argv);
		mkdirSync(join(out, '20261122-000000-tidy-task-diff'), { recursive: true });
		writeFileSync(join(out, '20261122-000000-tidy-task-diff', 'diff.json'), JSON.stringify({ verdict: 'worse' }));
		return 0;
	};

	assert.match((await run(['--watch', watch])).out, new RegExp(`${skill}: never measured`));
	const first = await run(['--watch', watch, '--run'], diff);
	assert.equal(first.code, 0);
	assert.match(first.out, /first copy kept/);
	assert.equal(calls.length, 0);
	assert.equal(readFileSync(join(out, 'watch', skill, 'tidy', 'SKILL.md'), 'utf8'), 'v1\n');
	assert.equal((await run(['--watch', watch, '--status-line'])).out, '');

	writeFileSync(join(dir, 'skills', 'tidy', 'SKILL.md'), 'v2\n');
	const listed = await run(['--watch', watch]);
	// Two sides, four runs each, at 0.5 $ a run.
	assert.match(listed.out, new RegExp(`${skill}: changed, at most 4 \\$ to measure`));
	assert.match(listed.out, new RegExp(`${claudeMd}: unchanged`));
	assert.equal(calls.length, 0);
	assert.match((await run(['--watch', watch, '--status-line'])).out, /^eval:watch: 1 watched file\(s\) changed since their last measure \(tidy\)/);

	const measured = await run(['--watch', watch, '--run', '--only', skill], diff);
	assert.equal(measured.code, 0, measured.err);
	assert.deepEqual(calls[0].slice(0, 5), [join(dir, 'spec.json'), '--file', join(dir, 'skills', 'tidy'), '--before', join(out, 'watch', skill, 'tidy')]);
	assert.ok(calls[0].includes('--max-runs') && calls[0][calls[0].indexOf('--max-runs') + 1] === '4');
	assert.match(measured.out, /: worse\. Report:/);
	// The measured version becomes the next "before", and the verdict stays in the list.
	assert.equal(readFileSync(join(out, 'watch', skill, 'tidy', 'SKILL.md'), 'utf8'), 'v2\n');
	assert.match((await run(['--watch', watch])).out, new RegExp(`${skill}: unchanged, last measure: worse`));
});

test('one file on two tasks gets two names, two copies and one status line', async () => {
	const { dir, watch } = fixture('two');
	writeFileSync(join(dir, 'spec2.json'), readFileSync(join(dir, 'spec.json'), 'utf8').replace('tidy-task', 'tidy-task-2'));
	writeFileSync(watch, JSON.stringify({ watch: [{ file: '../CLAUDE.md', spec: '../spec.json' }, { file: '../CLAUDE.md', spec: '../spec2.json' }] }));
	const [first, second] = loadWatch(watch).map(nameOf);
	assert.notEqual(first, second);
	await run(['--watch', watch, '--run']);
	writeFileSync(join(dir, 'CLAUDE.md'), 'rules v2\n');
	assert.equal((await run(['--watch', watch, '--status-line'])).out, 'eval:watch: 1 watched file(s) changed since their last measure (CLAUDE.md). See pnpm eval:watch.');
});

test('a measure that does not finish keeps the old copy, and an unknown name or a missing list is refused', async () => {
	const { dir, watch, out } = fixture('fail');
	await run(['--watch', watch, '--run']);
	writeFileSync(join(dir, 'CLAUDE.md'), 'rules v2\n');
	const failed = await run(['--watch', watch, '--run'], async () => 1);
	assert.equal(failed.code, 1);
	assert.match(failed.err, /the measure did not finish \(exit code 1\)\. The old copy stays/);
	const name = nameOf(loadWatch(watch)[1]);
	assert.equal(readFileSync(join(out, 'watch', name, 'CLAUDE.md'), 'utf8'), 'rules v1\n');
	assert.equal((await run(['--watch', watch, '--only', 'nope'])).code, 2);
	assert.equal((await run(['--watch', join(dir, 'none.json')])).code, 2);
	assert.equal((await run(['--watch', join(dir, 'none.json'), '--status-line'])).code, 0);
	assert.ok(!existsSync(join(dir, 'none.json')));
});
