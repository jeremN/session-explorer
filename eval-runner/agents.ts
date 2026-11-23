// Agent adapters: how to start each agent CLI, and how to read what it printed. Claude Code writes its own transcript.
// Codex and opencode print JSON events: the adapter turns them into entries in the Claude Code transcript format, so the
// session-explorer pipeline scores every agent the same way.
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { costOf, modelKey } from '../session-explorer/price.ts';
import type { Rate } from '../session-explorer/price.ts';
import { AGENT_ENV, buildCommand } from './command.ts';
import type { Context, GeneratedFile } from './command.ts';
import type { AgentName, Config } from './spec.ts';

export type Invocation = { args: string[]; files: GeneratedFile[]; env: Record<string, string>; input: string };
// What a finished agent process says about the run. `entries` is undefined when the agent writes its own transcript.
export type Outcome = { costUsd: number | null; isError: boolean; budget: boolean; entries?: unknown[]; note?: string };

// The file the agent reads its project instructions from. The `claudeMd` of a config is written under this name.
export const INSTRUCTION_FILE: Record<AgentName, string> = { claude: 'CLAUDE.md', codex: 'AGENTS.md', opencode: 'AGENTS.md' };

const NO_MODEL = { codex: 'codex-default', opencode: 'opencode-default' };

// A private folder for the agent home. The caller removes it after the run.
function privateDir(prefix: string) {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	chmodSync(dir, 0o700);
	return dir;
}

// ---------- Claude Code ----------

export function claudeInvocation(config: Config, context: Context, prompt: string): Invocation {
	const { args, files, env } = buildCommand(config, context);
	return { args, files, env, input: prompt };
}

export function claudeOutcome(stdout: string): Outcome {
	let result: { is_error?: boolean; subtype?: string; total_cost_usd?: number } | undefined;
	try {
		result = JSON.parse(stdout);
	} catch {
		// A killed process prints no result.
	}
	const costUsd = typeof result?.total_cost_usd === 'number' ? result.total_cost_usd : null;
	return { costUsd, isError: Boolean(result?.is_error), budget: Boolean(result?.is_error && /budget/.test(result.subtype ?? '')) };
}

// ---------- Codex ----------

// The user config, rules and AGENTS.md of ~/.codex would leak into every run. The agent gets a new CODEX_HOME that
// holds only the login.
export function codexHome(source = process.env.CODEX_HOME ?? join(homedir(), '.codex')) {
	const home = privateDir('eval-runner-codex-');
	if (existsSync(join(source, 'auth.json'))) copyFileSync(join(source, 'auth.json'), join(home, 'auth.json'));
	return home;
}

// `workspace-write`: the shell writes only in the clone, with no network. The prompt goes on stdin (`-`): Codex reads
// stdin to its end, so the runner must close it.
// In a container, the container is the boundary: `danger-full-access` (see container.ts).
export function codexInvocation(config: Config, home: string, prompt: string, sandbox: 'workspace-write' | 'danger-full-access' = 'workspace-write'): Invocation {
	const args = ['exec', '--json', '--sandbox', sandbox, '--ephemeral', '--ignore-rules', '--skip-git-repo-check'];
	if (config.model) args.push('--model', config.model);
	// A -c value is TOML: the level goes in quotes.
	if (config.effort) args.push('-c', `model_reasoning_effort="${config.effort}"`);
	args.push('-');
	return { args, files: [], env: { ...AGENT_ENV, CODEX_HOME: home }, input: prompt };
}

type Line = Record<string, any>;
const jsonLines = (stdout: string): Line[] =>
	stdout.split('\n').flatMap((line) => {
		try {
			const value = JSON.parse(line);
			return typeof value === 'object' && value !== null ? [value] : [];
		} catch {
			return [];
		}
	});

