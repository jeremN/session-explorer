import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, test } from 'node:test';

import { compare, diffConfigs, headVersion, main } from './diff.ts';
import { realExec } from './exec.ts';
import type { ConfigStats } from './stats.ts';

const root = mkdtempSync(join(tmpdir(), 'eval-diff-'));
after(() => rmSync(root, { recursive: true, force: true }));

const stats = (passed: number, n: number, cost: number[], extra: Record<string, number[]> = {}): ConfigStats => {
	const spread = (values: number[]) => ({ n: values.length, median: [...values].sort((a, b) => a - b)[values.length >> 1], min: Math.min(...values), max: Math.max(...values), values });
	return { pass: { passed, n }, metrics: { cost: spread(cost), ...Object.fromEntries(Object.entries(extra).map(([key, values]) => [key, spread(values)])) } };
};

test('compare: the same pass count is no change, a gap of half the runs or more is clear, a smaller gap is borderline', () => {
	assert.equal(compare(stats(3, 3, [0.1, 0.1, 0.1]), stats(3, 3, [0.1, 0.1, 0.1])).verdict, 'same');
	assert.equal(compare(stats(3, 3, [0.1, 0.1, 0.1]), stats(1, 3, [0.1, 0.1, 0.1])).verdict, 'worse');
	assert.equal(compare(stats(1, 3, [0.1, 0.1, 0.1]), stats(3, 3, [0.1, 0.1, 0.1])).verdict, 'better');
	assert.equal(compare(stats(3, 3, [0.1, 0.1, 0.1]), stats(2, 3, [0.1, 0.1, 0.1])).verdict, 'borderline');
});

test('compare: a metric is flagged only when the median after the change is outside the range of the runs before it', () => {
	const result = compare(stats(3, 3, [0.08, 0.1, 0.12], { wallSec: [10, 12, 14] }), stats(3, 3, [0.11, 0.11, 0.11], { wallSec: [20, 21, 22] }));
	const row = (key: string) => result.metrics.find((metric) => metric.key === key)!;
	assert.deepEqual([row('cost').before, row('cost').after, row('cost').outside], [0.1, 0.11, false]);
	assert.deepEqual([row('wallSec').before, row('wallSec').after, row('wallSec').outside], [12, 21, true]);
	const cheaper = compare(stats(3, 3, [0.08, 0.1, 0.12]), stats(3, 3, [0.05, 0.05, 0.05]));
	assert.equal(cheaper.metrics.find((metric) => metric.key === 'cost')!.outside, true);
});

test('diffConfigs: a CLAUDE.md or an AGENTS.md becomes claudeMd, a skill directory replaces the skill of the same name', () => {
	const template = { name: 'baseline', model: 'sonnet', skills: ['/s/skills/other', '/s/skills/tidy'] };
	assert.deepEqual(diffConfigs(template, { kind: 'claudeMd', path: '/r/AGENTS.md', head: 'old rules\n' }), [
		{ name: 'before', model: 'sonnet', skills: ['/s/skills/other', '/s/skills/tidy'], claudeMd: { text: 'old rules\n' } },
		{ name: 'after', model: 'sonnet', skills: ['/s/skills/other', '/s/skills/tidy'], claudeMd: { file: '/r/AGENTS.md' } }
	]);
	const [before, afterChange] = diffConfigs(template, { kind: 'skill', path: '/r/.claude/skills/tidy', head: '/tmp/x/tidy' });
	assert.deepEqual(before.skills, ['/s/skills/other', '/tmp/x/tidy']);
	assert.deepEqual(afterChange.skills, ['/s/skills/other', '/r/.claude/skills/tidy']);
	const [newBefore] = diffConfigs(template, { kind: 'skill', path: '/r/.claude/skills/tidy', head: undefined });
	assert.deepEqual(newBefore.skills, ['/s/skills/other']);
});

