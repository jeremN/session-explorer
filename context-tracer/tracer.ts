// Context tracer v1: does a Claude session search the brain before it edits a repository?
// One verdict per task. A task opens at a user prompt and closes at the first prompt that
// follows an edit, so "plan, then go" is one task.
// Usage: node tracer.ts [--days 30] [--projects <regex>] [--json]
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type TaskTrace = { start: string; brain: 'before' | 'after' | 'never'; memory: boolean };
// `verified`: a test, build, lint or typecheck command ran after the last edit of the task.
// `check`: the result of that last command. 'unknown' when no result row exists (interrupted, still running).
export type Check = 'passed' | 'failed' | 'unknown';
export type TaskSpan = TaskTrace & { end: string; editAt: string; brainAt?: string; memoryAt?: string; verified: boolean; verifiedAt?: string; check?: Check };
type EventKind = 'brain' | 'memory' | 'edit' | 'verify';
type Counts = { tasks: number; before: number; after: number; never: number; memory: number };

// The knowledge base ("brain") is set in the config file. Without it, only an unscoped qmd search counts as a brain search.
export type Config = {
	projects?: string;
	brain?: { paths?: string[]; repositories?: string[]; collections?: string[]; wikiDirectories?: string[] };
	memory?: { collections?: string[] };
	commands?: CommandPatterns;
};
// Regular expressions that add to the default patterns of a command class. Each one is tested on every segment of a shell call.
export type CommandPatterns = { test?: string[]; types?: string[]; lint?: string[]; build?: string[] };
export function mergeCommands(...sources: Array<CommandPatterns | undefined>): CommandPatterns {
	const merged: CommandPatterns = {};
	for (const name of ['test', 'types', 'lint', 'build'] as const) {
		const patterns = sources.flatMap((source) => source?.[name] ?? []);
		if (patterns.length) merged[name] = patterns;
	}
	return merged;
}
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
		commands: {
			test: (config.commands?.test ?? []).map((pattern) => new RegExp(pattern)),
			types: (config.commands?.types ?? []).map((pattern) => new RegExp(pattern)),
			lint: (config.commands?.lint ?? []).map((pattern) => new RegExp(pattern)),
			build: (config.commands?.build ?? []).map((pattern) => new RegExp(pattern))
		},
		// The home `.claude` holds plans and memory. A repository `.claude/worktrees` holds code.
		// An edit in a brain repository writes the brain. It is not a task that should search it.
		// A clone of the eval runner sits under /tmp on Linux (os.tmpdir()). It is a repository, not a scratch file.
		notARepository: new RegExp(`^\\/(?:Users|home)\\/[^/]+\\/\\.claude\\/|^\\/(?:private\\/)?tmp\\/(?!(?:\\S*\\/)?eval-runner\\/)${brainOrHome}`),
		shellNotARepository: new RegExp(`(?:~|\\$HOME|\\/(?:Users|home)\\/[^/\\s]+)\\/\\.claude\\/|\\/tmp\\/(?!(?:\\S*\\/)?eval-runner\\/)${brainOrHome}`)
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

// Command classes of a shell call. The call is cut into segments at `&&`, `||`, `;`, `|`, `&` and new lines, outside
// quotes. Each segment gets classes, and the call counts in every class of its segments, in the order they come.
// A call with no class is `other`. A test, types, lint or build segment checks the code: it is a verify event.
export const COMMAND_CLASSES = ['test', 'types', 'lint', 'build', 'edit', 'install', 'git', 'explore', 'other'] as const;
export type CommandClass = (typeof COMMAND_CLASSES)[number];
const VERIFY_CLASSES: ReadonlySet<CommandClass> = new Set(['test', 'types', 'lint', 'build']);
export const isVerifyClass = (name: string) => VERIFY_CLASSES.has(name as CommandClass);

type Segment = { text: string; piped: boolean };
// `piped`: the segment reads the output of the segment before it.
function segmentsOf(command: string): Segment[] {
	const segments: Segment[] = [];
	let current = '';
	let quote = '';
	let piped = false;
	const cut = (next: boolean) => {
		if (current.trim()) segments.push({ text: current.trim(), piped });
		current = '';
		piped = next;
	};
	for (let index = 0; index < command.length; index++) {
		const char = command[index];
		const next = command[index + 1];
		if (char === '\\') {
			current += char + (next ?? '');
			index++;
		} else if (quote) {
			if (char === quote) quote = '';
			current += char;
		} else if (char === "'" || char === '"') {
			quote = char;
			current += char;
		} else if ((char === '&' || char === '|') && next === char) {
			cut(false);
			index++;
		} else if (char === '|') {
			if (next === '&') index++;
			cut(true);
		} else if (char === ';' || char === '\n' || (char === '&' && !/[<>]/.test(command[index - 1] ?? '') && next !== '>')) {
			cut(false);
		} else {
			current += char;
		}
	}
	cut(false);
	return segments;
}