// Codex runs each command as `/bin/zsh -lc '<command>'`. The tracer classifies the command inside.
export function unwrapShell(command: string) {
	const match = /^\S*\b(?:ba|z)?sh -lc (['"])([\s\S]*)\1$/.exec(command);
	if (!match) return command;
	return match[1] === "'" ? match[2].replace(/'\\''/g, "'") : match[2].replace(/\\(["\\$`])/g, '$1');
}

// One call becomes an assistant row with the tool_use block and a user row with its tool_result.
function call(rows: unknown[], at: () => string, id: string, name: string, input: Record<string, unknown>, failed: boolean, output: string) {
	const t = at();
	rows.push({ type: 'assistant', timestamp: t, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
	rows.push({ type: 'user', timestamp: t, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: failed, content: output.slice(-2000) }] } });
}

function clock(start: number) {
	let tick = 0;
	return (ms?: number) => new Date(ms ?? start + 100 * tick++).toISOString();
}

export function codexOutcome(stdout: string, { model, prompt, start, price }: { model?: string; prompt: string; start: number; price?: Rate }): Outcome {
	const at = clock(start);
	const name = model ?? NO_MODEL.codex;
	const rows: unknown[] = [{ type: 'user', timestamp: at(), message: { role: 'user', content: prompt } }];
	let costUsd: number | null = null;
	let failure: string | undefined;
	let completed = false;
	let request = 0;
	for (const event of jsonLines(stdout)) {
		const item = event.item ?? {};
		if (event.type === 'item.completed' && item.type === 'command_execution') {
			call(rows, at, String(item.id), 'Bash', { command: unwrapShell(String(item.command ?? '')) }, item.exit_code !== 0, String(item.aggregated_output ?? ''));
		} else if (event.type === 'item.completed' && item.type === 'file_change') {
			for (const [index, change] of (Array.isArray(item.changes) ? item.changes : []).entries()) {
				call(rows, at, `${item.id}-${index}`, change.kind === 'add' ? 'Write' : 'Edit', { file_path: String(change.path ?? '') }, item.status === 'failed', '');
			}
		} else if (event.type === 'item.completed' && item.type === 'agent_message') {
			rows.push({ type: 'assistant', timestamp: at(), message: { role: 'assistant', content: [{ type: 'text', text: String(item.text ?? '') }] } });
		} else if (event.type === 'turn.completed') {
			completed = true;
			const usage = event.usage ?? {};
			const cached = Number(usage.cached_input_tokens ?? 0);
			const tokens = { input_tokens: Math.max(0, Number(usage.input_tokens ?? 0) - cached), cache_read_input_tokens: cached, output_tokens: Number(usage.output_tokens ?? 0) };
			rows.push({ type: 'assistant', timestamp: at(), message: { id: `codex-turn-${++request}`, role: 'assistant', model: name, usage: tokens, content: [] } });
			const rates = price ? { [modelKey(name)]: price } : {};
			const cost = costOf(name, { fresh: tokens.input_tokens, cw5m: 0, cw1h: 0, cr: cached, out: tokens.output_tokens }, rates);
			if (cost !== null) costUsd = (costUsd ?? 0) + cost;
		} else if (event.type === 'turn.failed' || event.type === 'error') {
			failure = String(event.error?.message ?? event.message ?? event.type);
		}
	}
	const note = failure ?? (completed ? undefined : 'codex printed no turn.completed event');
	const unpriced = completed && costUsd === null ? `no price for model ${name}: set price in the config` : undefined;
	return { costUsd, isError: Boolean(failure) || !completed, budget: false, entries: rows, note: [note, unpriced].filter(Boolean).join('; ') || undefined };
}

// ---------- opencode ----------

// opencode has no sandbox. It works in $PWD, not in the cwd of its process: without `--dir`, an inherited PWD sends it
// into the source repository. The empty XDG_CONFIG_HOME keeps the user config (MCP servers, plugins) out, and
// OPENCODE_DISABLE_CLAUDE_CODE keeps out ~/.claude/CLAUDE.md and the Claude Code skills, which opencode reads by default.
// In a container, the home is empty already: no XDG_CONFIG_HOME (`configHome` undefined).
// The major version in the output of `opencode --version` ("1.19.6", "opencode v2.3.2"). 1 when it cannot be read.
export function opencodeMajor(version: string | undefined) {
	const match = /(\d+)\.\d+/.exec(version ?? '');
	return match ? Number(match[1]) : 1;
}

// opencode 1 works in the folder of --dir, and --pure loads no external plugin. opencode 2 has neither option: it works
// in its cwd (the runner sets it, and PWD, to the clone), and the private config folder holds no plugin. Without
// --standalone, opencode 2 sends the run to a shared background service that another config folder may have started.
export function opencodeInvocation(config: Config, configHome: string | undefined, prompt: string, dir: string, version?: string): Invocation {
	const args = opencodeMajor(version) >= 2 ? ['--standalone', 'run', '--format', 'json', '--auto'] : ['run', '--format', 'json', '--auto', '--pure', '--dir', dir];
	if (config.model) args.push('--model', config.model);
	args.push('--', prompt);
	return { args, files: [], env: { ...AGENT_ENV, ...(configHome ? { XDG_CONFIG_HOME: configHome } : {}), OPENCODE_DISABLE_CLAUDE_CODE: '1' }, input: '' };
}

export function opencodeConfigHome() {
	const home = privateDir('eval-runner-opencode-');
	mkdirSync(join(home, 'opencode'));
	return home;
}

// The tools of opencode, under the names the tracer knows. A file path goes in `file_path`, as in Claude Code.
const OPENCODE_TOOLS: Record<string, string> = { bash: 'Bash', write: 'Write', edit: 'Edit', patch: 'Edit', multiedit: 'Edit', read: 'Read', grep: 'Grep', glob: 'Glob', list: 'LS', webfetch: 'WebFetch', todowrite: 'TodoWrite', task: 'Task' };

export function opencodeOutcome(stdout: string, { model, prompt, start }: { model?: string; prompt: string; start: number }): Outcome {
	const at = clock(start);
	const name = model ?? NO_MODEL.opencode;
	const rows: unknown[] = [{ type: 'user', timestamp: at(), message: { role: 'user', content: prompt } }];
	let costUsd: number | null = null;
	let billed = 0;
	let failure: string | undefined;
	let finished = false;
	for (const event of jsonLines(stdout)) {
		const part = event.part ?? {};
		const t = () => at(typeof event.timestamp === 'number' ? event.timestamp : undefined);
		if (event.type === 'tool_use') {
			const state = part.state ?? {};
			const input = { ...(state.input ?? {}) };
			// opencode 1 names the file `filePath`, opencode 2 names it `path`.
			const file = input.filePath ?? input.path;
			if (typeof file === 'string') input.file_path = file;
			const tool = String(part.tool ?? 'unknown');
			const exit = state.metadata?.exit;
			const failed = state.status === 'error' || (typeof exit === 'number' && exit !== 0);
			call(rows, t, String(part.callID ?? part.id), OPENCODE_TOOLS[tool] ?? tool, input, failed, String(state.output ?? state.error ?? ''));
		} else if (event.type === 'text') {
			rows.push({ type: 'assistant', timestamp: t(), message: { role: 'assistant', content: [{ type: 'text', text: String(part.text ?? '') }] } });
		} else if (event.type === 'step_finish') {
			const tokens = part.tokens ?? {};
			const usage = { input_tokens: Number(tokens.input ?? 0), cache_read_input_tokens: Number(tokens.cache?.read ?? 0), cache_creation_input_tokens: Number(tokens.cache?.write ?? 0), output_tokens: Number(tokens.output ?? 0) + Number(tokens.reasoning ?? 0) };
			rows.push({ type: 'assistant', timestamp: t(), message: { id: String(part.id), role: 'assistant', model: name, usage, content: [] } });
			billed += usage.input_tokens + usage.output_tokens;
			if (typeof part.cost === 'number' && Number.isFinite(part.cost)) costUsd = (costUsd ?? 0) + part.cost;
			if (part.reason === 'stop') finished = true;
		} else if (event.type === 'error') {
			failure = String(event.error?.data?.message ?? event.error?.message ?? event.error?.name ?? 'error');
		}
	}
	// opencode 2 reports a cost of 0 for an opencode-go model, though the steps bill tokens: the cost is unknown, not 0.
	const unpriced = costUsd === 0 && billed > 0;
	const note = failure ?? (finished ? (unpriced ? 'opencode reported a cost of 0 for billed tokens: the cost is unknown' : undefined) : 'opencode never finished a step with reason stop');
	return { costUsd: unpriced ? null : costUsd, isError: Boolean(failure) || !finished, budget: false, entries: rows, note };
}
