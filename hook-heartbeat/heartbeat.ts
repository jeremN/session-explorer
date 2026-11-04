// Hook heartbeat: for each hook configured in Claude Code, when did it last fire, and does it look dead?
// Usage: node heartbeat.ts [--days 14] [--baseline-days 60] [--project <dir>]... [--projects <regex>] [--json]
//
// Claude Code writes these transcript rows for hooks (observed in version 2.1):
// - `attachment` rows, `attachment.type` one of:
//   `hook_success` (hookName, hookEvent, command, stdout, stderr, exitCode, durationMs), written only when the hook printed
//   something on stdout or stderr; `hook_cancelled` (command, timedOut, timeoutMs); `hook_non_blocking_error` (command,
//   stderr, exitCode); `async_hook_response` (command and pluginId since mid-October 2026, before often empty; exitCode);
//   `hook_additional_context`, `hook_system_message` and `hook_blocking_error`, which name no command.
//   `command` holds the status message instead of the command when the hook sets one. `hookName` is `Event:matched`,
//   for example `PostToolUse:Edit` or `SessionStart:startup`, or the bare event.
// - `system` rows with `subtype: 'stop_hook_summary'`: `hookInfos` lists the command of every Stop hook that ran, quiet
//   or not, with its duration. A timed-out Stop hook is listed too, so its `hook_cancelled` row is not counted twice.
// A quiet hook leaves no trace outside the stop summary. So "silent" compares the window with the trace rate of the
// same hook before the window.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { isUserPrompt, listJsonl, loadConfig } from '../context-tracer/tracer.ts';

export type Hook = {
	source: string;
	event: string;
	matcher: string;
	command: string;
	statusMessage?: string;
	async: boolean;
	timeoutSec?: number;
	condition?: string;
	plugin?: string;
	project?: string;
};
// `async` is undefined for a stop summary line: the summary lists sync and async Stop hooks alike.
export type Trace = { t: string; cwd: string; event: string; name: string; command?: string; plugin?: string; async?: boolean; error?: string; durationMs?: number };
export type Occurrence = { t: string; cwd: string; event: string; name: string };
export type Verdict = 'alive' | 'silent' | 'erroring' | 'unknown';
type Fire = { t: string; error?: string; shared?: boolean };
type Period = { traces: Trace[]; occurrences: Occurrence[] };

// The thresholds are choices, not measured optimums.
// With 5 traces expected, a live hook leaves none with a probability under 1 % (Poisson).
const MIN_EXPECTED = 5;
const RECENT_FIRES = 3;
// The hooks of one session start fire together. A new trace after this pause is a new session start.
const SESSION_START_GAP_MS = 60_000;
const ERROR_LIMIT = 120;
const COMMAND_LIMIT = 70;
// Events whose occurrences the transcript shows. Any other event has no denominator.
const COUNTED = new Set(['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart', 'PreCompact']);

const text = (value: unknown) => (typeof value === 'string' ? value : '');
const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
const isRecord = (value: unknown): value is Record<string, any> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function hooksFrom(settings: unknown, source: string, scope: { plugin?: string; project?: string } = {}): Hook[] {
	const events = isRecord(settings) && isRecord(settings.hooks) ? settings.hooks : {};
	const hooks: Hook[] = [];
	for (const [event, groups] of Object.entries(events)) {
		if (!Array.isArray(groups)) continue;
		for (const group of groups) {
			for (const entry of Array.isArray(group?.hooks) ? group.hooks : []) {
				const args = Array.isArray(entry?.args) ? entry.args.filter((arg: unknown) => typeof arg === 'string') : [];
				const command = [text(entry?.command) || text(entry?.prompt) || text(entry?.url), ...args].join(' ');
				if (!command.trim()) continue;
				hooks.push({
					source,
					event,
					matcher: text(group.matcher),
					command,
					...(text(entry.statusMessage) ? { statusMessage: entry.statusMessage } : {}),
					async: entry.async === true || entry.asyncRewake === true,
					...(typeof entry.timeout === 'number' ? { timeoutSec: entry.timeout } : {}),
					...(text(entry.if) ? { condition: entry.if } : {}),
					...(scope.plugin ? { plugin: scope.plugin } : {}),
					...(scope.project ? { project: scope.project } : {})
				});
			}
		}
	}
	return hooks;
}

