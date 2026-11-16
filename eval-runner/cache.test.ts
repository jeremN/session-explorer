import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { cacheKey, readCache, writeCache } from './cache.ts';
import type { Spec } from './spec.ts';
import type { RunRecord } from './stats.ts';

const root = mkdtempSync(join(tmpdir(), 'eval-cache-'));
after(() => rmSync(root, { recursive: true, force: true }));

const task: Spec['task'] = { repo: '/r', base: 'HEAD', prompt: 'Fix it.', timeoutSec: 900, acceptance: { command: 'npm test', timeoutSec: 300 } };
const key = (overrides: { task?: Partial<Spec['task']>; config?: Record<string, unknown>; baseSha?: string; cli?: string; specDir?: string } = {}) =>
	cacheKey({ task: { ...task, ...overrides.task }, baseSha: overrides.baseSha ?? 'abc', config: { name: 'a', model: 'sonnet', ...overrides.config }, cliVersion: overrides.cli ?? '2.1.325', specDir: overrides.specDir ?? '/specs' });

test('the key ignores the config name and the repo path, and changes with what the agent gets', () => {
	const same = key();
	assert.match(same, /^[0-9a-f]{64}$/);
	assert.equal(key({ config: { name: 'other' } }), same);
	assert.equal(key({ task: { repo: '/elsewhere', base: 'main' } }), same);
	assert.notEqual(key({ baseSha: 'def' }), same);
	assert.notEqual(key({ task: { prompt: 'Fix it now.' } }), same);
	assert.notEqual(key({ task: { acceptance: { command: 'npm run check', timeoutSec: 300 } } }), same);
	assert.notEqual(key({ task: { hiddenTests: { commit: 'x', paths: ['a.test.ts'] } } }), same);
	assert.notEqual(key({ config: { model: 'opus' } }), same);
	assert.notEqual(key({ config: { claudeMd: { text: 'Be terse.' } } }), same);
	assert.notEqual(key({ cli: '2.1.326' }), same);
	// The acceptance command finds its scripts through EVAL_SPEC_DIR.
	assert.notEqual(key({ specDir: '/other' }), same);
});

test('a referenced file counts by its content, not by its path', () => {
	const dir = join(root, 'files');
	mkdirSync(join(dir, 'skill', 'refs'), { recursive: true });
	writeFileSync(join(dir, 'a.md'), 'Be terse.\n');
	writeFileSync(join(dir, 'b.md'), 'Be terse.\n');
	writeFileSync(join(dir, 'skill', 'SKILL.md'), '# skill\n');
	writeFileSync(join(dir, 'skill', 'refs', 'x.md'), 'one\n');
	const byFile = key({ config: { claudeMd: { file: join(dir, 'a.md') }, skills: [join(dir, 'skill')] } });
	assert.equal(key({ config: { claudeMd: { file: join(dir, 'b.md') }, skills: [join(dir, 'skill')] } }), byFile);
	writeFileSync(join(dir, 'skill', 'refs', 'x.md'), 'two\n');
	assert.notEqual(key({ config: { claudeMd: { file: join(dir, 'a.md') }, skills: [join(dir, 'skill')] } }), byFile);
	writeFileSync(join(dir, 'a.md'), 'Be brief.\n');
	assert.notEqual(key({ config: { claudeMd: { file: join(dir, 'a.md') }, skills: [join(dir, 'skill')] } }), byFile);
});

test('readCache returns the finished runs of a key, newest last; error and skipped runs are not kept', () => {
	const cache = join(root, 'cache');
	const run = (id: string, status: RunRecord['status']): RunRecord => ({ id, config: 'a', status });
	writeCache(cache, 'k1', 'e1', [run('a-1', 'ok'), run('a-2', 'error'), run('a-3', 'skipped'), run('a-4', 'timeout')]);
	writeCache(cache, 'k1', 'e2', [run('a-1', 'budget')]);
	assert.deepEqual(
		readCache(cache, 'k1').map((entry) => [entry.evalId, entry.record.id, entry.record.status]),
		[['e1', 'a-1', 'ok'], ['e1', 'a-4', 'timeout'], ['e2', 'a-1', 'budget']]
	);
	assert.deepEqual(readCache(cache, 'missing'), []);
});
