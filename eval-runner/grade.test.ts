import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { realExec } from './exec.ts';
import { main, patternFindings } from './grade.ts';
import type { PatternGrader } from './spec.ts';

const root = mkdtempSync(join(tmpdir(), 'eval-grade-test-'));
after(() => rmSync(root, { recursive: true, force: true }));

// Two files changed, one deleted. Line numbers are those of the new file.
const PATCH = [
	'diff --git a/src/a.ts b/src/a.ts',
	'index 1111111..2222222 100644',
	'--- a/src/a.ts',
	'+++ b/src/a.ts',
	'@@ -1,3 +1,4 @@',
	' const one = 1;',
	'-const two = x as Two;',
	'+const two = x as Two;  ',
	'+++i;',
	' const three = 3;',
	'@@ -10,2 +11,3 @@ function f() {',
	' a();',
	'+b(y as Bee);',
	' c();',
	'diff --git a/notes.md b/notes.md',
	'new file mode 100644',
	'--- /dev/null',
	'+++ b/notes.md',
	'@@ -0,0 +1,2 @@',
	'+use it as Text',
	'+done',
	'\\ No newline at end of file',
	'diff --git a/old/gone.md b/old/gone.md',
	'deleted file mode 100644',
	'--- a/old/gone.md',
	'+++ /dev/null',
	'@@ -1 +0,0 @@',
	'-removed as Gone',
	''
].join('\n');

const rules = (extra: Partial<PatternGrader> = {}): PatternGrader => ({
	name: 'rules',
	kind: 'pattern',
	rules: [{ name: 'no-as-cast', pattern: '\\bas [A-Z]\\w+', paths: '\\.ts$', severity: 'minor' }, { name: 'plus', pattern: '^\\+\\+i', severity: 'nit' }],
	require: [],
	...extra
});

test('a pattern rule finds the added lines of the matching files, with the line number of the new file', () => {
	assert.deepEqual(patternFindings(rules(), PATCH), [
		{ severity: 'minor', rule: 'no-as-cast', file: 'src/a.ts', line: 2, summary: 'const two = x as Two;' },
		// An added line can start with ++: it is still a line of the hunk, not a file header.
		{ severity: 'nit', rule: 'plus', file: 'src/a.ts', line: 3, summary: '++i;' },
		{ severity: 'minor', rule: 'no-as-cast', file: 'src/a.ts', line: 12, summary: 'b(y as Bee);' }
	]);
	// Without paths a rule reads every file. A deleted line never matches.
	const all = patternFindings(rules({ rules: [{ name: 'cast', pattern: 'as [A-Z]', severity: 'minor' }] }), PATCH);
	assert.deepEqual(all.map((finding) => `${finding.file}:${finding.line}`), ['src/a.ts:2', 'src/a.ts:12', 'notes.md:1']);
	// The summary is the trimmed line, 200 characters at most.
	const long = patternFindings(rules({ rules: [{ name: 'x', pattern: 'x', severity: 'minor' }] }), `--- a/x\n+++ b/x\n@@ -0,0 +1 @@\n+${'x'.repeat(300)}\n`);
	assert.equal(long[0].summary.length, 200);
});

test('a require rule gives one finding when no changed file matches, and a deleted file does not count', () => {
	const grader = rules({
		rules: [],
		require: [
			{ name: 'notes', paths: '\\.md$', severity: 'important' },
			{ name: 'changeset', paths: '^\\.changeset/', severity: 'important' },
			{ name: 'gone', paths: '^old/', severity: 'minor' }
		]
	});
	assert.deepEqual(patternFindings(grader, PATCH), [
		{ severity: 'important', rule: 'changeset', summary: 'no changed file matches ^\\.changeset/' },
		{ severity: 'minor', rule: 'gone', summary: 'no changed file matches ^old/' }
	]);
});