// `installed` is `~/.claude/plugins/installed_plugins.json`. A plugin installed for a project counts only for a project
// given on the command line, enabled in that project's settings or in the user's.
export function pluginHookSources(installed: unknown, enabled: Record<string, boolean>, projectEnabled: Record<string, Record<string, boolean>>) {
	const plugins = isRecord(installed) && isRecord(installed.plugins) ? installed.plugins : {};
	const sources: Array<{ plugin: string; installPath: string; project?: string }> = [];
	for (const [plugin, installs] of Object.entries(plugins)) {
		if (!Array.isArray(installs)) continue;
		const latest = new Map<string, Record<string, any>>();
		for (const install of installs) {
			const project = install?.scope === 'user' ? '' : text(install?.projectPath);
			const on = project === '' ? enabled[plugin] : project in projectEnabled && (projectEnabled[project][plugin] ?? enabled[plugin]);
			if (on !== true || !text(install.installPath)) continue;
			const known = latest.get(project);
			if (!known || text(install.lastUpdated) > text(known.lastUpdated)) latest.set(project, install);
		}
		for (const [project, install] of latest) sources.push({ plugin, installPath: install.installPath, ...(project ? { project } : {}) });
	}
	return sources;
}

function firstLine(value: string) {
	return clip(value.split('\n').find((line) => line.trim())?.trim() ?? '', ERROR_LIMIT);
}

export function tracesOf(entry: unknown): Trace[] {
	if (!isRecord(entry) || !text(entry.timestamp)) return [];
	const base = { t: entry.timestamp as string, cwd: text(entry.cwd) };
	if (entry.subtype === 'stop_hook_summary') {
		const infos = Array.isArray(entry.hookInfos) ? entry.hookInfos : [];
		return infos
			.filter((info) => text(info?.command))
			.map((info) => ({ ...base, event: 'Stop', name: 'Stop', command: info.command, durationMs: typeof info.durationMs === 'number' ? info.durationMs : undefined }));
	}
	const hook = entry.type === 'attachment' ? entry.attachment : undefined;
	if (!isRecord(hook) || !text(hook.hookEvent) || !/^(?:hook_|async_hook_)/.test(text(hook.type))) return [];
	if (hook.type === 'hook_cancelled' && hook.hookEvent === 'Stop') return [];
	let error: string | undefined;
	if (hook.type === 'hook_cancelled' && hook.timedOut === true) error = `timed out after ${Math.round(Number(hook.timeoutMs) / 1000)} s`;
	else if (hook.type === 'hook_non_blocking_error') error = firstLine(text(hook.stderr)) || `exit code ${hook.exitCode}`;
	// Exit code 2 is a hook that blocks on purpose: the gate works.
	else if (typeof hook.exitCode === 'number' && hook.exitCode !== 0 && hook.exitCode !== 2) error = `exit code ${hook.exitCode}`;
	return [
		{
			...base,
			event: hook.hookEvent,
			name: text(hook.hookName) || hook.hookEvent,
			...(text(hook.command) ? { command: hook.command } : {}),
			...(text(hook.pluginId) ? { plugin: hook.pluginId } : {}),
			async: hook.type === 'async_hook_response',
			...(error ? { error } : {}),
			...(typeof hook.durationMs === 'number' ? { durationMs: hook.durationMs } : {})
		}
	];
}

