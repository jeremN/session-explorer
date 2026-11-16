// Run cache: a finished run is reused when the agent would get the same thing again. The key holds the task (base
// commit, prompt, check, hidden tests), the config without its name, and the CLI version. A file of the config counts
// by its content, so a skill or a CLAUDE.md that changes gives a new key.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { Spec } from './spec.ts';
import type { RunRecord } from './stats.ts';

// Bump it when the runner changes what a run measures.
const SCHEMA = 'eval-runner-cache/v1';
const KEPT: ReadonlySet<RunRecord['status']> = new Set(['ok', 'timeout', 'budget']);

export type CacheEntry = { evalId: string; record: RunRecord };

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

// A directory counts by the path and content of every file in it, in sorted order.
function contentOf(path: string): string {
	if (!existsSync(path)) return 'missing';
	if (!statSync(path).isDirectory()) return sha(readFileSync(path));
	const files = (readdirSync(path, { recursive: true }) as string[]).map(String).filter((name) => statSync(join(path, name)).isFile()).sort();
	return sha(files.map((name) => `${name}\0${sha(readFileSync(join(path, name)))}`).join('\n'));
}

export function cacheKey({ task, baseSha, config, cliVersion }: { task: Spec['task']; baseSha: string; config: Record<string, unknown>; cliVersion: string }) {
	const { name: _name, ...rest } = config;
	const files: Record<string, unknown> = { ...rest };
	const claudeMd = rest.claudeMd as { file?: string } | undefined;
	if (claudeMd?.file) files.claudeMd = { content: contentOf(claudeMd.file) };
	for (const field of ['settings', 'mcpConfig'] as const) if (typeof rest[field] === 'string') files[field] = { content: contentOf(rest[field] as string) };
	for (const field of ['skills', 'plugins'] as const) if (Array.isArray(rest[field])) files[field] = (rest[field] as string[]).map((path) => contentOf(path));
	const prompt = task.prompt ?? (task.promptFile ? contentOf(task.promptFile) : '');
	return sha(JSON.stringify({ schema: SCHEMA, baseSha, prompt, timeoutSec: task.timeoutSec, acceptance: task.acceptance, hiddenTests: task.hiddenTests ?? null, config: files, cliVersion }));
}

export function readCache(dir: string, key: string): CacheEntry[] {
	const file = join(dir, `${key}.jsonl`);
	if (!existsSync(file)) return [];
	return readFileSync(file, 'utf8')
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line) as CacheEntry);
}

export function writeCache(dir: string, key: string, evalId: string, records: RunRecord[]) {
	const kept = records.filter((record) => KEPT.has(record.status));
	if (kept.length === 0) return;
	mkdirSync(dir, { recursive: true });
	appendFileSync(join(dir, `${key}.jsonl`), kept.map((record) => `${JSON.stringify({ evalId, record })}\n`).join(''));
}