async function git(cwd: string, ...args: string[]) {
	const result = await realExec('git', ['-c', 'user.email=test@localhost', '-c', 'user.name=test', ...args], { cwd });
	assert.equal(result.code, 0, result.stderr);
	return result.stdout.trim();
}

// The grader script writes what it saw next to it, then prints its findings. Its first argument picks a behavior.
// `first` finds something in sample 0 only. `fail-second` fails in sample 1 only.
const GRADER = `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const mode = process.argv[2];
const sample = process.env.EVAL_SAMPLE;
if (mode === 'bad') { console.log('not json'); process.exit(0); }
if (mode === 'fail' || (mode === 'fail-second' && sample === '1')) { console.error('boom'); process.exit(3); }
if (mode === 'slow') await new Promise((wake) => setTimeout(wake, 5000));
const id = process.env.EVAL_GRADE_ID;
writeFileSync(join(process.env.EVAL_SPEC_DIR, 'seen-' + id + '-' + sample + '.json'), JSON.stringify({ id, sample, base: process.env.EVAL_BASE, diff: process.env.EVAL_DIFF, diffText: readFileSync(process.env.EVAL_DIFF, 'utf8'), specDir: process.env.EVAL_SPEC_DIR, cwd: process.cwd(), answer: readFileSync('answer.txt', 'utf8'), harness: existsSync('HARNESS.md'), rules: readFileSync('rules.md', 'utf8'), env: process.env }));
const findings = mode === 'first' && sample !== '0' ? [] : [{ severity: 'minor', summary: 'answer is hard-coded', file: 'answer.txt', line: 1, extra: 'dropped' }];
console.log(JSON.stringify({ findings, costUsd: 0.4 }));
`;

// A repo at its base commit, a saved eval of two configs, and a grader script in the spec folder. The config names and
// the run ids are distinct words, so a test can look for them in what the grader saw.
async function fixture(name: string, graders: unknown[], budget: Record<string, number> = {}) {
	const repo = join(root, name, 'repo');
	mkdirSync(repo, { recursive: true });
	await git(repo, 'init', '-q', '-b', 'main');
	writeFileSync(join(repo, 'answer.txt'), '0\n');
	writeFileSync(join(repo, 'rules.md'), 'base rules\n');
	await git(repo, 'add', '-A');
	await git(repo, 'commit', '-q', '-m', 'base');
	const base = await git(repo, 'rev-parse', 'HEAD');
	const specDir = join(root, name, 'spec');
	mkdirSync(specDir);
	writeFileSync(join(specDir, 'grader.mjs'), GRADER);
	const evalDir = join(root, name, 'out', 'e1');
	// Each run has its own diff, so no run reuses the grade of another from the grade cache.
	const patchOf = (answer: number) => `diff --git a/answer.txt b/answer.txt\n--- a/answer.txt\n+++ b/answer.txt\n@@ -1 +1 @@\n-0\n+${answer}\n`;
	const patches: Record<string, string> = { 'zebra-config-1': patchOf(42), 'yak-config-1': patchOf(43), 'zebra-config-2': '' };
	const runs = [
		{ id: 'zebra-config-1', config: 'zebra-config', status: 'ok', diff: { files: 1, added: 1, deleted: 1 } },
		{ id: 'yak-config-1', config: 'yak-config', status: 'timeout', diff: { files: 1, added: 1, deleted: 1 } },
		{ id: 'yak-config-2', config: 'yak-config', status: 'error', note: 'crash' },
		{ id: 'zebra-config-2', config: 'zebra-config', status: 'ok', diff: { files: 0, added: 0, deleted: 0 } }
	];
	for (const run of runs) {
		mkdirSync(join(evalDir, 'runs', run.id), { recursive: true });
		if (run.id in patches) writeFileSync(join(evalDir, 'runs', run.id, 'diff.patch'), patches[run.id]);
	}
	const task = { repo, base: 'HEAD', prompt: 'Make it 42.', timeoutSec: 60, acceptance: { command: 'true', timeoutSec: 30 } };
	// zebra-config writes a harness file and edits a file of the base: a blind grader must see neither.
	const configs = [{ name: 'zebra-config', files: { 'HARNESS.md': { text: 'zebra rules\n' } }, edits: [{ file: 'rules.md', append: 'zebra edit\n' }] }, { name: 'yak-config' }];
	const ev = {
		schema: 'eval-runner/v1',
		id: 'e1',
		name,
		baseSha: base,
		spec: { name, dir: specDir, task, budget: { perRunUsd: 1, perEvalUsd: 6, ...budget }, runs: 2, configs, graders },
		configs: configs.map((config) => ({ name: config.name, agent: 'claude', model: null, pass: { passed: 0, n: 2 }, metrics: {} })),
		runs
	};
	writeFileSync(join(evalDir, 'eval.json'), JSON.stringify(ev));
	return { repo, base, specDir, evalDir, task, patches };
}