// `entries` holds the rows of one session and of its subagents. Hooks run in subagents too.
export function occurrencesOf(entries: unknown[]): Occurrence[] {
	const found: Occurrence[] = [];
	const toolById = new Map<string, string>();
	const lastStart = new Map<string, number>();
	for (const entry of entries) {
		if (!isRecord(entry) || !text(entry.timestamp)) continue;
		const add = (name: string) => found.push({ t: entry.timestamp, cwd: text(entry.cwd), event: name.split(':')[0], name });
		if (isUserPrompt(entry)) add('UserPromptSubmit');
		else if (entry.subtype === 'stop_hook_summary') add('Stop');
		else if (entry.subtype === 'compact_boundary') add(`PreCompact:${text(entry.compactMetadata?.trigger) || 'auto'}`);
		for (const trace of tracesOf(entry)) {
			if (trace.event !== 'SessionStart') continue;
			const time = Date.parse(trace.t);
			const last = lastStart.get(trace.name);
			lastStart.set(trace.name, time);
			if (last === undefined || Math.abs(time - last) > SESSION_START_GAP_MS) add(trace.name);
		}
		const content = entry.message?.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (block?.type === 'tool_use') {
				toolById.set(text(block.id), text(block.name));
				add(`PreToolUse:${text(block.name)}`);
			} else if (block?.type === 'tool_result' && !block.is_error) {
				const tool = toolById.get(text(block.tool_use_id));
				if (tool) add(`PostToolUse:${tool}`);
			}
		}
	}
	return found;
}

// Claude Code matchers: empty or `*` matches all, anything else is a regular expression on the whole name.
function matcherAccepts(matcher: string, name: string) {
	const index = name.indexOf(':');
	if (index === -1 || matcher === '' || matcher === '*') return true;
	const target = name.slice(index + 1);
	try {
		return new RegExp(`^(?:${matcher})$`).test(target);
	} catch {
		return matcher === target;
	}
}

const covers = (hook: Hook, event: { event: string; name: string; cwd: string }) =>
	hook.event === event.event &&
	matcherAccepts(hook.matcher, event.name) &&
	(hook.project === undefined || event.cwd === hook.project || event.cwd.startsWith(`${hook.project}/`));

function candidates(hooks: Hook[], trace: Trace) {
	return hooks.filter(
		(hook) =>
			covers(hook, trace) &&
			(trace.async === undefined || trace.async === hook.async) &&
			(trace.plugin === undefined || hook.plugin === trace.plugin) &&
			(trace.command === undefined || hook.command === trace.command || hook.statusMessage === trace.command)
	);
}

// `fires` is in time order. A shared fire is an anonymous trace this hook may have left.
export function verdictOf({ fires, shared, occurrences, expected }: { fires: Fire[]; shared: number; occurrences: number | null; expected: number | null }): { verdict: Verdict; reason: string } {
	if (fires.some((fire) => !fire.shared)) {
		const recent = fires.slice(-RECENT_FIRES);
		return recent.every((fire) => fire.error !== undefined)
			? { verdict: 'erroring', reason: `the last ${recent.length} traces are errors` }
			: { verdict: 'alive', reason: '' };
	}
	if (shared > 0) return { verdict: 'unknown', reason: `${shared} anonymous traces may come from this hook` };
	if (occurrences === null) return { verdict: 'unknown', reason: 'no event count for this hook' };
	if (occurrences === 0) return { verdict: 'unknown', reason: 'the event did not occur' };
	if (expected === null) return { verdict: 'unknown', reason: 'no trace before the window: a quiet hook, or dead from the start' };
	if (expected < MIN_EXPECTED) return { verdict: 'unknown', reason: `${expected} traces expected, too few to tell` };
	return { verdict: 'silent', reason: `no trace in ${occurrences} events, ${expected} expected` };
}

function attribute(hooks: Hook[], traces: Trace[]) {
	const fires = new Map<Hook, Fire[]>(hooks.map((hook) => [hook, []]));
	const unattributed: Record<string, number> = {};
	for (const trace of [...traces].sort((a, b) => a.t.localeCompare(b.t))) {
		const owners = candidates(hooks, trace);
		const shared = trace.command === undefined && owners.length !== 1;
		if (shared) unattributed[trace.event] = (unattributed[trace.event] ?? 0) + 1;
		for (const hook of owners) {
			const timedOut = hook.timeoutSec !== undefined && (trace.durationMs ?? 0) >= hook.timeoutSec * 1000;
			const error = trace.error ?? (timedOut ? `timed out after ${hook.timeoutSec} s` : undefined);
			fires.get(hook)!.push({ t: trace.t, ...(error ? { error } : {}), ...(shared ? { shared } : {}) });
		}
	}
	return { fires, unattributed };
}

