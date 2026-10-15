// Context tracer v1: does a Claude session search the brain before it edits a repository?
// One verdict per task. A task opens at a user prompt and closes at the first prompt that
// follows an edit, so "plan, then go" is one task.
// Usage: node tracer.ts [--days 30] [--projects <regex>] [--json]
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type TaskTrace = { start: string; brain: 'before' | 'after' | 'never'; memory: boolean };
export type TaskSpan = TaskTrace & { end: string; editAt: string; brainAt?: string; memoryAt?: string };
type EventKind = 'brain' | 'memory' | 'edit';
type Counts = { tasks: number; before: number; after: number; never: number; memory: number };

// The knowledge base ("brain") is set in the config file. Without it, only an unscoped qmd search counts as a brain search.
export type Config = {
	projects?: string;
	brain?: { paths?: string[]; repositories?: string[]; collections?: string[]; wikiDirectories?: string[] };
	memory?: { collections?: string[] };
};
const NEVER = /(?!)/;
const anyOf = (patterns: string[]) => (patterns.length === 0 ? NEVER : new RegExp(patterns.join('|')));
function compile(config: Config) {
	const brainPath = anyOf(config.brain?.paths ?? []);
	// `repositories` widens the edit exclusion to the whole brain repository. It defaults to the search paths.
	const repositories = anyOf(config.brain?.repositories ?? config.brain?.paths ?? []);
	const brainOrHome = repositories === NEVER ? '' : `|${repositories.source}`;
	return {
		brainPath,
		brainCollections: new Set(config.brain?.collections ?? []),
		// qmd accepts a path without its collection. The first directory then names the brain wiki.
		brainWikiDirectories: new Set(config.brain?.wikiDirectories ?? []),
		memoryCollections: new Set(config.memory?.collections ?? []),
		// The home `.claude` holds plans and memory. A repository `.claude/worktrees` holds code.
		// An edit in a brain repository writes the brain. It is not a task that should search it.
		notARepository: new RegExp(`^\\/(?:Users|home)\\/[^/]+\\/\\.claude\\/|^\\/(?:private\\/)?tmp\\/${brainOrHome}`),
		shellNotARepository: new RegExp(`(?:~|\\$HOME|\\/(?:Users|home)\\/[^/\\s]+)\\/\\.claude\\/|\\/tmp\\/${brainOrHome}`)
	};
}
let knowledge = compile({});
export function configureKnowledge(config: Config) {
	knowledge = compile(config);
}
// Read from `$SESSION_EXPLORER_CONFIG`, else `~/.config/session-explorer/config.json`. A missing file gives the defaults.
export function loadConfig(): Config {
	const path = process.env.SESSION_EXPLORER_CONFIG ?? join(homedir(), '.config', 'session-explorer', 'config.json');
	const config: Config = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
	configureKnowledge(config);
	return config;
}
const MEMORY_PATH = /\/\.claude\/projects\/[^/\s]+\/memory\//;
const QMD_SEARCH = /(?:^|[;&|(\n])\s*qmd\s+(?:query|search|vsearch|get|multi-get)\b/;
const QMD_COLLECTION = /(?:-c|--collection)[\s=]+["']?([\w-]+)/g;
const HEREDOC = /<<-?\s*["']?(\w+)["']?[\s\S]*?(?:\n\1(?=\s|$)|$)/g;
const SHELL_READER = /(?:^|\|)\s*(?:grep|rg|cat)\b/;
const SHELL_IN_PLACE = /\bsed\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*i(?=[\s.']|$)|\bperl\s+(?:-\S+\s+)*-[a-zA-Z0-9]*i(?=[\s.]|$)/;

const text = (value: unknown) => (typeof value === 'string' ? value : '');

function knowledgeSource(collections: string[]): EventKind | undefined {
	if (collections.length === 0 || collections.some((name) => knowledge.brainCollections.has(name))) return 'brain';
	return collections.some((name) => knowledge.memoryCollections.has(name)) ? 'memory' : undefined;
}

// A statement reads `path` when a reader command names the path, or runs after a `cd` into it.
function shellReads(statements: string[], path: RegExp) {
	const insidePath = statements.some((statement) => /^cd\s/.test(statement) && path.test(statement));
	const writesToPath = new RegExp(`>\\s*\\S*(?:${path.source})`);
	return statements.some(
		(statement) => SHELL_READER.test(statement) && !writesToPath.test(statement) && (insidePath || path.test(statement))
	);
}

function classifyShell(rawCommand: string): EventKind | undefined {
	const command = rawCommand.replace(HEREDOC, '');
	if (QMD_SEARCH.test(command)) return knowledgeSource([...command.matchAll(QMD_COLLECTION)].map((match) => match[1]));
	const statements = command.split(/;|&&|\|\||\n/).map((statement) => statement.trim().replace(/^(?:do|then)\s+/, ''));
	if (shellReads(statements, knowledge.brainPath)) return 'brain';
	if (shellReads(statements, MEMORY_PATH)) return 'memory';
	return SHELL_IN_PLACE.test(command) && !knowledge.shellNotARepository.test(command) ? 'edit' : undefined;
}

export function classify(name: string, input: Record<string, unknown>): EventKind | undefined {
	if (name.startsWith('mcp__plugin_qmd_qmd__')) {
		if (/__(?:get|multi_get)$/.test(name)) {
			const collection = (text(input.file) || text(input.pattern)).replace(/^qmd:\/\//, '').split('/')[0];
			if (knowledge.brainWikiDirectories.has(collection)) return 'brain';
			return knowledge.memoryCollections.has(collection) || knowledge.brainCollections.has(collection) ? knowledgeSource([collection]) : undefined;
		}
		if (!name.endsWith('__query')) return undefined;
		const collections = [input.collection, ...(Array.isArray(input.collections) ? input.collections : [])].filter(
			(value) => typeof value === 'string'
		);
		return knowledgeSource(collections);
	}
	if (name === 'Bash') return classifyShell(text(input.command));
	if (name === 'Read' || name === 'Grep' || name === 'Glob') {
		const path = text(input.file_path) || text(input.path);
		if (knowledge.brainPath.test(path)) return 'brain';
		return MEMORY_PATH.test(path) ? 'memory' : undefined;
	}
	if (name === 'Edit' || name === 'Write' || name === 'NotebookEdit') {
		const path = text(input.file_path) || text(input.notebook_path);
		return path && !knowledge.notARepository.test(path) ? 'edit' : undefined;
	}
	return undefined;
}

export function isUserPrompt(entry: Record<string, any>) {
	const content = entry.message?.content;
	return entry.type === 'user' && !entry.isMeta && !entry.isSidechain && !entry.isCompactSummary && typeof content === 'string' && !content.startsWith('<');
}

// `entries` holds the parsed lines of one session and of its subagents, in any order.
export function traceTasks(entries: unknown[]): { start: string | undefined; tasks: TaskSpan[] } {
	const events: Array<{ timestamp: string; kind: EventKind | 'prompt' }> = [];
	let start: string | undefined;
	let last = '';
	for (const entry of entries as Array<Record<string, any>>) {
		const timestamp = text(entry?.timestamp);
		if (!timestamp) continue;
		if (start === undefined || timestamp < start) start = timestamp;
		if (timestamp > last) last = timestamp;
		if (isUserPrompt(entry)) events.push({ timestamp, kind: 'prompt' });
		const content = entry.type === 'assistant' ? entry.message?.content : undefined;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (block?.type !== 'tool_use') continue;
			const kind = classify(text(block.name), block.input ?? {});
			if (kind) events.push({ timestamp, kind });
		}
	}
	events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

	const tasks: TaskSpan[] = [];
	type OpenTask = { start: string; brain?: string; memory?: string; edit?: string };
	let open: OpenTask | undefined;
	const close = (end: string) => {
		if (open?.edit === undefined) return;
		const { brain, memory, edit } = open;
		tasks.push({
			start: open.start,
			end,
			brain: brain === undefined ? 'never' : brain < edit ? 'before' : 'after',
			memory: memory !== undefined && memory < edit,
			editAt: edit,
			...(brain === undefined ? {} : { brainAt: brain }),
			...(memory === undefined ? {} : { memoryAt: memory })
		});
		open = undefined;
	};
	for (const { timestamp, kind } of events) {
		if (kind === 'prompt') {
			close(timestamp);
			open ??= { start: timestamp };
			continue;
		}
		open ??= { start: timestamp };
		open[kind] ??= timestamp;
	}
	close(last);
	return { start, tasks };
}

export function traceSession(entries: unknown[]): { start: string | undefined; tasks: TaskTrace[] } {
	const { start, tasks } = traceTasks(entries);
	return { start, tasks: tasks.map(({ start, brain, memory }) => ({ start, brain, memory })) };
}

function isoWeek(timestamp: string) {
	const date = new Date(timestamp);
	const thursday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
	thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7));
	const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
	const week = Math.ceil(((thursday.getTime() - yearStart) / 86_400_000 + 1) / 7);
	return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

const emptyCounts = (): Counts => ({ tasks: 0, before: 0, after: 0, never: 0, memory: 0 });
const share = (part: number, whole: number) => (whole === 0 ? 0 : Math.round((part / whole) * 100) / 100);

export function summarize(tasks: TaskTrace[]) {
	const total = emptyCounts();
	const byWeek = new Map<string, Counts>();
	for (const task of tasks) {
		const week = isoWeek(task.start);
		const counts = byWeek.get(week) ?? emptyCounts();
		byWeek.set(week, counts);
		for (const bucket of [counts, total]) {
			bucket.tasks += 1;
			bucket[task.brain] += 1;
			if (task.memory) bucket.memory += 1;
		}
	}
	return {
		weeks: [...byWeek].sort(([a], [b]) => a.localeCompare(b)).map(([week, counts]) => ({ week, ...counts })),
		total,
		brainBeforeShare: share(total.before, total.tasks),
		memoryBeforeShare: share(total.memory, total.tasks)
	};
}

export function readLines(file: string): unknown[] {
	const entries: unknown[] = [];
	for (const line of readFileSync(file, 'utf8').split('\n')) {
		if (!line) continue;
		try {
			entries.push(JSON.parse(line));
		} catch {
			// A session that is still being written can end on a partial line.
		}
	}
	return entries;
}

export function listJsonl(directory: string) {
	try {
		return readdirSync(directory)
			.filter((name) => name.endsWith('.jsonl'))
			.map((name) => join(directory, name));
	} catch {
		return [];
	}
}

function main() {
	const argument = (flag: string) => {
		const index = process.argv.indexOf(flag);
		return index === -1 ? undefined : process.argv[index + 1];
	};
	const days = Number(argument('--days') ?? 30);
	const config = loadConfig();
	const projects = new RegExp(argument('--projects') ?? config.projects ?? '.');
	const root = join(homedir(), '.claude', 'projects');
	const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();

	const sessions: Array<{ id: string; project: string; start: string; tasks: TaskTrace[] }> = [];
	for (const project of readdirSync(root).filter((name) => projects.test(name))) {
		for (const file of listJsonl(join(root, project))) {
			const subagents = listJsonl(join(file.slice(0, -'.jsonl'.length), 'subagents'));
			const { start, tasks } = traceSession([file, ...subagents].flatMap(readLines));
			if (start === undefined || start < cutoff) continue;
			sessions.push({ id: file.slice(file.lastIndexOf('/') + 1, -'.jsonl'.length), project, start, tasks });
		}
	}

	const summary = summarize(sessions.flatMap((session) => session.tasks));
	if (process.argv.includes('--json')) {
		const result = { schema: 'harness/v1', tool: 'context-tracer', generatedAt: new Date().toISOString(), days, ...summary, sessions };
		console.log(JSON.stringify(result, null, 2));
		return;
	}
	const withTask = sessions.filter((session) => session.tasks.length > 0).length;
	console.log(`Tasks in the last ${days} days: ${summary.total.tasks}, from ${withTask} of ${sessions.length} sessions`);
	console.table([...summary.weeks, { week: 'total', ...summary.total }]);
	console.log(`Brain searched before the first edit: ${Math.round(summary.brainBeforeShare * 100)} % of the tasks`);
	console.log(`Memory read before the first edit: ${Math.round(summary.memoryBeforeShare * 100)} % of the tasks`);
}

if (import.meta.main) main();