const review = (mode: string, extra: Record<string, unknown> = {}) => ({ name: 'review', kind: 'command', command: `node "$EVAL_SPEC_DIR/grader.mjs" ${mode}`, timeoutSec: 60, blind: true, ...extra });
const saved = (evalDir: string) => JSON.parse(readFileSync(join(evalDir, 'eval.json'), 'utf8'));
const seen = (specDir: string) => readdirSync(specDir).filter((file) => file.startsWith('seen-')).map((file) => JSON.parse(readFileSync(join(specDir, file), 'utf8')));

async function quiet(run: () => Promise<number>) {
	const lines: string[] = [];
	const { log, error } = console;
	console.log = (line: string) => lines.push(String(line));
	console.error = (line: string) => lines.push(String(line));
	try {
		return { code: await run(), lines };
	} finally {
		Object.assign(console, { log, error });
	}
}

test('a command grader runs blind in a new clone of the change, and its findings go to the record and the config stats', async () => {
	const { base, specDir, evalDir, patches } = await fixture('command', [review('ok')]);
	const { code, lines } = await quiet(() => main([evalDir]));
	assert.equal(code, 0, lines.join('\n'));
	const ev = saved(evalDir);
	const grades = Object.fromEntries(ev.runs.map((run: { id: string; grades?: Record<string, unknown> }) => [run.id, run.grades?.review]));
	for (const id of ['zebra-config-1', 'yak-config-1']) {
		assert.equal(grades[id].status, 'ok');
		assert.match(grades[id].id, /^[0-9a-f]{8}$/);
		assert.deepEqual(grades[id].findings, [{ severity: 'minor', summary: 'answer is hard-coded', file: 'answer.txt', line: 1 }]);
		assert.equal(grades[id].costUsd, 0.4);
		assert.equal(typeof grades[id].durationMs, 'number');
		assert.match(readFileSync(join(evalDir, 'runs', id, 'grade-review.log'), 'utf8'), /answer is hard-coded/);
	}
	// A run that did not finish, and a run with no change, are not graded.
	assert.equal(grades['yak-config-2'].status, 'skipped');
	assert.equal(grades['zebra-config-2'].status, 'skipped');
	assert.deepEqual(ev.configs.map((config: { grades: unknown }) => config.grades), [
		{ review: { graded: 1, withFindings: 1, findings: 1, bySeverity: { minor: 1 } } },
		{ review: { graded: 1, withFindings: 1, findings: 1, bySeverity: { minor: 1 } } }
	]);

	const views = seen(specDir);
	assert.equal(views.length, 2);
	for (const view of views) {
		// The grade id is the one of the record: it links the view to its run.
		const runId = ['zebra-config-1', 'yak-config-1'].find((id) => grades[id].id === view.id)!;
		assert.ok(runId, view.id);
		assert.equal(view.base, base);
		assert.equal(view.specDir, specDir);
		assert.equal(view.answer, runId === 'zebra-config-1' ? '42\n' : '43\n');
		assert.equal(view.diffText, patches[runId]);
		// The clone holds the base, not the harness files or the edits of the config.
		assert.equal(view.harness, false);
		assert.equal(view.rules, 'base rules\n');
		// The copy of the patch is named by the grade id.
		assert.ok(view.diff.endsWith(`${view.id}.patch`));
		// Blind: no config name and no run id in the cwd, the patch path or the environment. Both are gone after the grade.
		for (const word of ['zebra-config', 'yak-config']) {
			assert.ok(!view.cwd.includes(word) && !view.diff.includes(word), view.cwd);
			for (const [key, value] of Object.entries(view.env as Record<string, string>)) assert.ok(!String(value).includes(word), `${key}=${value}`);
		}
		assert.equal(existsSync(view.cwd), false);
		assert.equal(existsSync(view.diff), false);
	}
	// The progress lines name the grade id and the grader, never the config. The summary at the end names the configs.
	const progress = lines.filter((line) => line.startsWith('['));
	assert.equal(progress.length, 2);
	for (const line of progress) {
		assert.match(line, /^\[\d\/2\] [0-9a-f]{8} review ok, 1 finding, 0\.4 \$$/);
		assert.doesNotMatch(line, /zebra|yak/);
	}
	assert.ok(lines.some((line) => /zebra-config/.test(line) && /1\/1/.test(line)), lines.join('\n'));
});