export function heartbeat(hooks: Hook[], window: Period, baseline: Period) {
	const now = attribute(hooks, window.traces);
	const before = attribute(hooks, baseline.traces);
	const rows = hooks.map((hook) => {
		const fires = now.fires.get(hook)!;
		const own = fires.filter((fire) => !fire.shared);
		const errors = own.filter((fire) => fire.error !== undefined);
		// An `if` condition (for example `Bash(git*commit*)`) runs the hook on a part of the matched calls only.
		const occurrences = COUNTED.has(hook.event) && hook.condition === undefined ? window.occurrences.filter((occurrence) => covers(hook, occurrence)).length : null;
		const pastFires = before.fires.get(hook)!.filter((fire) => !fire.shared).length;
		const pastOccurrences = baseline.occurrences.filter((occurrence) => covers(hook, occurrence)).length;
		// The stop summary lists every Stop hook that ran, so a Stop hook leaves one trace per Stop.
		const rate = hook.event === 'Stop' ? 1 : pastFires > 0 && pastOccurrences > 0 ? Math.min(1, pastFires / pastOccurrences) : null;
		const expected = occurrences === null || rate === null ? null : Math.round(rate * occurrences * 10) / 10;
		return {
			source: hook.source,
			...(hook.plugin ? { plugin: hook.plugin } : {}),
			event: hook.event,
			matcher: hook.matcher,
			...(hook.condition ? { condition: hook.condition } : {}),
			command: hook.command,
			fires: own.length,
			errors: errors.length,
			shared: fires.length - own.length,
			lastFire: own.at(-1)?.t ?? null,
			lastError: errors.at(-1)?.error ?? null,
			occurrences,
			expected,
			...verdictOf({ fires, shared: fires.length - own.length, occurrences, expected })
		};
	});
	return { hooks: rows, unattributed: now.unattributed };
}

export function shorten(command: string, home: string) {
	return clip(command.replaceAll(home, '~').replaceAll('${CLAUDE_PLUGIN_ROOT}', '<plugin>').replace(/\s+/g, ' ').trim(), COMMAND_LIMIT);
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		return undefined;
	}
}

// A plugin declares its hooks in `hooks/hooks.json`, or under `hooks` in `.claude-plugin/plugin.json`: inline, or a path.
function pluginHooks(source: { plugin: string; installPath: string; project?: string }): Hook[] {
	const scope = { plugin: source.plugin, ...(source.project ? { project: source.project } : {}) };
	const manifest = readJson(join(source.installPath, '.claude-plugin', 'plugin.json'));
	const declared = isRecord(manifest) ? manifest.hooks : undefined;
	const files = [join(source.installPath, 'hooks', 'hooks.json'), ...(typeof declared === 'string' ? [join(source.installPath, declared)] : [])];
	const hooks = [...new Set(files)].flatMap((file) => hooksFrom(readJson(file), 'plugin', scope));
	return isRecord(declared) ? [...hooks, ...hooksFrom({ hooks: declared }, 'plugin', scope)] : hooks;
}

// Most rows are model text. Parse only the rows that can hold a hook trace or an event.
const RELEVANT = /hook|"tool_use"|"tool_result"|compact_boundary|"type":"user"/;
function readRelevant(file: string): unknown[] {
	const entries: unknown[] = [];
	for (const line of readFileSync(file, 'utf8').split('\n')) {
		if (!line || !RELEVANT.test(line)) continue;
		try {
			entries.push(JSON.parse(line));
		} catch {
			// A session that is still being written can end on a partial line.
		}
	}
	return entries;
}