// Words before the command itself: a subshell, a loop body, a variable, a time limit.
const COMMAND_PREFIX = /^(?:[({!]\s*|(?:do|then|else|time|env|nohup|exec)\s+|\w+=\S*\s+|timeout\s+(?:-\S+\s+)*\d\S*\s+)/;
const QUOTED = /'[^']*'|"(?:\\.|[^"\\])*"/g;
const RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'npx', 'bunx']);
const VALUE_FLAGS = new Set(['--dir', '-C', '--filter', '-F', '--prefix', '--workspace', '--cwd', '--config']);
const INSTALL_SCRIPTS = new Set(['install', 'i', 'ci', 'add', 'remove', 'rm', 'uninstall', 'update', 'up']);
const EXPLORERS = new Set(['cat', 'head', 'tail', 'grep', 'rg', 'ls', 'find', 'wc']);
// A write to a source file. A log under /tmp or /dev is not an edit, but a clone of the eval runner under /tmp is.
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|svelte|vue|json|md|css|scss|html|ya?ml|py|go|rs|toml)$/;
const SCRATCH = /^(?:\/dev\/|(?:\/private)?\/tmp\/(?!(?:\S*\/)?eval-runner\/)|\$\{?TMPDIR)/;
const WRITE_TARGET = /(?:^|[^<>&\d])>>?\s*(?!&)([^\s;&|<>()]+)|\btee\s+(?:-\S+\s+)*([^\s;&|<>()]+)/g;

function binaryClasses(name: string, rest: string[]): CommandClass[] {
	if (['vitest', 'jest', 'mocha', 'pytest'].includes(name)) return ['test'];
	if (name === 'playwright' && rest[0] === 'test') return ['test'];
	if (name === 'node' && rest.includes('--test')) return ['test'];
	if (/^python3?$/.test(name) && rest[0] === '-m' && rest[1] === 'pytest') return ['test'];
	if (['tsc', 'vue-tsc', 'svelte-check', 'mypy', 'pyright'].includes(name)) return ['types'];
	if (['eslint', 'prettier', 'biome', 'ruff', 'oxlint'].includes(name)) return ['lint'];
	const sub = { cargo: { test: 'test', check: 'types', build: 'build', clippy: 'lint' }, go: { test: 'test', build: 'build', vet: 'lint' } } as Record<string, Record<string, CommandClass>>;
	const found = sub[name]?.[rest[0]];
	if (found) return [found];
	if (/^pip3?$/.test(name) && rest[0] === 'install') return ['install'];
	return [];
}

// The name of a package script: `test:unit`, `check:types`, `lint:fix`, `build`.
function scriptClasses(name: string): CommandClass[] {
	const classes: CommandClass[] = [];
	if (/(?:^|[:_-])(?:tests?|vitest|jest|e2e|spec)(?:$|[:_-])/.test(name)) classes.push('test');
	if (/typecheck|type-check|(?:^|[:_-])types?(?:$|[:_-])|(?:^|[:_-])tsc$|svelte-check/.test(name)) classes.push('types');
	if (/lint|prettier|^format/.test(name)) classes.push('lint');
	if (/^build(?:$|[:_-])/.test(name)) classes.push('build');
	// `check` alone is the type check of SvelteKit and of most templates.
	if (classes.length === 0 && /^check(?:$|:)/.test(name)) classes.push('types');
	return classes;
}

function runnerClasses(runner: string, rest: string[]): CommandClass[] {
	let index = 0;
	while (index < rest.length && rest[index].startsWith('-')) index += VALUE_FLAGS.has(rest[index]) || (runner === 'npm' && rest[index] === '-w') ? 2 : 1;
	if (runner === 'yarn' && rest[index] === 'workspace') index += 2;
	let binary = runner === 'npx' || runner === 'bunx';
	if (['exec', 'dlx', 'x'].includes(rest[index])) {
		binary = true;
		index++;
	} else if (rest[index] === 'run') index++;
	const name = rest[index];
	if (name === undefined) return runner === 'yarn' ? ['install'] : [];
	const after = rest.slice(index + 1);
	if (binary) return binaryClasses(name, after);
	if (INSTALL_SCRIPTS.has(name)) return ['install'];
	const found = binaryClasses(name, after);
	return found.length ? found : scriptClasses(name);
}

function writesSource(bare: string) {
	return [...bare.matchAll(WRITE_TARGET)].some((match) => {
		const target = match[1] ?? match[2];
		return SOURCE_FILE.test(target) && !SCRATCH.test(target) && !knowledge.shellNotARepository.test(target);
	});
}

function segmentClasses({ text: raw, piped }: Segment): CommandClass[] {
	let text = raw;
	for (let previous = ''; previous !== text; ) {
		previous = text;
		text = text.replace(COMMAND_PREFIX, '').replace(/\s*[)}]+\s*$/, '');
	}
	const classes: CommandClass[] = [];
	for (const name of ['test', 'types', 'lint', 'build'] as const) if (knowledge.commands[name].some((pattern) => pattern.test(text))) classes.push(name);
	const bare = text.replace(QUOTED, "''");
	const [head = '', ...rest] = bare.split(/\s+/);
	const name = head.replace(/^.*\//, '');
	classes.push(...(RUNNERS.has(name) ? runnerClasses(name, rest) : binaryClasses(name, rest)));
	if (name === 'git') classes.push('git');
	if (SHELL_IN_PLACE.test(bare) || writesSource(bare)) classes.push('edit');
	else if (!piped && (EXPLORERS.has(name) || (name === 'sed' && rest.includes('-n')))) classes.push('explore');
	return classes;
}