test('a grade is reused from the cache at no cost, and --force runs the grader again', async () => {
	// The first grade costs 0.4 $: it reaches the budget, so the second grade of the pass gets the status budget.
	const { specDir, evalDir } = await fixture('cache', [review('ok')], { gradersUsd: 0.3 });
	assert.equal((await quiet(() => main([evalDir]))).code, 0);
	assert.equal(seen(specDir).length, 1, 'the budget stops the second grade');
	const first = saved(evalDir).runs.map((run: { grades: { review: { status: string } } }) => run.grades.review.status);
	assert.deepEqual(first.filter((status: string) => status !== 'skipped').sort(), ['budget', 'ok']);

	// The second pass reuses the cached grade, so the budget still allows one new grade.
	const again = await quiet(() => main([evalDir]));
	assert.equal(again.code, 0);
	assert.equal(seen(specDir).length, 2);
	const grades = saved(evalDir).runs.flatMap((run: { grades: { review: { status: string; cached?: boolean } } }) => (run.grades.review.status === 'ok' ? [run.grades.review] : []));
	assert.equal(grades.length, 2);
	assert.equal(grades.filter((grade: { cached?: boolean }) => grade.cached).length, 1);
	assert.ok(again.lines.some((line) => / review ok, 1 finding, cached$/.test(line)), again.lines.join('\n'));
	assert.ok(existsSync(join(evalDir, '..', 'cache', 'grades')));

	const forced = await quiet(() => main([evalDir, '--force', '--runs', 'zebra-config-1']));
	assert.equal(forced.code, 0);
	assert.equal(seen(specDir).length, 3);
	assert.equal(saved(evalDir).runs[0].grades.review.cached, undefined);
});

test('invalid JSON and a non-zero exit give an error grade, a slow grader a timeout grade, and grade.ts exits 1', async () => {
	const { evalDir } = await fixture('errors', [review('bad'), { ...review('fail'), name: 'crash' }, { ...review('slow'), name: 'slow', timeoutSec: 0.5 }]);
	const { code } = await quiet(() => main([evalDir, '--runs', 'zebra-config-1']));
	assert.equal(code, 1);
	const { grades } = saved(evalDir).runs[0];
	assert.equal(grades.review.status, 'error');
	assert.match(grades.review.note, /JSON/);
	assert.equal(grades.crash.status, 'error');
	assert.match(grades.crash.note, /exit code 3.*boom/);
	assert.equal(grades.slow.status, 'timeout');
	assert.deepEqual(grades.slow.findings, []);
	// --runs leaves the other runs as they were.
	assert.equal(saved(evalDir).runs[1].grades, undefined);
});