function main() {
	const argument = (flag: string) => {
		const index = process.argv.indexOf(flag);
		return index === -1 ? undefined : process.argv[index + 1];
	};
	const days = Number(argument('--days') ?? 14);
	const baselineDays = Number(argument('--baseline-days') ?? 60);
	const config = loadConfig() as ReturnType<typeof loadConfig> & { heartbeat?: { projects?: string[] } };
	const projects = new RegExp(argument('--projects') ?? config.projects ?? '.');
	const projectDirs = [
		...new Set([...process.argv.flatMap((flag, index) => (flag === '--project' ? [process.argv[index + 1]] : [])), ...(config.heartbeat?.projects ?? [])])
	].map((dir) => dir.replace(/\/+$/, ''));
	const home = homedir();
	const claude = join(home, '.claude');

	const settings = (path: string) => readJson(path);
	const user = settings(join(claude, 'settings.json'));
	const hooks = [...hooksFrom(user, 'user'), ...hooksFrom(settings(join(claude, 'settings.local.json')), 'user-local')];
	const projectEnabled: Record<string, Record<string, boolean>> = {};
	for (const dir of projectDirs) {
		const shared = settings(join(dir, '.claude', 'settings.json'));
		const local = settings(join(dir, '.claude', 'settings.local.json'));
		hooks.push(...hooksFrom(shared, 'project', { project: dir }), ...hooksFrom(local, 'project-local', { project: dir }));
		projectEnabled[dir] = { ...(isRecord(shared) ? shared.enabledPlugins : {}), ...(isRecord(local) ? local.enabledPlugins : {}) };
	}
	const enabled = { ...(isRecord(user) ? user.enabledPlugins : {}) };
	for (const source of pluginHookSources(readJson(join(claude, 'plugins', 'installed_plugins.json')), enabled, projectEnabled)) hooks.push(...pluginHooks(source));

	const nowMs = Date.now();
	const cutoff = new Date(nowMs - days * 86_400_000).toISOString();
	const baselineStartMs = nowMs - (days + baselineDays) * 86_400_000;
	const baselineStart = new Date(baselineStartMs).toISOString();
	const window: Period = { traces: [], occurrences: [] };
	const baseline: Period = { traces: [], occurrences: [] };
	const root = join(claude, 'projects');
	for (const project of readdirSync(root).filter((name) => projects.test(name))) {
		for (const file of listJsonl(join(root, project))) {
			const subagents = listJsonl(join(file.slice(0, -'.jsonl'.length), 'subagents'));
			if (Math.max(...[file, ...subagents].map((path) => statSync(path).mtimeMs)) < baselineStartMs) continue;
			const entries = [file, ...subagents].flatMap(readRelevant);
			const period = (t: string) => (t >= cutoff ? window : t >= baselineStart ? baseline : undefined);
			for (const trace of entries.flatMap(tracesOf)) period(trace.t)?.traces.push(trace);
			for (const occurrence of occurrencesOf(entries)) period(occurrence.t)?.occurrences.push(occurrence);
		}
	}

	const result = heartbeat(hooks, window, baseline);
	const rows = result.hooks
		.map((row) => ({ ...row, command: shorten(row.command, home) }))
		.sort((a, b) => `${a.source} ${a.event} ${a.matcher} ${a.command}`.localeCompare(`${b.source} ${b.event} ${b.matcher} ${b.command}`));
	if (process.argv.includes('--json')) {
		const output = { schema: 'harness/v1', tool: 'hook-heartbeat', generatedAt: new Date(nowMs).toISOString(), days, baselineDays, hooks: rows, unattributed: result.unattributed };
		console.log(JSON.stringify(output, null, 2));
		return;
	}
	const order: Verdict[] = ['silent', 'erroring', 'unknown', 'alive'];
	console.log(`Hooks in the last ${days} days. Trace rate taken from the ${baselineDays} days before.`);
	console.table(
		[...rows]
			.sort((a, b) => order.indexOf(a.verdict) - order.indexOf(b.verdict))
			.map((row) => ({
				verdict: row.verdict,
				source: row.plugin ?? row.source,
				event: [row.event, row.matcher, row.condition && `if ${row.condition}`].filter(Boolean).join(' '),
				command: row.command,
				fires: row.fires,
				errors: row.errors,
				events: row.occurrences ?? '?',
				last: row.lastFire?.slice(0, 16).replace('T', ' ') ?? '',
				why: row.lastError && row.verdict !== 'alive' ? row.lastError : row.reason || (row.lastError ? `last error: ${row.lastError}` : '')
			}))
	);
	const anonymous = Object.entries(result.unattributed).map(([event, count]) => `${event} ${count}`);
	if (anonymous.length > 0) console.log(`Traces without a command and with several candidate hooks: ${anonymous.join(', ')}`);
}

if (import.meta.main) main();