export function commandClasses(command: string): CommandClass[] {
	const classes = new Set(segmentsOf(command.replace(HEREDOC, '')).flatMap(segmentClasses));
	return classes.size ? [...classes] : ['other'];
}

// A check can exit with 0 and still fail: `pnpm test | tail` returns the exit code of `tail`. These lines report a failure.
// The auto mode classifier had no answer, so the call never ran. Its result is not an outcome of the command.
export const OUTAGE = /^The server-side auto mode classifier gave no verdict/;
export const FAILURE = /(?:^|\n)\s*(?:FAIL|✗|×)\s|\b[1-9]\d*\s+(?:failed|failing|errors?)\b|(?:^|\n)\s*(?:# fail|ℹ fail)\s+[1-9]|\berror TS\d{4}\b/;

const text = (value: unknown) => (typeof value === 'string' ? value : '');
export const resultText = (content: unknown) =>
	typeof content === 'string' ? content : Array.isArray(content) ? content.map((block) => text(block?.text)).join('\n') : '';

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
	if (SHELL_IN_PLACE.test(command) && !knowledge.shellNotARepository.test(command)) return 'edit';
	return commandClasses(command).some(isVerifyClass) ? 'verify' : undefined;
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
	const events: Array<{ timestamp: string; kind: EventKind | 'prompt'; id?: string }> = [];
	const results = new Map<string, Check>();
	const blocked = new Set<string>();
	let start: string | undefined;
	let last = '';
	for (const entry of entries as Array<Record<string, any>>) {
		const timestamp = text(entry?.timestamp);
		if (!timestamp) continue;
		if (start === undefined || timestamp < start) start = timestamp;
		if (timestamp > last) last = timestamp;
		if (isUserPrompt(entry)) events.push({ timestamp, kind: 'prompt' });
		const content = entry.message?.content;
		if (!Array.isArray(content)) continue;
		if (entry.type === 'user') {
			for (const block of content) {
				if (block?.type !== 'tool_result') continue;
				if (block.is_error && OUTAGE.test(resultText(block.content))) {
					blocked.add(text(block.tool_use_id));
					continue;
				}
				results.set(text(block.tool_use_id), block.is_error || FAILURE.test(resultText(block.content)) ? 'failed' : 'passed');
			}
			continue;
		}
		if (entry.type !== 'assistant') continue;
		for (const block of content) {
			if (block?.type !== 'tool_use') continue;
			const kind = classify(text(block.name), block.input ?? {});
			if (kind) events.push({ timestamp, kind, id: text(block.id) });
		}
	}
	// A call that the classifier outage blocked did not happen: it is neither an edit nor a check.
	if (blocked.size > 0) events.splice(0, events.length, ...events.filter((event) => event.id === undefined || !blocked.has(event.id)));
	events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

	const tasks: TaskSpan[] = [];
	type OpenTask = { start: string; brain?: string; memory?: string; edit?: string; lastEdit?: string; verify?: string; verifyId?: string };
	let open: OpenTask | undefined;
	const close = (end: string) => {
		if (open?.edit === undefined) return;
		const { brain, memory, edit, lastEdit = edit, verify, verifyId } = open;
		const verified = verify !== undefined && verify >= lastEdit;
		tasks.push({
			start: open.start,
			end,
			brain: brain === undefined ? 'never' : brain < edit ? 'before' : 'after',
			memory: memory !== undefined && memory < edit,
			editAt: edit,
			...(brain === undefined ? {} : { brainAt: brain }),
			...(memory === undefined ? {} : { memoryAt: memory }),
			verified,
			...(verified ? { verifiedAt: verify, check: results.get(verifyId ?? '') ?? 'unknown' } : {})
		});
		open = undefined;
	};
	for (const { timestamp, kind, id } of events) {
		if (kind === 'prompt') {
			close(timestamp);
			open ??= { start: timestamp };
			continue;
		}
		open ??= { start: timestamp };
		if (kind === 'verify') Object.assign(open, { verify: timestamp, verifyId: id });
		else open[kind] ??= timestamp;
		if (kind === 'edit') open.lastEdit = timestamp;
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