test('a pattern grader needs no clone; --graders picks the graders and keeps the grades of the others', async () => {
	const pattern = { name: 'rules', kind: 'pattern', rules: [{ name: 'magic', pattern: '\\b42\\b', severity: 'minor' }], require: [{ name: 'tests', paths: '\\.test\\.', severity: 'important' }] };
	const { specDir, evalDir } = await fixture('pattern', [review('ok'), pattern]);
	assert.equal((await quiet(() => main([evalDir, '--graders', 'rules']))).code, 0);
	assert.equal(seen(specDir).length, 0);
	const [run] = saved(evalDir).runs;
	assert.deepEqual(run.grades.rules.findings, [
		{ severity: 'minor', rule: 'magic', file: 'answer.txt', line: 1, summary: '42' },
		{ severity: 'important', rule: 'tests', summary: 'no changed file matches \\.test\\.' }
	]);
	assert.equal(run.grades.review, undefined);
	assert.equal((await quiet(() => main([evalDir, '--graders', 'review']))).code, 0);
	assert.ok(saved(evalDir).runs[0].grades.rules);
	assert.equal(saved(evalDir).runs[0].grades.review.status, 'ok');
});

test('a non-blind grader gets the config and the run id; --spec must name the same task and adds its graders', async () => {
	const { specDir, evalDir, task } = await fixture('open', [review('ok', { blind: false })]);
	assert.equal((await quiet(() => main([evalDir, '--runs', 'zebra-config-1']))).code, 0);
	const [view] = seen(specDir);
	assert.equal(view.env.EVAL_CONFIG, 'zebra-config');
	assert.equal(view.env.EVAL_RUN_ID, 'zebra-config-1');
	// A non-blind grader gets the clone of the run: the files and the edits of its config.
	assert.equal(view.harness, true);
	assert.equal(view.rules, 'base rules\nzebra edit\n');

	const other = join(specDir, 'other.json');
	writeFileSync(other, JSON.stringify({ name: 'x', task: { ...task, prompt: 'Something else.' }, budget: { perRunUsd: 1, perEvalUsd: 1 }, configs: [{ name: 'a' }], graders: [{ name: 'rules', kind: 'pattern', rules: [{ name: 'magic', pattern: '42', severity: 'minor' }] }] }));
	assert.equal((await quiet(() => main([evalDir, '--spec', other]))).code, 2);
	const same = join(specDir, 'same.json');
	writeFileSync(same, JSON.stringify({ name: 'x', task, budget: { perRunUsd: 1, perEvalUsd: 1 }, configs: [{ name: 'a' }], graders: [{ name: 'rules', kind: 'pattern', rules: [{ name: 'magic', pattern: '42', severity: 'minor' }] }] }));
	assert.equal((await quiet(() => main([evalDir, '--spec', same, '--graders', 'rules']))).code, 0);
	const ev = saved(evalDir);
	assert.deepEqual(ev.spec.graders.map((grader: { name: string }) => grader.name), ['review', 'rules']);
	assert.equal(ev.runs[0].grades.rules.findings.length, 1);

	assert.equal((await quiet(() => main([evalDir, '--graders', 'ghost']))).code, 2);
	assert.equal((await quiet(() => main([evalDir, '--nope']))).code, 2);
	assert.equal((await quiet(() => main([join(root, 'nowhere')]))).code, 2);
});

type SampledGrade = { status: string; id: string; findings: { sample?: number }[]; flagged?: boolean; costUsd?: number; note?: string; cached?: boolean; samples?: { status: string; findings: number; costUsd?: number; durationMs?: number; note?: string }[] };
const HARD_CODED = { severity: 'minor', summary: 'answer is hard-coded', file: 'answer.txt', line: 1 };
const near = (actual: number | undefined, expected: number) => assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);