test('headVersion reads a file or a skill directory at HEAD, and gives undefined for a new file', async () => {
	const repo = join(root, 'repo');
	mkdirSync(join(repo, 'skills', 'tidy', 'refs'), { recursive: true });
	const git = async (...args: string[]) => assert.equal((await realExec('git', args, { cwd: repo })).code, 0);
	await git('init', '-q', '-b', 'main');
	await git('config', 'user.email', 'test@localhost');
	await git('config', 'user.name', 'test');
	writeFileSync(join(repo, 'CLAUDE.md'), 'old\n');
	writeFileSync(join(repo, 'skills', 'tidy', 'SKILL.md'), '# old skill\n');
	writeFileSync(join(repo, 'skills', 'tidy', 'refs', 'a.md'), 'ref\n');
	await git('add', '-A');
	await git('commit', '-q', '-m', 'init');
	writeFileSync(join(repo, 'CLAUDE.md'), 'new\n');
	writeFileSync(join(repo, 'skills', 'tidy', 'SKILL.md'), '# new skill\n');
	writeFileSync(join(repo, 'NEW.md'), 'x\n');

	assert.deepEqual(await headVersion(realExec, join(repo, 'CLAUDE.md'), join(root, 'work1')), { kind: 'claudeMd', path: realpathSync(join(repo, 'CLAUDE.md')), head: 'old\n' });
	const skill = await headVersion(realExec, join(repo, 'skills', 'tidy'), join(root, 'work2'));
	assert.equal(skill.kind, 'skill');
	assert.equal(basename(skill.head!), 'tidy');
	assert.equal(readFileSync(join(skill.head!, 'SKILL.md'), 'utf8'), '# old skill\n');
	assert.equal(readFileSync(join(skill.head!, 'refs', 'a.md'), 'utf8'), 'ref\n');
	assert.equal((await headVersion(realExec, join(repo, 'NEW.md'), join(root, 'work3'))).head, undefined);
});

test('eval diff runs before and after on the spec, writes diff.json, and stops at the first round when nothing changes', async () => {
	const repo = join(root, 'task-repo');
	mkdirSync(repo);
	const git = async (cwd: string, ...args: string[]) => assert.equal((await realExec('git', args, { cwd })).code, 0);
	await git(repo, 'init', '-q', '-b', 'main');
	await git(repo, 'config', 'user.email', 'test@localhost');
	await git(repo, 'config', 'user.name', 'test');
	writeFileSync(join(repo, 'a.txt'), 'one\n');
	writeFileSync(join(repo, 'CLAUDE.md'), 'old rules\n');
	await git(repo, 'add', '-A');
	await git(repo, 'commit', '-q', '-m', 'init');
	writeFileSync(join(repo, 'CLAUDE.md'), 'new rules\n');
	const spec = join(root, 'diff-spec.json');
	// The check script sits next to the spec, as in the examples: $EVAL_SPEC_DIR must name the folder of the spec.
	writeFileSync(join(root, 'check.sh'), 'grep -q "agent was here" agent-output.txt\n');
	writeFileSync(spec, JSON.stringify({ name: 'diff', task: { repo, prompt: 'x', timeoutSec: 60, acceptance: { command: 'sh "$EVAL_SPEC_DIR/check.sh"' } }, budget: { perRunUsd: 1, perEvalUsd: 30 }, configs: [{ name: 'baseline' }] }));
	const out = join(root, 'out');
	const previous = { projects: process.env.EVAL_RUNNER_PROJECTS_DIR, tmp: process.env.TMPDIR };
	process.env.EVAL_RUNNER_PROJECTS_DIR = join(root, 'projects');
	mkdirSync(process.env.EVAL_RUNNER_PROJECTS_DIR, { recursive: true });
	try {
		const code = await main([spec, '--file', join(repo, 'CLAUDE.md'), '--claude', join(import.meta.dirname, 'fixtures', 'fake-claude.mjs'), '--out', out]);
		assert.equal(code, 0);
		const evals = readdirSync(out).filter((name) => existsSync(join(out, name, 'diff.json')));
		assert.equal(evals.length, 1);
		const report = JSON.parse(readFileSync(join(out, evals[0], 'diff.json'), 'utf8'));
		assert.equal(report.verdict, 'same');
		assert.deepEqual(report.pass.before, { passed: 3, n: 3 });
		assert.equal(report.runs, 3);
		assert.deepEqual(report.file, realpathSync(join(repo, 'CLAUDE.md')));
	} finally {
		process.env.EVAL_RUNNER_PROJECTS_DIR = previous.projects;
	}
});