test('samples run the grader N times in one clone with one grade id; majority and union merge the samples to one verdict', async () => {
	const { specDir, evalDir } = await fixture('samples', [{ ...review('first'), name: 'majority', samples: 3 }, { ...review('first'), name: 'union', samples: 3, merge: 'union' }, review('ok')]);
	const { code, lines } = await quiet(() => main([evalDir, '--runs', 'zebra-config-1']));
	assert.equal(code, 0, lines.join('\n'));
	const grades: Record<string, SampledGrade> = saved(evalDir).runs[0].grades;

	// Only sample 0 finds something: one sample of three is no majority, but it is enough for a union.
	assert.equal(grades.majority.status, 'ok');
	assert.equal(grades.majority.flagged, false);
	assert.deepEqual(grades.majority.findings, [{ ...HARD_CODED, sample: 0 }]);
	assert.equal(grades.union.flagged, true);
	assert.deepEqual(grades.union.findings, [{ ...HARD_CODED, sample: 0 }]);
	// One summary per sample, and the cost of the grade is the sum of the sample costs.
	assert.deepEqual(grades.majority.samples!.map(({ status, findings, costUsd }) => ({ status, findings, costUsd })), [
		{ status: 'ok', findings: 1, costUsd: 0.4 },
		{ status: 'ok', findings: 0, costUsd: 0.4 },
		{ status: 'ok', findings: 0, costUsd: 0.4 }
	]);
	for (const sample of grades.majority.samples!) assert.equal(typeof sample.durationMs, 'number');
	near(grades.majority.costUsd, 1.2);
	// One sample: flagged is set too, and the grade keeps the shape it had before samples existed.
	assert.equal(grades.review.flagged, true);
	assert.deepEqual(grades.review.findings, [HARD_CODED]);
	assert.equal('samples' in grades.review, false);

	// The samples of a grade share its id and its clone, and each knows its index.
	const views = seen(specDir).filter((view) => view.id === grades.majority.id);
	assert.deepEqual(views.map((view) => view.env.EVAL_SAMPLE).sort(), ['0', '1', '2']);
	assert.equal(new Set(views.map((view) => view.cwd)).size, 1);
	assert.equal(seen(specDir).find((view) => view.id === grades.review.id).env.EVAL_SAMPLE, '0');
	assert.match(readFileSync(join(evalDir, 'runs', 'zebra-config-1', 'grade-majority.log'), 'utf8'), /\[sample 0\][^]*\[sample 1\][^]*\[sample 2\]/);

	// The stats count the flagged runs, and the findings of the union.
	const stats = saved(evalDir).configs[0].grades;
	assert.deepEqual(stats.majority, { graded: 1, withFindings: 0, findings: 1, bySeverity: { minor: 1 } });
	assert.deepEqual(stats.union, { graded: 1, withFindings: 1, findings: 1, bySeverity: { minor: 1 } });

	assert.ok(lines.some((line) => /^\[\d\/3\] [0-9a-f]{8} majority ok, 3\/3 samples, not flagged, 1 finding, 1\.2 \$$/.test(line)), lines.join('\n'));
	assert.ok(lines.some((line) => /^\[\d\/3\] [0-9a-f]{8} union ok, 3\/3 samples, flagged, 1 finding, 1\.2 \$$/.test(line)), lines.join('\n'));
	assert.ok(lines.some((line) => /^\[\d\/3\] [0-9a-f]{8} review ok, 1 finding, 0\.4 \$$/.test(line)), lines.join('\n'));

	// A second pass reuses the whole grade from the cache.
	const again = await quiet(() => main([evalDir, '--runs', 'zebra-config-1']));
	assert.equal(seen(specDir).length, 7);
	const cached: SampledGrade = saved(evalDir).runs[0].grades.majority;
	assert.equal(cached.cached, true);
	assert.equal(cached.samples!.length, 3);
	assert.ok(again.lines.some((line) => / majority ok, 3\/3 samples, not flagged, 1 finding, cached$/.test(line)), again.lines.join('\n'));
});

test('a failing sample among ok ones keeps the grade ok; without a majority of ok samples the grade is an error', async () => {
	const { evalDir } = await fixture('flaky', [{ ...review('fail-second'), name: 'flaky', samples: 3 }, { ...review('fail-second'), name: 'even', samples: 2 }]);
	const { code } = await quiet(() => main([evalDir, '--runs', 'zebra-config-1']));
	assert.equal(code, 1);
	const grades: Record<string, SampledGrade> = saved(evalDir).runs[0].grades;
	assert.equal(grades.flaky.status, 'ok');
	assert.equal(grades.flaky.flagged, true);
	assert.deepEqual(grades.flaky.samples!.map((sample) => sample.status), ['ok', 'error', 'ok']);
	assert.match(grades.flaky.samples![1].note!, /exit code 3.*boom/);
	assert.deepEqual(grades.flaky.findings.map((finding) => finding.sample), [0, 2]);
	near(grades.flaky.costUsd, 0.8);
	// One ok sample of two is no majority.
	assert.equal(grades.even.status, 'error');
	assert.match(grades.even.note!, /exit code 3.*boom/);
	assert.deepEqual(grades.even.samples!.map((sample) => sample.status), ['ok', 'error']);
});

test('the budget stops a grade between two samples, and a grade with no sample run gets the status budget', async () => {
	// A sample costs 0.4 $: two samples reach the 0.5 $ budget, so the third sample and the next grade do not run.
	const { specDir, evalDir } = await fixture('sample-budget', [{ ...review('ok'), samples: 3 }], { gradersUsd: 0.5 });
	assert.equal((await quiet(() => main([evalDir]))).code, 0);
	assert.equal(seen(specDir).length, 2);
	const grades: SampledGrade[] = saved(evalDir).runs.flatMap((run: { grades: { review: SampledGrade } }) => (run.grades.review.status === 'skipped' ? [] : [run.grades.review]));
	const partial = grades.find((grade) => grade.status === 'ok')!;
	assert.deepEqual(partial.samples!.map((sample) => sample.status), ['ok', 'ok', 'budget']);
	near(partial.costUsd, 0.8);
	assert.match(partial.note!, /2 of 3 samples/);
	const stopped = grades.find((grade) => grade.status !== 'ok')!;
	assert.equal(stopped.status, 'budget');
	// A grade with a sample cut by the budget does not go to the cache: the next pass runs all its samples.
	assert.equal(existsSync(join(evalDir, '..', 'cache', 'grades')), false);
});

test('samples 1 and merge majority keep the cache key of a grader without them', async () => {
	const { specDir, evalDir } = await fixture('sample-key', [review('ok')]);
	assert.equal((await quiet(() => main([evalDir, '--runs', 'zebra-config-1']))).code, 0);
	const ev = saved(evalDir);
	ev.spec.graders = [review('ok', { samples: 1, merge: 'majority' })];
	writeFileSync(join(evalDir, 'eval.json'), JSON.stringify(ev));
	// A grade from the cache of an older version has no flagged: the runner sets it from the findings.
	const cacheDir = join(evalDir, '..', 'cache', 'grades');
	for (const file of readdirSync(cacheDir)) {
		const entry = JSON.parse(readFileSync(join(cacheDir, file), 'utf8'));
		delete entry.grade.flagged;
		writeFileSync(join(cacheDir, file), JSON.stringify(entry));
	}
	assert.equal((await quiet(() => main([evalDir, '--runs', 'zebra-config-1']))).code, 0);
	assert.equal(seen(specDir).length, 1);
	assert.equal(saved(evalDir).runs[0].grades.review.cached, true);
	assert.equal(saved(evalDir).runs[0].grades.review.flagged, true);
});
